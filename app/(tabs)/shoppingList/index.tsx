import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Image, Alert, Modal, RefreshControl } from 'react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeBottomTabBarHeight } from '../../../hooks/useSafeBottomTabBarHeight';
import { useTranslation } from 'react-i18next';
import { API_BASE_URL } from '../../../config/api';
import { getUserId } from '../../../config/user';
import { useTheme, type AppTheme } from '../../../constants/theme';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { glassHeaderOptions } from '../../../constants/navHeader';
import { ScreenHeading } from '../../../components/ScreenHeading';
import { useCollapsingHeader, CollapsingHeader } from '../../../components/CollapsingHeader';
import { SkeletonBox } from '../../../components/SkeletonBox';
import { formatDate } from '../../../utils/formatCurrency';
import { chainBrandName, getMiniLogoUrl, chainBrandColor } from '../../../utils/chainBrandName';
import { formatStoreStreet } from '../../../utils/formatAddress';
import { StoreChipBar } from '../../../components/StoreChipBar';
import { CardActionBar, type CardAction } from '../../../components/CardActionBar';
import AsyncStorage from '@react-native-async-storage/async-storage';

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

interface SplitGroupEntry {
    storeId: number;
    storeName: string;
    chainName: string;
    chainLogoUrl: string | null;
    listId: number;
}

interface SplitGroup {
    basketId: string;
    entries: SplitGroupEntry[];
    lists: ShoppingList[];
}

// ─── Single-store card ────────────────────────────────────────────────────────

function ShoppingListCard({ item, onPress, onLongPress, selectionMode, selected, styles, colors }: {
    item: ShoppingList;
    onPress: (id: number) => void;
    onLongPress?: () => void;
    selectionMode?: boolean;
    selected?: boolean;
    styles: Styles;
    colors: AppTheme;
}) {
    const progress = item.itemCount > 0 ? item.checkedCount / item.itemCount : 0;

    return (
        <TouchableOpacity
            style={[
                styles.card,
                item.status === 'active' ? styles.cardActive : styles.cardCompleted,
            ]}
            onPress={() => onPress(item.id)}
            onLongPress={onLongPress}
            delayLongPress={350}
            activeOpacity={0.75}
        >
            {selectionMode && (
                <View style={[styles.selectCircle, selected && styles.selectCircleChecked]}>
                    {selected && <Ionicons name="checkmark" size={14} color={colors.onPrimary} />}
                </View>
            )}
            <View style={styles.cardLeft}>
                {item.logoUrl ? (
                    <View style={[styles.logo, { backgroundColor: chainBrandColor(item.chainName) }]}>
                        <Image source={{ uri: getMiniLogoUrl(item.chainName, item.logoUrl) }} style={styles.logoImage} resizeMode="contain" />
                    </View>
                ) : (
                    <View style={[styles.logo, { backgroundColor: chainBrandColor(item.chainName) }]}>
                        <Text style={styles.logoPlaceholderText}>{item.chainName[0]}</Text>
                    </View>
                )}
            </View>
            <View style={styles.cardContent}>
                <Text style={styles.storeName} numberOfLines={1}>{formatStoreStreet(item.address)}</Text>
                <Text style={styles.date}>{formatDate(item.createdAt)}</Text>
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
    );
}

// ─── Multi-store split-basket card ───────────────────────────────────────────

