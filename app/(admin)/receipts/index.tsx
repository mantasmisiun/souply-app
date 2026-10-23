import {
    View,
    Text,
    StyleSheet,
    SectionList,
    TouchableOpacity,
    RefreshControl,
    ScrollView,
    Image,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../../constants/theme';
import Animated from 'react-native-reanimated';
import { useCollapsingHeader, CollapsingHeader } from '../../../components/CollapsingHeader';
import { ScreenHeading } from '../../../components/ScreenHeading';
import {
    getAdminReceiptList,
    type AdminReceiptRow,
    type ReceiptFilter,
} from '../../../services/adminClient';

const PAGE_SIZE = 20;

const AnimatedSectionList = Animated.createAnimatedComponent(SectionList as typeof SectionList<AdminReceiptRow>);

export default function ReceiptsScreen() {
    const colors = useTheme();
    const header = useCollapsingHeader();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();

    const [filter, setFilter] = useState<ReceiptFilter>('all');
    const [receipts, setReceipts] = useState<AdminReceiptRow[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(0);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);

    const load = useCallback(async (p: number, f: ReceiptFilter, replace: boolean) => {
        try {
            const res = await getAdminReceiptList(p, f, PAGE_SIZE);
            setReceipts(prev => replace ? res.receipts : [...prev, ...res.receipts]);
            setTotal(res.total);
            setPage(p);
        } catch (e) {
            console.warn('[receipts] load failed', e);
        }
    }, []);

    useFocusEffect(useCallback(() => {
        setLoading(true);
        load(0, filter, true).finally(() => setLoading(false));
    }, [load, filter]));

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await load(0, filter, true);
        setRefreshing(false);
    }, [load, filter]);

    const onLoadMore = useCallback(async () => {
        const hasMore = receipts.length < total;
        if (!hasMore || loadingMore) return;
        setLoadingMore(true);
        await load(page + 1, filter, false);
        setLoadingMore(false);
    }, [receipts.length, total, loadingMore, page, filter, load]);

    const onFilterChange = useCallback((f: ReceiptFilter) => {
        setFilter(f);
        setLoading(true);
        load(0, f, true).finally(() => setLoading(false));
    }, [load]);

    const chips: { id: ReceiptFilter; label: string }[] = [
        { id: 'all',     label: t('admin.receipts.filterAll') },
        { id: 'flagged', label: t('admin.receipts.filterFlagged') },
        { id: 'fixed',   label: t('admin.receipts.filterFixed') },
    ];

    const renderItem = useCallback(({ item }: { item: AdminReceiptRow }) => {
        const dateStr = item.date
            ? new Date(item.date).toLocaleDateString('lt-LT', { day: '2-digit', month: '2-digit', year: '2-digit' })
            : '—';
        return (
            <TouchableOpacity
                style={styles.row}
                onPress={() => router.push(`/admin/receipts/${item.id}` as any)}
                activeOpacity={0.7}
            >
                <View style={styles.rowLeft}>
                    {item.chainLogoUrl
                        ? <Image source={{ uri: item.chainLogoUrl }} style={styles.chainLogo} resizeMode="contain" />
                        : <View style={[styles.chainLogo, { backgroundColor: colors.surfaceMuted }]} />}
                    <View style={styles.rowInitialWrap}>
                        <Text style={styles.rowInitial}>{item.userInitial}</Text>
                    </View>
                </View>
                <View style={styles.rowBody}>
                    <View style={styles.rowTop}>
                        <Text style={styles.rowDate}>{dateStr}</Text>
                        <View style={styles.rowBadges}>
                            {item.flagged && (
                                <Ionicons name="flag" size={13} color={colors.error} />
                            )}
                            {item.hasInspectEdits && (
                                <Ionicons name="create-outline" size={13} color={colors.primary} />
                            )}
                        </View>
                    </View>
                    <Text style={styles.rowMeta}>
                        {t('admin.receipts.lineCount', { count: item.lineCount })}
                        {item.total != null ? `  ·  ${item.total.toFixed(2)} €` : ''}
                    </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </TouchableOpacity>
        );
    }, [router, colors, styles, t]);

    return (
        <View style={styles.root}>
            <CollapsingHeader controller={header} smallTitle={t('admin.tabReceipts')} />

            {loading ? (
                <View style={styles.centered}>
                    <MaterialProgress size="large" color={colors.primary} />
                </View>
            ) : (
                <>
                {/* Always-pinned filter row: Fabric mis-hit-tests transformed
                    sticky headers (touches fall through to the list). */}
                        <View onLayout={header.onPinnedLayout} style={styles.chipBar}>
                            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipBarContent}>
                                {chips.map(chip => {
                                    const active = chip.id === filter;
                                    return (
                                        <TouchableOpacity
                                            key={chip.id}
                                            style={[styles.chip, active && styles.chipActive]}
                                            onPress={() => onFilterChange(chip.id)}
                                        >
                                            <Text style={[styles.chipText, active && styles.chipTextActive]}>
                                                {chip.label}
                                            </Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </ScrollView>
                        </View>
                <AnimatedSectionList
                    {...header.scroll}
                    ListHeaderComponent={<ScreenHeading title={t('admin.tabReceipts')} onLayout={header.onTitleLayout} />}
                    sections={[{ data: receipts }]}
                    keyExtractor={(r: any) => r.id}
                    renderItem={renderItem}
                    refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
                    onEndReached={onLoadMore}
                    onEndReachedThreshold={0.3}
                    contentContainerStyle={[{ paddingTop: 0 }, receipts.length === 0 ? styles.emptyContainer : null]}
                    ListEmptyComponent={
                        <View style={styles.centered}>
                            <Ionicons name="receipt-outline" size={48} color={colors.textMuted} />
                            <Text style={styles.emptyText}>{t('admin.receipts.empty')}</Text>
                        </View>
                    }
                    ListFooterComponent={loadingMore ? (
                        <View style={styles.footerLoader}>
                            <MaterialProgress color={colors.primary} />
                        </View>
                    ) : null}
                    ItemSeparatorComponent={() => <View style={styles.separator} />}
                />
                </>
            )}
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    root: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
    emptyContainer: { flex: 1 },
    emptyText: { fontSize: 14, color: c.textSecondary },

    chipBar: { backgroundColor: c.cardBackground, borderBottomWidth: 1, borderBottomColor: c.borderSubtle },
    chipBarContent: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
    chip: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 20, backgroundColor: c.surfaceMuted },
    chipActive: { backgroundColor: c.primary },
    chipText: { fontSize: 13, fontWeight: '600', color: c.textSecondary },
    chipTextActive: { color: c.onPrimary },

    row: {
        flexDirection: 'row', alignItems: 'center', gap: 12,
        paddingHorizontal: 16, paddingVertical: 14,
        backgroundColor: c.cardBackground,
    },
    rowLeft: { flexDirection: 'row', gap: 8, alignItems: 'center' },
    chainLogo: { width: 28, height: 28, borderRadius: 14 },
    rowInitialWrap: {
        width: 28, height: 28, borderRadius: 14,
        backgroundColor: c.primary + '20',
        alignItems: 'center', justifyContent: 'center',
    },
    rowInitial: { fontSize: 13, fontWeight: '700', color: c.primary },
    rowBody: { flex: 1 },
    rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 },
    rowDate: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    rowBadges: { flexDirection: 'row', gap: 6 },
    rowMeta: { fontSize: 12, color: c.textSecondary },
    separator: { height: 1, backgroundColor: c.borderSubtle },
    footerLoader: { paddingVertical: 20, alignItems: 'center' },
});
