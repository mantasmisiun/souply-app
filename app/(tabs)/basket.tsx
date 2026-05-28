import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, RefreshControl } from 'react-native';
import { TabHeader } from '../../components/TabHeader';
import { StoreChipBar } from '../../components/StoreChipBar';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import { useBasketState } from '../../state/basketState';
import { useTheme, type AppTheme } from '../../constants/theme';
import { ScalePressable } from '../../components/ScalePressable';
import { SkeletonBox } from '../../components/SkeletonBox';
import { formatDate } from '../../utils/formatCurrency';

interface Basket {
    id: number;
    userId: string;
    status: string;
    name: string | null;
    createdAt: string;
    updatedAt: string;
    itemCount: number;
}

const INITIAL_PAGE_SIZE = 10;
const PAGE_INCREMENT = 10;

export default function BasketScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const [baskets, setBaskets] = useState<Basket[]>([]);
    // `loading` = full-screen spinner on FIRST mount only.
    // `refreshing` = small header pill shown on subsequent focus refetches
    // so the list doesn't blank out every time the tab regains focus.
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [pullRefreshing, setPullRefreshing] = useState(false);
    const [statusFilter, setStatusFilter] = useState<string>('draft');
    const [visibleCount, setVisibleCount] = useState(INITIAL_PAGE_SIZE);
    const hasFetchedRef = useRef(false);
    const router = useRouter();
    const { setDraftBasketId } = useBasketState();

    const fetchBaskets = async (silent: boolean) => {
        if (silent) setRefreshing(true);
        try {
            const userId = await getUserId();
            const res = await fetch(`${API_BASE_URL}/api/baskets/user/${userId}`);
            const data = await res.json();
            const basketList = Array.isArray(data) ? data : [];
            setBaskets(basketList);
            const draft = basketList.find((b: Basket) => b.status === 'draft');
            setDraftBasketId(draft ? draft.id : null);
        } catch (error) {
            console.error('Failed to fetch baskets:', error);
        } finally {
            if (silent) setRefreshing(false);
            setLoading(false);
        }
    };

    useFocusEffect(useCallback(() => {
        const silent = hasFetchedRef.current;
        hasFetchedRef.current = true;
        fetchBaskets(silent);
    }, []));

    const createBasket = async () => {
        try {
            const userId = await getUserId();
            const res = await fetch(`${API_BASE_URL}/api/baskets`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId }),
            });
            const data = await res.json();
            await fetchBaskets(true);
            router.push(`/basket/${data.id}`);
        } catch (error) {
            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.errorCreate'));
        }
    };

    const handleCreateBasket = async () => {
        const draft = baskets.find(b => b.status === 'draft');
        if (draft) {
            Alert.alert(t('basketTab.warnTitle'), t('basketTab.warnActiveExists'));
            return;
        }
        await createBasket();
    };

    // Basket lifecycle is exactly three states: draft (editable), compared
    // (calculated, read-only until reverted), completed (shopping list
    // wrapped up). 'active' was a leftover from an earlier plan and is
    // never emitted by the backend — removed.
    const getStatusColor = (status: string) => {
        switch (status) {
            case 'draft': return colors.warning;
            case 'compared': return colors.info;
            case 'inProgress': return colors.primary;
            case 'completed': return colors.success;
            default: return colors.textSecondary;
        }
    };

    const getStatusText = (status: string) => {
        switch (status) {
            case 'draft': return t('basketTab.statusDraft');
            case 'compared': return t('basketTab.statusCompared');
            case 'inProgress': return t('basketTab.statusInProgress');
            case 'completed': return t('basketTab.statusCompleted');
            default: return status;
        }
    };

    const filteredBaskets = useMemo(
        () => baskets.filter(b => b.status === statusFilter),
        [baskets, statusFilter],
    );

    useEffect(() => { setVisibleCount(INITIAL_PAGE_SIZE); }, [statusFilter]);

    const statusChips = useMemo(() => {
        const order: Array<{ id: string; label: string }> = [
            { id: 'draft',      label: t('basketTab.statusDraft') },
            { id: 'compared',   label: t('basketTab.statusCompared') },
            { id: 'inProgress', label: t('basketTab.statusInProgress') },
            { id: 'completed',  label: t('basketTab.statusCompleted') },
        ];
        return order.map(c => ({
            ...c,
            count: baskets.filter(b => b.status === c.id).length,
        }));
    }, [baskets, t]);

    if (loading) return (
        <View style={styles.container}>
            <TabHeader title={t('tabs.basket')} />
            <View style={{
                backgroundColor: colors.cardBackground,
                borderBottomWidth: 0.5, borderBottomColor: colors.border,
                flexDirection: 'row', gap: 8,
                paddingHorizontal: 12, paddingVertical: 10,
            }}>
                {Array.from({ length: 4 }).map((_, i) => (
                    <SkeletonBox key={i} width={i === 0 ? 96 : 84} height={32} borderRadius={20} />
                ))}
            </View>
            <View style={{ padding: 16, gap: 12 }}>
                {Array.from({ length: 5 }).map((_, i) => (
                    <View key={i} style={{ backgroundColor: colors.cardBackground, borderRadius: 12, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12, borderLeftWidth: 3, borderLeftColor: colors.borderSubtle }}>
                        <SkeletonBox width={36} height={36} borderRadius={8} />
                        <View style={{ gap: 8, flex: 1 }}>
                            <SkeletonBox width={160} height={14} borderRadius={7} />
                            <SkeletonBox width={100} height={12} borderRadius={6} />
                        </View>
                        <SkeletonBox width={60} height={22} borderRadius={8} />
                    </View>
                ))}
            </View>
        </View>
    );

    const visibleBaskets = filteredBaskets.slice(0, visibleCount);
    const hasMore = filteredBaskets.length > visibleCount;

    return (
        <View style={styles.container}>
            <TabHeader title={t('tabs.basket')} />
            <StoreChipBar
                chips={statusChips}
                selectedId={statusFilter}
                onSelect={id => id != null && setStatusFilter(String(id))}
            />
            {refreshing && (
                <View style={styles.refreshingBanner}>
                    <ActivityIndicator size="small" color={colors.primary} />
                    <Text style={styles.refreshingText}>{t('basketTab.loading')}</Text>
                </View>
            )}
            <FlatList
                data={visibleBaskets}
                keyExtractor={item => item.id.toString()}
                contentContainerStyle={styles.list}
                refreshControl={
                    <RefreshControl
                        refreshing={pullRefreshing}
                        onRefresh={async () => { setPullRefreshing(true); await fetchBaskets(false); setPullRefreshing(false); }}
                        colors={[colors.primary]}
                        tintColor={colors.primary}
                    />
                }
                ListEmptyComponent={
                    <View style={styles.centered}>
                        <Ionicons name="cart-outline" size={56} color={colors.textMuted} />
                        <Text style={styles.emptyText}>{t('basketTab.empty')}</Text>
                        <Text style={styles.emptySubText}>{t('basketTab.emptyBody')}</Text>
                        <ScalePressable style={styles.emptyButton} onPress={() => router.navigate('/(tabs)/browse' as any)}>
                            <Text style={styles.emptyButtonText}>{t('basketTab.emptyCta')}</Text>
                        </ScalePressable>
                    </View>
                }
                ListFooterComponent={
                    hasMore ? (
                        <TouchableOpacity
                            style={styles.loadMoreButton}
                            onPress={() => setVisibleCount(c => c + PAGE_INCREMENT)}
                        >
                            <Text style={styles.loadMoreText}>
                                {t('basketTab.loadMore', { count: baskets.length - visibleCount })}
                            </Text>
                        </TouchableOpacity>
                    ) : null
                }
                renderItem={({ item }) => (
                    <TouchableOpacity
                        style={styles.card}
                        onPress={() => router.push(`/basket/${item.id}`)}
                    >
                        <View style={styles.cardLeft}>
                            <View style={styles.iconContainer}>
                                <Ionicons name="cart-outline" size={28} color={colors.primary} />
                                {item.itemCount > 0 && (
                                    <View style={styles.badge}>
                                        <Text style={styles.badgeText}>{item.itemCount}</Text>
                                    </View>
                                )}
                            </View>
                        </View>
                        <View style={styles.cardContent}>
                            {item.name ? (
                                <>
                                    <Text style={styles.cardTitle}>{item.name}</Text>
                                    <Text style={styles.cardDate}>
                                        {formatDate(item.updatedAt)}
                                    </Text>
                                </>
                            ) : (
                                <Text style={styles.cardTitle}>
                                    {formatDate(item.updatedAt)}
                                </Text>
                            )}
                        </View>
                        <View style={[styles.statusBadge, { backgroundColor: getStatusColor(item.status) }]}>
                            <Text style={styles.statusText}>{getStatusText(item.status)}</Text>
                        </View>
                    </TouchableOpacity>
                )}
            />
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    list: { padding: 16, paddingBottom: 80 },
    card: {
        backgroundColor: c.cardBackground, borderRadius: 12, padding: 16, marginBottom: 12,
        flexDirection: 'row', alignItems: 'center',
        elevation: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08, shadowRadius: 2,
        borderLeftWidth: 3, borderLeftColor: c.softAccent,
    },
    cardLeft: { marginRight: 12 },
    cardContent: { flex: 1 },
    cardTitle: { fontSize: 15, fontWeight: '600', color: c.textPrimary },
    cardDate: { fontSize: 13, color: c.textSecondary, marginTop: 2 },
    statusBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
    statusText: { fontSize: 11, color: c.textInverse, fontWeight: '600' },
    emptyText: { fontSize: 16, color: c.textSecondary, fontWeight: '600', marginTop: 16, textAlign: 'center' },
    emptySubText: { fontSize: 13, color: c.textMuted, marginTop: 6, textAlign: 'center', lineHeight: 18 },
    emptyButton: { marginTop: 20, backgroundColor: c.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 24 },
    emptyButtonText: { color: c.onPrimary, fontWeight: '700', fontSize: 14 },
    fab: {
        position: 'absolute', bottom: 24, right: 24,
        backgroundColor: c.primary, width: 56, height: 56,
        borderRadius: 28, alignItems: 'center', justifyContent: 'center', elevation: 4,
    },
    iconContainer: {
        position: 'relative',
        width: 36,
        height: 36,
        alignItems: 'center',
        justifyContent: 'center',
    },
    badge: {
        position: 'absolute',
        top: -4,
        right: -6,
        backgroundColor: c.primary,
        borderRadius: 10,
        minWidth: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 4,
    },
    badgeText: { color: c.onPrimary, fontSize: 10, fontWeight: '700' },
    refreshingBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingVertical: 4,
        backgroundColor: c.surfaceSubtle,
    },
    refreshingText: {
        fontSize: 11,
        color: c.textSecondary,
        fontWeight: '500',
    },
    loadMoreButton: {
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: c.border,
        alignItems: 'center',
        backgroundColor: c.cardBackground,
        marginTop: 4,
    },
    loadMoreText: {
        fontSize: 13,
        color: c.primary,
        fontWeight: '600',
    },
});