function SplitGroupCard({ group, onPress, onLongPress, selectionMode, selected, styles, colors }: {
    group: SplitGroup;
    onPress: () => void;
    onLongPress?: () => void;
    selectionMode?: boolean;
    selected?: boolean;
    styles: Styles;
    colors: AppTheme;
}) {
    const totalItems = group.lists.reduce((s, l) => s + Number(l.itemCount), 0);
    const checkedItems = group.lists.reduce((s, l) => s + Number(l.checkedCount), 0);
    const progress = totalItems > 0 ? checkedItems / totalItems : 0;
    const isCompleted = group.lists.length > 0 && group.lists.every(l => l.status === 'completed');
    const streets = group.lists.map(l => formatStoreStreet(l.address)).filter(Boolean).join(' · ');
    const date = group.lists[0]?.createdAt;

    return (
        <TouchableOpacity
            style={[styles.card, isCompleted ? styles.cardCompleted : styles.cardActive]}
            onPress={onPress}
            onLongPress={onLongPress}
            delayLongPress={350}
            activeOpacity={0.75}
        >
            {selectionMode && (
                <View style={[styles.selectCircle, selected && styles.selectCircleChecked]}>
                    {selected && <Ionicons name="checkmark" size={14} color={colors.onPrimary} />}
                </View>
            )}
            <View style={styles.cardLeft}>
                <View style={styles.splitLogos}>
                    {group.entries.slice(0, 3).map((entry, idx) =>
                        entry.chainLogoUrl ? (
                            <View
                                key={entry.storeId}
                                style={[styles.splitLogo, { backgroundColor: chainBrandColor(entry.chainName) }, idx > 0 && styles.splitLogoOverlap]}
                            >
                                <Image
                                    source={{ uri: getMiniLogoUrl(entry.chainName, entry.chainLogoUrl) }}
                                    style={styles.splitLogoImage}
                                    resizeMode="contain"
                                />
                            </View>
                        ) : (
                            <View
                                key={entry.storeId}
                                style={[styles.splitLogo, { backgroundColor: chainBrandColor(entry.chainName) }, idx > 0 && styles.splitLogoOverlap]}
                            >
                                <Text style={styles.splitLogoPlaceholderText}>{entry.chainName[0]}</Text>
                            </View>
                        )
                    )}
                </View>
            </View>
            <View style={styles.cardContent}>
                <View style={styles.splitLabelRow}>
                    <Text style={styles.storeName} numberOfLines={1}>{streets}</Text>
                </View>
                {date ? <Text style={styles.date}>{formatDate(date)}</Text> : null}
                {!isCompleted && totalItems > 0 && (
                    <View style={styles.progressRow}>
                        <View style={styles.progressBar}>
                            <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
                        </View>
                        <Text style={styles.progressText}>{checkedItems}/{totalItems}</Text>
                    </View>
                )}
            </View>
            <View style={styles.badgeContainer}>
                <View style={[styles.badge, isCompleted && styles.badgeCompleted]}>
                    <Text style={[styles.badgeText, isCompleted && styles.badgeTextCompleted]}>{totalItems}</Text>
                </View>
            </View>
        </TouchableOpacity>
    );
}

// ─── Main screen ─────────────────────────────────────────────────────────────

