import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Image, Alert, Modal, RefreshControl } from 'react-native';
import { IOSTabHeader } from '../../components/IOSTabHeader';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeBottomTabBarHeight } from '../../hooks/useSafeBottomTabBarHeight';
import { useTranslation } from 'react-i18next';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import ReanimatedSwipeable, { SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { useTheme, type AppTheme } from '../../constants/theme';
import { SkeletonBox } from '../../components/SkeletonBox';
import { formatDate } from '../../utils/formatCurrency';

interface StoreChain {
    id: number;
    name: string;
    logoUrl: string | null;
}

interface Store {
    id: number;
    chainId: number;
    address: string;
}

type Styles = ReturnType<typeof makeStyles>;

interface ShoppingList {
    id: number;
    storeId: number;
    storeName: string;
    address: string;
    chainName: string;
    logoUrl: string | null;
    status: string;
    createdAt: string;
    itemCount: number;
    checkedCount: number;
}

function ShoppingListCard({ item, onDelete, onComplete, onPress, styles, colors }: {
    item: ShoppingList;
    onDelete: (id: number) => void;
    onComplete: (id: number) => void;
    onPress: (id: number) => void;
    styles: Styles;
    colors: AppTheme;
}) {
    const { t } = useTranslation();
    const swipeableRef = useRef<SwipeableMethods>(null);
    const progress = item.itemCount > 0 ? item.checkedCount / item.itemCount : 0;

    /**
     * Swipe semantics:
     *   - swipe left (delete revealed on the right) → immediately delete.
     *     A 3s undo toast in the parent lets the user recover. No modal
     *     alert — the swipe itself is the confirmation.
     *   - swipe right (complete revealed on the left) → immediately
     *     complete. Reversible via "reopen" in the future (detail screen).
     */
    const handleSwipeOpen = (direction: 'left' | 'right') => {
        swipeableRef.current?.close();
        if (direction === 'right') {
            onComplete(item.id);
        } else if (direction === 'left') {
            onDelete(item.id);
        }
    };

    const rightActions = () => (
        <View style={styles.deleteAction}>
            <Ionicons name="trash-outline" size={24} color={colors.textInverse} />
            <Text style={styles.actionText}>{t('shoppingListTab.delete')}</Text>
        </View>
    );

    const leftActions = () => {
        if (item.status === 'completed') return null;
        return (
            <View style={styles.completeAction}>
                <Ionicons name="checkmark-done-outline" size={24} color={colors.textInverse} />
                <Text style={styles.actionText}>{t('shoppingListTab.complete')}</Text>
            </View>
        );
    };

    return (
        <ReanimatedSwipeable
            ref={swipeableRef}
            renderRightActions={rightActions}
            renderLeftActions={leftActions}
            overshootRight={false}
            overshootLeft={false}
            friction={2}
            leftThreshold={40}
            rightThreshold={40}
            onSwipeableOpen={handleSwipeOpen}
        >
            <TouchableOpacity
                style={[
                    styles.card,
                    item.status === 'active' ? styles.cardActive : styles.cardCompleted
                ]}
                onPress={() => onPress(item.id)}
            >
                <View style={styles.cardLeft}>
                    {item.logoUrl ? (
                        <Image source={{ uri: item.logoUrl }} style={styles.logo} resizeMode="contain" />
                    ) : (
                        <View style={styles.logoPlaceholder}>
                            <Text style={styles.logoPlaceholderText}>{item.chainName[0]}</Text>
                        </View>
                    )}
                </View>
                <View style={styles.cardContent}>
                    <Text style={styles.storeName}>{item.address}</Text>
                    <Text style={styles.date}>
                        {formatDate(item.createdAt)}
                    </Text>
                    {item.status === 'active' && item.itemCount > 0 && (
                        <View style={styles.progressRow}>
                            <View style={styles.progressBar}>
                                <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
                            </View>
                            <Text style={styles.progressText}>{item.checkedCount}/{item.itemCount}</Text>
                        </View>
                    )}
                </View>
                <View style={styles.badgeContainer}>
                    <View style={[styles.badge, item.status === 'completed' && styles.badgeCompleted]}>
                        <Text style={[styles.badgeText, item.status === 'completed' && styles.badgeTextCompleted]}>
                            {item.itemCount}
                        </Text>
                    </View>
                </View>
            </TouchableOpacity>
        </ReanimatedSwipeable>
    );
}

export default function ShoppingListScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    // Tab bar is position:absolute on iOS now (liquid-glass), so the
    // FAB needs to sit above it instead of using a static bottom: 24
    // which gets hidden under the bar.
    const tabBarHeight = useSafeBottomTabBarHeight();
    const [lists, setLists] = useState<ShoppingList[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const router = useRouter();

    const fetchLists = async () => {
        try {
            const userId = await getUserId();
            const res = await fetch(`${API_BASE_URL}/api/shopping-lists/user/${userId}`);
            const data = await res.json();
            setLists(Array.isArray(data) ? data : []);
        } catch (error) {
            console.error('Failed to fetch lists:', error);
        } finally {
            setLoading(false);
        }
    };

    useFocusEffect(useCallback(() => {
        fetchLists();
    }, []));

    /**
     * Optimistic-delete with a 3-second undo toast. We immediately hide
     * the row locally AND schedule the DELETE request. If the user taps
     * Atšaukti before the timer fires, we cancel the pending request and
     * restore the row. Removes the alert-storm the old flow had on every
     * swipe.
     */
    const [pendingDelete, setPendingDelete] = useState<{ list: ShoppingList; timer: any } | null>(null);

    const deleteList = (id: number) => {
        const target = lists.find(l => l.id === id);
        if (!target) return;
        setLists(prev => prev.filter(l => l.id !== id));
        // If there's already a pending delete, finalize it immediately —
        // user queued a second delete, shouldn't chain-restore.
        if (pendingDelete) {
            clearTimeout(pendingDelete.timer);
            fetch(`${API_BASE_URL}/api/shopping-lists/${pendingDelete.list.id}`, { method: 'DELETE' })
                .catch(() => {});
        }
        const timer = setTimeout(() => {
            fetch(`${API_BASE_URL}/api/shopping-lists/${id}`, { method: 'DELETE' })
                .catch(() => {
                    // Resurrect the row on server failure so the user
                    // isn't left with a phantom-gone list.
                    setLists(prev => [target, ...prev]);
                });
            setPendingDelete(null);
        }, 3000);
        setPendingDelete({ list: target, timer });
    };

    const undoDelete = () => {
        if (!pendingDelete) return;
        clearTimeout(pendingDelete.timer);
        setLists(prev => [pendingDelete.list, ...prev].sort((a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        ));
        setPendingDelete(null);
    };

    /**
     * Swipe-complete = user is done. Backend auto-checks every item in
     * the list inside the same status-update transaction (new behaviour
     * after the review), so the progress bar flips to 100% and the
     * basket transitions to `completed`.
     */
    // FAB popup state: closed / showing choice / showing chain picker.
    // Chains are fetched lazily the first time the picker opens — keeps
    // the tab startup path as-is for users who never open it.
    const [fabMenuOpen, setFabMenuOpen] = useState(false);
    const [chainPickerOpen, setChainPickerOpen] = useState(false);
    const [chains, setChains] = useState<StoreChain[] | null>(null);
    const [chainsLoading, setChainsLoading] = useState(false);
    const [creatingChainId, setCreatingChainId] = useState<number | null>(null);

    const openChainPicker = async () => {
        setFabMenuOpen(false);
        setChainPickerOpen(true);
        if (chains) return;
        setChainsLoading(true);
        try {
            const res = await fetch(`${API_BASE_URL}/api/chains`);
            const data = await res.json();
            setChains(Array.isArray(data) ? data : []);
        } catch {
            setChains([]);
        } finally {
            setChainsLoading(false);
        }
    };

    const createStandaloneList = async (chainId: number) => {
        if (creatingChainId) return;
        setCreatingChainId(chainId);
        try {
            // We don't collect a store from the user here — any store in
            // the chain is enough for price/category filtering. Pick the
            // first one returned.
            const storesRes = await fetch(`${API_BASE_URL}/api/stores/chain/${chainId}`);
            const stores: Store[] = await storesRes.json();
            if (!Array.isArray(stores) || stores.length === 0) {
                Alert.alert(t('shoppingListTab.errors.generic'), t('shoppingListTab.errors.noStoreChoices'));
                return;
            }
            const storeId = stores[0].id;
            const userId = await getUserId();
            const res = await fetch(`${API_BASE_URL}/api/shopping-lists`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, storeId }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (typeof data?.id !== 'number') throw new Error('Response missing id');
            setChainPickerOpen(false);
            router.push(`/shopping-list/${data.id}` as any);
        } catch {
            Alert.alert(t('shoppingListTab.errors.generic'), t('shoppingListTab.errors.createList'));
        } finally {
            setCreatingChainId(null);
        }
    };

    const openScanner = () => {
        setFabMenuOpen(false);
        router.push('/shopping-list/scan' as any);
    };

    const completeList = async (id: number) => {
        try {
            await fetch(`${API_BASE_URL}/api/shopping-lists/${id}/status`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'completed' }),
            });
            setLists(prev => prev.map(l =>
                l.id === id
                    ? { ...l, status: 'completed', checkedCount: l.itemCount }
                    : l
            ));
        } catch {
            Alert.alert(t('shoppingListTab.errors.generic'), t('shoppingListTab.errors.completeList'));
        }
    };

    const activeLists = lists.filter(l => l.status === 'active');
    const completedLists = lists.filter(l => l.status === 'completed');

    if (loading) return (
        <View style={styles.container}>
            <IOSTabHeader title={t('tabs.shoppingList')} />
            <View style={{ padding: 16, gap: 12 }}>
            {Array.from({ length: 5 }).map((_, i) => (
                <View key={i} style={{ backgroundColor: colors.cardBackground, borderRadius: 12, padding: 16, gap: 10, borderLeftWidth: 3, borderLeftColor: colors.borderSubtle }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <SkeletonBox width={32} height={32} borderRadius={16} />
                        <View style={{ gap: 6, flex: 1 }}>
                            <SkeletonBox width={140} height={13} borderRadius={6} />
                            <SkeletonBox width={200} height={11} borderRadius={5} />
                        </View>
                        <SkeletonBox width={50} height={20} borderRadius={6} />
                    </View>
                    <SkeletonBox height={6} borderRadius={3} />
                </View>
            ))}
            </View>
        </View>
    );

    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            <View style={styles.container}>
                <IOSTabHeader title={t('tabs.shoppingList')} />
                {pendingDelete && (
                    <TouchableOpacity
                        style={styles.undoToast}
                        onPress={undoDelete}
                        activeOpacity={0.85}
                    >
                        <Ionicons name="arrow-undo" size={14} color={colors.onPrimary} />
                        <Text style={styles.undoToastText}>
                            {t('shoppingListTab.deletedUndo')}
                        </Text>
                    </TouchableOpacity>
                )}
                <FlatList
                    data={[]}
                    keyExtractor={() => ''}
                    renderItem={null}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={async () => { setRefreshing(true); await fetchLists(); setRefreshing(false); }}
                            colors={[colors.primary]}
                            tintColor={colors.primary}
                        />
                    }
                    ListHeaderComponent={
                        <>
                            {activeLists.length > 0 && (
                                <>
                                    <Text style={styles.sectionTitle}>{t('shoppingListTab.sectionActive')}</Text>
                                    {activeLists.map(item => (
                                        <ShoppingListCard
                                            key={item.id}
                                            item={item}
                                            onDelete={deleteList}
                                            onComplete={completeList}
                                            onPress={(id) => router.push(`/shopping-list/${id}` as any)}
                                            styles={styles}
                                            colors={colors}
                                        />
                                    ))}
                                </>
                            )}
                            {completedLists.length > 0 && (
                                <>
                                    <Text style={styles.sectionTitle}>{t('shoppingListTab.sectionCompleted')}</Text>
                                    {completedLists.map(item => (
                                        <ShoppingListCard
                                            key={item.id}
                                            item={item}
                                            onDelete={deleteList}
                                            onComplete={completeList}
                                            onPress={(id) => router.push(`/shopping-list/${id}` as any)}
                                            styles={styles}
                                            colors={colors}
                                        />
                                    ))}
                                </>
                            )}
                            {lists.length === 0 && (
                                <View style={styles.centered}>
                                    <Ionicons name="list-outline" size={56} color={colors.textMuted} />
                                    <Text style={styles.emptyText}>{t('shoppingListTab.empty')}</Text>
                                    <Text style={styles.emptySubText}>{t('shoppingListTab.emptyBody')}</Text>
                                    <TouchableOpacity style={styles.emptyButton} onPress={() => router.navigate('/(tabs)/basket' as any)}>
                                        <Text style={styles.emptyButtonText}>{t('shoppingListTab.emptyCta')}</Text>
                                    </TouchableOpacity>
                                </View>
                            )}
                        </>
                    }
                    contentContainerStyle={styles.list}
                />

                <TouchableOpacity
                    style={[styles.fab, { bottom: tabBarHeight + 16 }]}
                    onPress={() => setFabMenuOpen(true)}
                    activeOpacity={0.85}
                >
                    <Ionicons name="add" size={28} color={colors.onPrimary} />
                </TouchableOpacity>

                <Modal
                    visible={fabMenuOpen}
                    transparent
                    animationType="fade"
                    onRequestClose={() => setFabMenuOpen(false)}
                >
                    <TouchableOpacity
                        style={styles.modalBackdrop}
                        activeOpacity={1}
                        onPress={() => setFabMenuOpen(false)}
                    >
                        <View style={styles.fabMenu}>
                            <TouchableOpacity style={styles.fabMenuItem} onPress={openScanner}>
                                <Ionicons name="qr-code-outline" size={22} color={colors.textPrimary} />
                                <Text style={styles.fabMenuItemText}>{t('shoppingListTab.fabScanQr')}</Text>
                            </TouchableOpacity>
                            <View style={styles.fabMenuDivider} />
                            <TouchableOpacity style={styles.fabMenuItem} onPress={openChainPicker}>
                                <Ionicons name="add-circle-outline" size={22} color={colors.textPrimary} />
                                <Text style={styles.fabMenuItemText}>{t('shoppingListTab.fabCreate')}</Text>
                            </TouchableOpacity>
                        </View>
                    </TouchableOpacity>
                </Modal>

                <Modal
                    visible={chainPickerOpen}
                    transparent
                    animationType="slide"
                    onRequestClose={() => setChainPickerOpen(false)}
                >
                    <TouchableOpacity
                        style={styles.modalBackdrop}
                        activeOpacity={1}
                        onPress={() => !creatingChainId && setChainPickerOpen(false)}
                    >
                        <View style={styles.chainPickerSheet}>
                            <Text style={styles.sheetTitle}>{t('shoppingListTab.pickStoreTitle')}</Text>
                            {chainsLoading ? (
                                <ActivityIndicator color={colors.primary} style={{ marginVertical: 16 }} />
                            ) : (chains ?? []).length === 0 ? (
                                <Text style={styles.sheetEmpty}>{t('shoppingListTab.noStoresFound')}</Text>
                            ) : (
                                (chains ?? []).map(chain => (
                                    <TouchableOpacity
                                        key={chain.id}
                                        style={styles.chainRow}
                                        onPress={() => createStandaloneList(chain.id)}
                                        disabled={creatingChainId !== null}
                                    >
                                        {chain.logoUrl ? (
                                            <Image source={{ uri: chain.logoUrl }} style={styles.chainLogo} resizeMode="contain" />
                                        ) : (
                                            <View style={styles.chainLogoPlaceholder}>
                                                <Text style={styles.chainLogoPlaceholderText}>{chain.name[0]}</Text>
                                            </View>
                                        )}
                                        <Text style={styles.chainName}>{chain.name}</Text>
                                        {creatingChainId === chain.id && (
                                            <ActivityIndicator size="small" color={colors.primary} />
                                        )}
                                    </TouchableOpacity>
                                ))
                            )}
                        </View>
                    </TouchableOpacity>
                </Modal>
            </View>
        </GestureHandlerRootView>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    list: { padding: 16 },
    sectionTitle: {
        fontSize: 13, fontWeight: '700', color: c.textMuted,
        marginBottom: 8, marginTop: 8, textTransform: 'uppercase',
    },
    card: {
        backgroundColor: c.cardBackground, borderRadius: 12, padding: 14, marginBottom: 10,
        flexDirection: 'row', alignItems: 'center',
        elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08, shadowRadius: 2,
        borderLeftWidth: 4,
    },
    cardLeft: { marginRight: 12 },
    logo: { width: 44, height: 44, borderRadius: 8 },
    logoPlaceholder: {
        width: 44, height: 44, borderRadius: 8,
        backgroundColor: c.border, alignItems: 'center', justifyContent: 'center',
    },
    logoPlaceholderText: { fontSize: 18, fontWeight: '700', color: c.textSecondary },
    cardContent: { flex: 1 },
    storeName: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    date: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    progressRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
    progressBar: { flex: 1, height: 4, backgroundColor: c.border, borderRadius: 2, overflow: 'hidden' },
    progressFill: { height: '100%', backgroundColor: c.primary, borderRadius: 2 },
    progressText: { fontSize: 11, color: c.textSecondary },
    badgeContainer: { marginLeft: 8 },
    badge: {
        backgroundColor: c.primaryMuted, width: 28, height: 28, borderRadius: 14,
        alignItems: 'center', justifyContent: 'center',
    },
    badgeCompleted: { backgroundColor: c.border },
    badgeText: { fontSize: 12, fontWeight: '700', color: c.primary },
    badgeTextCompleted: { color: c.textMuted },
    emptyText: { fontSize: 16, color: c.textSecondary, fontWeight: '600', marginTop: 16, textAlign: 'center' },
    emptySubText: { fontSize: 13, color: c.textMuted, marginTop: 6, textAlign: 'center', lineHeight: 18 },
    emptyButton: { marginTop: 20, backgroundColor: c.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 24 },
    emptyButtonText: { color: c.onPrimary, fontWeight: '700', fontSize: 14 },
    undoToast: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: c.textPrimary,
        marginHorizontal: 16,
        marginTop: 12,
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 10,
        alignSelf: 'center',
    },
    undoToastText: {
        color: c.onPrimary,
        fontSize: 13,
        fontWeight: '600',
    },
    deleteAction: {
        backgroundColor: c.error, justifyContent: 'center', alignItems: 'center',
        width: 80, borderRadius: 12, marginBottom: 10,
        flexDirection: 'column', gap: 4,
    },
    completeAction: {
        backgroundColor: c.success, justifyContent: 'center', alignItems: 'center',
        width: 80, borderRadius: 12, marginBottom: 10,
        flexDirection: 'column', gap: 4,
    },
    actionText: { color: c.textInverse, fontSize: 11, fontWeight: '600' },
    cardActive: {
        borderLeftColor: c.primary,
    },
    cardCompleted: {
        borderLeftColor: c.textMuted,
    },
    fab: {
        position: 'absolute',
        right: 20,
        bottom: 24,
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: c.primary,
        alignItems: 'center',
        justifyContent: 'center',
        elevation: 6,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.25,
        shadowRadius: 5,
    },
    modalBackdrop: {
        flex: 1,
        backgroundColor: c.overlayBackdrop,
        justifyContent: 'flex-end',
    },
    fabMenu: {
        backgroundColor: c.cardBackground,
        marginHorizontal: 16,
        marginBottom: 92,
        borderRadius: 12,
        paddingVertical: 4,
        elevation: 8,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 6,
    },
    fabMenuItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 14,
        paddingHorizontal: 18,
    },
    fabMenuItemText: { fontSize: 15, color: c.textPrimary, fontWeight: '500' },
    fabMenuDivider: { height: 1, backgroundColor: c.borderSubtle, marginHorizontal: 12 },
    chainPickerSheet: {
        backgroundColor: c.cardBackground,
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        paddingHorizontal: 20,
        paddingTop: 20,
        paddingBottom: 32,
    },
    sheetTitle: { fontSize: 16, fontWeight: '700', color: c.textPrimary, marginBottom: 12 },
    sheetEmpty: { fontSize: 14, color: c.textMuted, textAlign: 'center', marginVertical: 16 },
    chainRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 14,
        borderBottomWidth: 1,
        borderBottomColor: c.borderSubtle,
    },
    chainLogo: { width: 36, height: 36, borderRadius: 6 },
    chainLogoPlaceholder: {
        width: 36, height: 36, borderRadius: 6,
        backgroundColor: c.surfaceMuted, alignItems: 'center', justifyContent: 'center',
    },
    chainLogoPlaceholderText: { fontSize: 16, fontWeight: '700', color: c.textSecondary },
    chainName: { flex: 1, fontSize: 15, color: c.textPrimary, fontWeight: '500' },
});