export default function ShoppingListScreen() {
    const colors = useTheme();
    const header = useCollapsingHeader();
    const insets = useSafeAreaInsets();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const tabBarHeight = useSafeBottomTabBarHeight();
    const [lists, setLists] = useState<ShoppingList[]>([]);
    const [splitGroups, setSplitGroups] = useState<SplitGroup[]>([]);
    const [chainFilter, setChainFilter] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedListIds, setSelectedListIds] = useState<Set<number>>(new Set());

    const exitSelection = useCallback(() => {
        setSelectionMode(false);
        setSelectedListIds(new Set());
    }, []);

    const toggleSelectList = useCallback((listId: number) => {
        setSelectedListIds(prev => {
            const next = new Set(prev);
            if (next.has(listId)) next.delete(listId); else next.add(listId);
            return next;
        });
    }, []);

    const toggleSelectGroup = useCallback((groupListIds: number[]) => {
        setSelectedListIds(prev => {
            const next = new Set(prev);
            const allSelected = groupListIds.every(id => next.has(id));
            if (allSelected) groupListIds.forEach(id => next.delete(id));
            else groupListIds.forEach(id => next.add(id));
            return next;
        });
    }, []);

    useEffect(() => {
        if (selectionMode && selectedListIds.size === 0) setSelectionMode(false);
    }, [selectionMode, selectedListIds]);
    const router = useRouter();

    const loadSplitGroups = useCallback(async (currentLists: ShoppingList[]) => {
        try {
            const allKeys = await AsyncStorage.getAllKeys();
            const splitKeys = allKeys.filter(k => k.startsWith('split_lists_'));
            if (splitKeys.length === 0) { setSplitGroups([]); return; }
            const pairs = await AsyncStorage.multiGet(splitKeys);
            const groups: SplitGroup[] = [];
            for (const [key, value] of pairs) {
                if (!value) continue;
                const basketId = key.replace('split_lists_', '');
                const entries: SplitGroupEntry[] = JSON.parse(value);
                const matchedLists = entries
                    .map(e => currentLists.find(l => l.id === e.listId))
                    .filter((l): l is ShoppingList => l !== undefined);
                if (matchedLists.length > 0) {
                    groups.push({ basketId, entries, lists: matchedLists });
                }
            }
            setSplitGroups(groups);
        } catch {
            setSplitGroups([]);
        }
    }, []);

    const fetchLists = useCallback(async () => {
        try {
            const userId = await getUserId();
            const res = await fetch(`${API_BASE_URL}/api/shopping-lists/user/${userId}`);
            const data = await res.json();
            const listData: ShoppingList[] = Array.isArray(data) ? data : [];
            setLists(listData);
            await loadSplitGroups(listData);
        } catch (error) {
            console.error('Failed to fetch lists:', error);
        } finally {
            setLoading(false);
        }
    }, [loadSplitGroups]);

    useFocusEffect(useCallback(() => {
        fetchLists();
    }, [fetchLists]));

    // ── Delete / complete list ────────────────────────────────────────────────

    const deleteList = useCallback(async (listId: number) => {
        setLists(prev => prev.filter(l => l.id !== listId));
        try {
            await fetch(`${API_BASE_URL}/api/shopping-lists/${listId}`, { method: 'DELETE' });
        } catch {
            fetchLists();
        }
    }, [fetchLists]);

    const completeList = useCallback(async (listId: number) => {
        setLists(prev => prev.map(l => l.id === listId ? { ...l, status: 'completed' } : l));
        try {
            await fetch(`${API_BASE_URL}/api/shopping-lists/${listId}/status`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'completed' }),
            });
        } catch {
            fetchLists();
        }
    }, [fetchLists]);

    // ── FAB / chain picker ────────────────────────────────────────────────────
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
            const storesRes = await fetch(`${API_BASE_URL}/api/stores/chain/${chainId}`);
            const stores: Store[] = await storesRes.json();
            if (!Array.isArray(stores) || stores.length === 0) {
                Alert.alert(t('shoppingListTab.errors.generic'), t('shoppingListTab.errors.noStoreChoices'));
                return;
            }
            const userId = await getUserId();
            const res = await fetch(`${API_BASE_URL}/api/shopping-lists`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, storeId: stores[0].id }),
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

    // ── Derived data ──────────────────────────────────────────────────────────

    const splitListIds = useMemo(
        () => new Set(splitGroups.flatMap(g => g.entries.map(e => e.listId))),
        [splitGroups],
    );
    const singleLists = useMemo(
        () => lists.filter(l => !splitListIds.has(l.id)),
        [lists, splitListIds],
    );

    const allChains = useMemo(() => {
        const map = new Map<string, string | null>();
        singleLists.forEach(l => { if (!map.has(l.chainName)) map.set(l.chainName, l.logoUrl); });
        splitGroups.forEach(g => g.entries.forEach(e => { if (!map.has(e.chainName)) map.set(e.chainName, e.chainLogoUrl); }));
        return Array.from(map.entries()).map(([name, logoUrl]) => ({
            id: name,
            label: chainBrandName(name),
            logoUrl: logoUrl ? getMiniLogoUrl(name, logoUrl) : null,
        }));
    }, [singleLists, splitGroups]);

    const filteredSingle = singleLists.filter(l => {
        if (chainFilter && l.chainName !== chainFilter) return false;
        return true;
    });
    const filteredGroups = splitGroups.filter(g => {
        if (chainFilter && !g.entries.some(e => e.chainName === chainFilter)) return false;
        return true;
    });

    const activeSingle = filteredSingle.filter(l => l.status === 'active');
    const completedSingle = filteredSingle.filter(l => l.status === 'completed');
    const activeGroups = filteredGroups.filter(g => g.lists.some(l => l.status === 'active') || g.lists.length === 0);
    const completedGroups = filteredGroups.filter(g => g.lists.length > 0 && g.lists.every(l => l.status === 'completed'));

    const hasAny = lists.length > 0 || splitGroups.length > 0;
    const hasActive = activeSingle.length > 0 || activeGroups.length > 0;
    const hasCompleted = completedSingle.length > 0 || completedGroups.length > 0;

    if (loading) return (
        <View style={styles.container}>
            <Stack.Screen options={glassHeaderOptions()} />
            <ScreenHeading title={t('tabs.shoppingList')} topInset={insets.top} />
            <View style={{ padding: 16 }}>
                <SkeletonBox width={70} height={13} borderRadius={6} style={{ marginBottom: 12 }} />
                {Array.from({ length: 5 }).map((_, i) => (
                    <View key={i} style={{ backgroundColor: colors.cardBackground, borderRadius: 12, padding: 14, marginBottom: 10, gap: 10, borderLeftWidth: 3, borderLeftColor: colors.borderSubtle }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                            <SkeletonBox width={32} height={32} borderRadius={6} />
                            <View style={{ gap: 6, flex: 1 }}>
                                <SkeletonBox width={140} height={13} borderRadius={6} />
                                <SkeletonBox width={200} height={11} borderRadius={5} />
                            </View>
                        </View>
                        <SkeletonBox height={6} borderRadius={3} />
                    </View>
                ))}
            </View>
        </View>
    );

    return (
        <View style={styles.container}>
            {/* No bar action → the empty bar is hidden; this header takes the inset. */}
            <CollapsingHeader
                controller={header}
                background={colors.cardBackground}
                collapsing={<ScreenHeading title={t('tabs.shoppingList')} />}
                pinned={allChains.length >= 2 ? (
                    <StoreChipBar
                        chips={allChains}
                        selectedId={chainFilter}
                        onSelect={id => setChainFilter(id as string | null)}
                        allLabel={t('shoppingListTab.filterAll')}
                    />
                ) : undefined}
            />

            <Animated.FlatList
                {...header.scroll}
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
                        {hasActive && (
                            <>
                                <Text style={styles.sectionTitle}>{t('shoppingListTab.sectionActive')}</Text>
                                {activeGroups.map(group => {
                                    const groupIds = group.lists.map(l => l.id);
                                    const groupSelected = groupIds.length > 0 && groupIds.every(id => selectedListIds.has(id));
                                    return (
                                        <SplitGroupCard
                                            key={group.basketId}
                                            group={group}
                                            onPress={() => {
                                                if (selectionMode) { toggleSelectGroup(groupIds); return; }
                                                const firstId = group.entries[0]?.listId;
                                                if (firstId) router.push(`/shopping-list/${firstId}?basketId=${group.basketId}` as any);
                                            }}
                                            onLongPress={() => { setSelectionMode(true); toggleSelectGroup(groupIds); }}
                                            selectionMode={selectionMode}
                                            selected={groupSelected}
                                            styles={styles}
                                            colors={colors}
                                        />
                                    );
                                })}
                                {activeSingle.map(item => (
                                    <ShoppingListCard
                                        key={item.id}
                                        item={item}
                                        onPress={id => {
                                            if (selectionMode) { toggleSelectList(item.id); return; }
                                            router.push(`/shopping-list/${id}` as any);
                                        }}
                                        onLongPress={() => { setSelectionMode(true); toggleSelectList(item.id); }}
                                        selectionMode={selectionMode}
                                        selected={selectedListIds.has(item.id)}
                                        styles={styles}
                                        colors={colors}
                                    />
                                ))}
                            </>
                        )}
                        {hasCompleted && (
                            <>
                                <Text style={styles.sectionTitle}>{t('shoppingListTab.sectionCompleted')}</Text>
                                {completedGroups.map(group => {
                                    const groupIds = group.lists.map(l => l.id);
                                    const groupSelected = groupIds.length > 0 && groupIds.every(id => selectedListIds.has(id));
                                    return (
                                        <SplitGroupCard
                                            key={group.basketId}
                                            group={group}
                                            onPress={() => {
                                                if (selectionMode) { toggleSelectGroup(groupIds); return; }
                                                const firstId = group.entries[0]?.listId;
                                                if (firstId) router.push(`/shopping-list/${firstId}?basketId=${group.basketId}` as any);
                                            }}
                                            onLongPress={() => { setSelectionMode(true); toggleSelectGroup(groupIds); }}
                                            selectionMode={selectionMode}
                                            selected={groupSelected}
                                            styles={styles}
                                            colors={colors}
                                        />
                                    );
                                })}
                                {completedSingle.map(item => (
                                    <ShoppingListCard
                                        key={item.id}
                                        item={item}
                                        onPress={id => {
                                            if (selectionMode) { toggleSelectList(item.id); return; }
                                            router.push(`/shopping-list/${id}` as any);
                                        }}
                                        onLongPress={() => { setSelectionMode(true); toggleSelectList(item.id); }}
                                        selectionMode={selectionMode}
                                        selected={selectedListIds.has(item.id)}
                                        styles={styles}
                                        colors={colors}
                                    />
                                ))}
                            </>
                        )}
                        {!hasAny && (
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
                contentInsetAdjustmentBehavior="never"
                contentContainerStyle={[styles.list, { paddingTop: header.paddingTop + 12, paddingBottom: tabBarHeight + 24 }]}
            />

            {!selectionMode && (
                <TouchableOpacity
                    style={[styles.fab, { bottom: tabBarHeight + 16 }]}
                    onPress={() => setFabMenuOpen(true)}
                    activeOpacity={0.85}
                >
                    <Ionicons name="add" size={28} color={colors.onPrimary} />
                </TouchableOpacity>
            )}

            <Modal visible={fabMenuOpen} transparent animationType="fade" onRequestClose={() => setFabMenuOpen(false)}>
                <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setFabMenuOpen(false)}>
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

            {selectionMode && selectedListIds.size > 0 && (() => {
                const ids = Array.from(selectedListIds);
                const hasActiveStatus = lists.some(l => ids.includes(l.id) && l.status === 'active');
                const actions: CardAction[] = [];
                if (hasActiveStatus) {
                    actions.push({
                        icon: 'checkmark-circle-outline',
                        label: t('shoppingListTab.complete'),
                        onPress: () => {
                            lists.forEach(l => { if (ids.includes(l.id) && l.status === 'active') completeList(l.id); });
                            exitSelection();
                        },
                    });
                }
                actions.push({
                    icon: 'trash-outline',
                    label: t('shoppingListTab.delete'),
                    destructive: true,
                    onPress: () => {
                        ids.forEach(id => deleteList(id));
                        exitSelection();
                    },
                });
                return <CardActionBar mode="inline" actions={actions} onDismiss={exitSelection} />;
            })()}

            <Modal visible={chainPickerOpen} transparent animationType="slide" onRequestClose={() => setChainPickerOpen(false)}>
                <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => !creatingChainId && setChainPickerOpen(false)}>
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
                                    {creatingChainId === chain.id && <ActivityIndicator size="small" color={colors.primary} />}
                                </TouchableOpacity>
                            ))
                        )}
                    </View>
                </TouchableOpacity>
            </Modal>
        </View>
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

    // ── Multi-select circle (shown next to the logo in selection mode) ───────
    selectCircle: {
        width: 22, height: 22, borderRadius: 11,
        borderWidth: 2, borderColor: c.border,
        alignItems: 'center', justifyContent: 'center',
        marginRight: 10, flexShrink: 0,
    },
    selectCircleChecked: { backgroundColor: c.primary, borderColor: c.primary },

    // ── Single-store card ─────────────────────────────────────────────────────
    card: {
        backgroundColor: c.cardBackground, borderRadius: 12, padding: 14, marginBottom: 10,
        flexDirection: 'row', alignItems: 'center',
        elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08, shadowRadius: 2,
        borderLeftWidth: 4,
    },
    cardActive: { borderLeftColor: c.primary },
    cardCompleted: { borderLeftColor: c.textMuted },
    cardLeft: { marginRight: 12 },
    logo: { width: 32, height: 32, borderRadius: 6, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
    logoImage: { width: 24, height: 24 },
    logoPlaceholderText: { fontSize: 15, fontWeight: '700', color: '#FFFFFF' },
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

    // ── Multi-store split card ────────────────────────────────────────────────
    splitLogos: { flexDirection: 'row', alignItems: 'center' },
    splitLogo: {
        width: 36, height: 36, borderRadius: 8,
        borderWidth: 2, borderColor: c.cardBackground,
        alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    },
    splitLogoImage: { width: 26, height: 26 },
    splitLogoOverlap: { marginLeft: -10 },
    splitLogoPlaceholderText: { fontSize: 14, fontWeight: '700', color: '#FFFFFF' },
    splitLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
    // ── Empty ─────────────────────────────────────────────────────────────────
    emptyText: { fontSize: 16, color: c.textSecondary, fontWeight: '600', marginTop: 16, textAlign: 'center' },
    emptySubText: { fontSize: 13, color: c.textMuted, marginTop: 6, textAlign: 'center', lineHeight: 18 },
    emptyButton: { marginTop: 20, backgroundColor: c.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 24 },
    emptyButtonText: { color: c.onPrimary, fontWeight: '700', fontSize: 14 },

    // ── FAB ───────────────────────────────────────────────────────────────────
    fab: {
        position: 'absolute', right: 20, width: 56, height: 56, borderRadius: 28,
        backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center',
        elevation: 6, shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.25, shadowRadius: 5,
    },

    // ── Modals ────────────────────────────────────────────────────────────────
    modalBackdrop: { flex: 1, backgroundColor: c.overlayBackdrop, justifyContent: 'flex-end' },
    fabMenu: {
        backgroundColor: c.cardBackground, marginHorizontal: 16, marginBottom: 92,
        borderRadius: 12, paddingVertical: 4,
        elevation: 8, shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2, shadowRadius: 6,
    },
    fabMenuItem: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 18 },
    fabMenuItemText: { fontSize: 15, color: c.textPrimary, fontWeight: '500' },
    fabMenuDivider: { height: 1, backgroundColor: c.borderSubtle, marginHorizontal: 12 },
    chainPickerSheet: {
        backgroundColor: c.cardBackground, borderTopLeftRadius: 16, borderTopRightRadius: 16,
        paddingHorizontal: 20, paddingTop: 20, paddingBottom: 32,
    },
    sheetTitle: { fontSize: 16, fontWeight: '700', color: c.textPrimary, marginBottom: 12 },
    sheetEmpty: { fontSize: 14, color: c.textMuted, textAlign: 'center', marginVertical: 16 },
    chainRow: {
        flexDirection: 'row', alignItems: 'center', gap: 12,
        paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.borderSubtle,
    },
    chainLogo: { width: 36, height: 36, borderRadius: 6 },
    chainLogoPlaceholder: {
        width: 36, height: 36, borderRadius: 6,
        backgroundColor: c.surfaceMuted, alignItems: 'center', justifyContent: 'center',
    },
    chainLogoPlaceholderText: { fontSize: 16, fontWeight: '700', color: c.textSecondary },
    chainName: { flex: 1, fontSize: 15, color: c.textPrimary, fontWeight: '500' },
});
