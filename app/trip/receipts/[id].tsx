/**
 * Trip final screen (stages 4+5). Two panes behind a compact glass tab bar
 * (Kvitai / Statistika):
 *  - Kvitai: uploaded receipts (store · date · items · total, tap → viewer,
 *    download 1/select/all), all identified items with a store-logo badge, and
 *    an upload button (more receipts than stores is fine).
 *  - Statistika: hero spend, saved/overpaid + planning score, the Category →
 *    Trips → Stores donut carousel (same as My tab), and extra metric cards.
 */
import {
    View, Text, TouchableOpacity, StyleSheet, ScrollView, Image,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { MaterialProgress } from '@/components/MaterialProgress';
import { ChainLogoChip } from '../../../components/ChainLogoChip';
import { UserAvatar } from '../../../components/UserAvatar';
import { ScreenBackButton } from '../../../components/ScreenBackButton';
import { GlassIconButton } from '../../../components/GlassIconButton';
import { GlassSheet } from '../../../components/GlassSheet';
import { ReceiptDetailSheet } from '../../../components/receipt/ReceiptDetailSheet';
import { PlanningSheet } from '../../../components/receipt/PlanningSheet';
import { SavingsSheet } from '../../../components/receipt/SavingsSheet';
import { DiscountsSheet } from '../../../components/receipt/DiscountsSheet';
import { PlanReconcileSheet, type PlanReconcileItem } from '../../../components/receipt/PlanReconcileSheet';
import { PredictionSheet } from '../../../components/receipt/PredictionSheet';
import { SwipeQueue } from '../../../components/swipe/SwipeQueue';
import { DonutCarousel, type DonutPage } from '../../../components/DonutCarousel';
import { chainIdByName, chainBrandColor, chainBrandName } from '../../../utils/chainBrandName';
import { formatDate , formatEuro } from '../../../utils/formatCurrency';
import { formatMonthKey } from '../../../utils/monthNames';
import { formatAmount } from '../../../utils/weighable';
import { formatWeekday } from '../../../utils/formatDayDate';
import { ltPluralSuffix } from '../../../utils/ltPlural';
import { mergeReceiptItems, mergedQtyLabel } from '../../../utils/mergeReceiptItems';
import { useTheme, spacing, radius, typography, type AppTheme } from '../../../constants/theme';
import { DockedGlassSheet } from '../../../components/DockedGlassSheet';
import { DockTabsRow } from '../../../components/FloatingPillTabBar';
import {
    fetchTrips, fetchTripReceipts, fetchTripStats, fetchTripScore, fetchMonthlyTripSpend,
    type TripReceipt, type TripStats, type TripScore, type TripSpendEntry, type TripSummary,
} from '../../../utils/tripsApi';
import { ReceiptUploadSheet } from '../../../components/ReceiptUploadSheet';
import { getUserId } from '../../../config/user';

// Donut palette for categories / trips (stores use chain brand colours).
const PALETTE = ['#EB6784', '#5EA29A', '#E8894D', '#6C8AE4', '#B07CD6', '#E0A93B', '#58B368', '#E06C9F', '#4CA0B3', '#C76B6B'];

const monthOf = (iso: string): string => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
// Promo-adjusted line totals — sums to the Stats hero (totalSpent).
const receiptTotal = (r: TripReceipt): number =>
    r.items.reduce((s, it) => s + (it.lineTotal != null ? Number(it.lineTotal) : (it.price != null ? Number(it.price) : 0)), 0);

export default function TripFinalScreen() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { t, i18n } = useTranslation();
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { id, tab: tabParam } = useLocalSearchParams<{ id: string; tab?: string }>();
    const tripId = Number(id);

    const [tab, setTab] = useState<'receipt' | 'stats'>(tabParam === 'stats' ? 'stats' : 'receipt');
    const [trip, setTrip] = useState<TripSummary | null>(null);
    const [receipts, setReceipts] = useState<TripReceipt[] | null>(null);
    const [stats, setStats] = useState<TripStats | null>(null);
    const [score, setScore] = useState<TripScore | null>(null);
    const [tripSpend, setTripSpend] = useState<TripSpendEntry[]>([]);
    const [locked, setLocked] = useState<boolean | null>(null);

    const [uploadSheet, setUploadSheet] = useState(false);
    const [sheetReceipt, setSheetReceipt] = useState<TripReceipt | null>(null);
    const [planningOpen, setPlanningOpen] = useState(false);
    const [savingsOpen, setSavingsOpen] = useState(false);
    const [discountsOpen, setDiscountsOpen] = useState(false);
    const [impulseOpen, setImpulseOpen] = useState(false);
    const [missedOpen, setMissedOpen] = useState(false);
    const [predictionOpen, setPredictionOpen] = useState(false);
    const [myId, setMyId] = useState<string | null>(null);
    useEffect(() => { void getUserId().then(setMyId); }, []);

    const load = useCallback(async () => {
        try {
            const rs = await fetchTripReceipts(tripId);
            setReceipts(rs);
            const pending = rs.some(r => r.mandatorySwipesRequired > 0 && !r.mandatorySwipesCompleted);
            setLocked(pending || rs.length === 0);
            // Trip meta (title + anchor month for the trips donut).
            const trips = await fetchTrips().catch(() => [] as TripSummary[]);
            const tr = trips.find(x => x.id === tripId) ?? null;
            setTrip(tr);
            if (!pending && rs.length > 0) {
                const [st, sc, sp] = await Promise.all([
                    fetchTripStats(tripId).catch(() => null),
                    fetchTripScore(tripId).catch(() => null),
                    fetchMonthlyTripSpend(tr ? monthOf(tr.anchorDate) : undefined).catch(() => []),
                ]);
                setStats(st); setScore(sc); setTripSpend(sp);
            }
        } catch { setLocked(true); setReceipts([]); }
    }, [tripId]);
    useFocusEffect(useCallback(() => { void load(); }, [load]));

    const title = trip ? (trip.name ?? formatWeekday(trip.anchorDate, i18n.language)) : t('tripReceipts.title');

    const multi = (receipts?.length ?? 0) > 1;

    // Receipts whose mandatory swipe queue is still pending — the Stats pane hosts
    // the swipe queue in-place for these, then reloads into the stats once cleared.
    const pendingSwipeIds = useMemo(
        () => (receipts ?? [])
            .filter(r => r.mandatorySwipesRequired > 0 && r.mandatorySwipesCompleted < r.mandatorySwipesRequired)
            .map(r => String(r.id)),
        [receipts],
    );

    // ── donut pages ───────────────────────────────────────────────────────
    const donutPages = useMemo<DonutPage[]>(() => {
        if (!stats) return [];
        // DonutChart keys slices by label (Maps + React keys); duplicate labels
        // — two unnamed trips on the same weekday, two same-named categories —
        // collide. Guarantee uniqueness while keeping the first occurrence clean.
        const uniqueLabels = <T extends { label: string }>(slices: T[]): T[] => {
            const seen = new Map<string, number>();
            return slices.map(s => {
                const n = seen.get(s.label) ?? 0;
                seen.set(s.label, n + 1);
                return n === 0 ? s : { ...s, label: `${s.label} (${n + 1})` };
            });
        };
        const catSlices = uniqueLabels(stats.categoryBreakdown.map((c, i) => ({
            label: c.categoryName, value: c.total, color: PALETTE[i % PALETTE.length],
        })));
        // Short brand names (Iki, Maxima…) not the official chain names; logoUri
        // (truthy) makes the legend + selected-slice centre show the chain badge
        // (resolved from the label via chainIdByName).
        const storeSlices = uniqueLabels(stats.chainBreakdown.map(c => ({
            label: chainBrandName(c.chainName), value: c.total, color: chainBrandColor(c.chainName),
            logoUri: c.chainName || null,
        })));
        // Trips this month: current trip first (highlighted), top others, rest → Kita.
        const sorted = [...tripSpend].sort((a, b) => b.totalSpent - a.totalSpent);
        const cur = sorted.find(s => s.tripId === tripId);
        const others = sorted.filter(s => s.tripId !== tripId);
        const head = [cur, ...others].filter(Boolean).slice(0, 5) as TripSpendEntry[];
        const rest = others.slice(Math.max(0, head.length - 1));
        const tripSlices = uniqueLabels(head.map((s, i) => ({
            label: s.name ?? formatWeekday(s.anchorDate, i18n.language),
            value: s.totalSpent,
            color: s.tripId === tripId ? colors.primary : PALETTE[(i + 1) % PALETTE.length],
        })));
        const restTotal = rest.reduce((s, x) => s + x.totalSpent, 0);
        if (restTotal > 0) tripSlices.push({ label: t('profilis.kitosLabel'), value: Math.round(restTotal * 100) / 100, color: colors.textMuted });
        const curIdx = head.findIndex(s => s.tripId === tripId);

        // Muted date-window sub-lines: the Apsipirkimai donut is scoped to the
        // trip's anchor month, the store donut to this trip's receipt date(s).
        // Category is the current shopping's own items — no window to caption.
        const monthSub = trip ? formatMonthKey(monthOf(trip.anchorDate), i18n.language) : undefined;
        const rdates = (receipts ?? []).map(r => r.receiptDate).filter(Boolean).sort() as string[];
        const storeSub = rdates.length
            ? (formatDate(rdates[0]) === formatDate(rdates[rdates.length - 1])
                ? formatDate(rdates[0])
                : `${formatDate(rdates[0])} – ${formatDate(rdates[rdates.length - 1])}`)
            : undefined;

        return [
            { key: 'cat', title: t('tripFinal.byCategory'), slices: catSlices, emptyText: t('profilis.noData') },
            { key: 'trips', title: t('tripFinal.byTrip'), subtitle: monthSub, slices: tripSlices, preselect: curIdx >= 0 ? curIdx : null, emptyText: t('profilis.noData') },
            { key: 'store', title: t('tripFinal.byStore'), subtitle: storeSub, slices: storeSlices, emptyText: t('profilis.noData') },
        ];
    }, [stats, tripSpend, tripId, trip, receipts, colors, t, i18n.language]);

    // Multi-store trip → stamp each Impulse card with its chain badge.
    const multiChain = useMemo(
        () => new Set((receipts ?? []).map(r => r.chainName).filter(Boolean)).size > 1,
        [receipts],
    );

    // Impulse sheet: every RECEIPT item (Kvitai cards, merged), ✓ on-plan / ✗
    // impulse. A merged row is impulse iff its lines are — all share a product.
    const impulseItems = useMemo<PlanReconcileItem[]>(() => {
        const impulseSet = new Set(score?.impulseReceiptItemIds ?? []);
        return mergeReceiptItems(receipts ?? []).map(m => ({
            key: m.key, name: m.name, imageUris: m.imageUrl ? [m.imageUrl] : null, meta: mergedQtyLabel(m),
            chainId: m.chainId, chainName: m.chainName,
            ok: !m.receiptItemIds.some(id => impulseSet.has(id)),
        }));
    }, [receipts, score]);

    // Missed sheet: every PLAN item, ✓ bought / ✗ missed (server-classified).
    const missedItems = useMemo<PlanReconcileItem[]>(() =>
        (score?.listItemsDetail ?? []).map(li => ({
            key: `li:${li.listItemId}`, name: li.name, imageUris: li.imageUrls,
            meta: formatAmount(li.quantity, li.isWeighable, li.canonicalStep), ok: li.bought,
        })), [score]);

    // Prediction: hide unless a real (non-ad-hoc) list was priced.
    const prediction = score && !score.isAdHoc && score.predictedMatchedTotal != null && score.actualMatchedTotal != null
        ? { delta: Math.round((score.actualMatchedTotal - score.predictedMatchedTotal) * 100) / 100,
            accuracy: score.predictedMatchedTotal > 0 ? Math.max(0, Math.round((1 - Math.abs(score.actualMatchedTotal - score.predictedMatchedTotal) / score.predictedMatchedTotal) * 100)) : null }
        : null;

    return (
        <>
            <Stack.Screen options={{ headerShown: false }} />
            <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
                <View style={styles.chrome}>
                    <ScreenBackButton />
                    <Text style={styles.title} numberOfLines={1}>{title}</Text>
                    {tab === 'receipt' && (receipts?.length ?? 0) > 0 && (
                        <GlassIconButton
                            iconNode={
                                <View style={styles.uploadIcon}>
                                    <Ionicons name="receipt-outline" size={24} color={colors.primary} />
                                    <View style={styles.uploadPlus}>
                                        <Ionicons name="add" size={11} color="#FFFFFF" />
                                    </View>
                                </View>
                            }
                            onPress={() => setUploadSheet(true)}
                            accessibilityLabel={t('tripReceipts.upload')}
                        />
                    )}
                </View>

                {/* ── RECEIPT PANE ── */}
                {tab === 'receipt' && (
                    receipts == null ? (
                        <View style={styles.centered}><MaterialProgress size="large" color={colors.primary} /></View>
                    ) : receipts.length === 0 ? (
                        <View style={styles.centered}>
                            <TouchableOpacity style={styles.bigBtn} onPress={() => setUploadSheet(true)}>
                                <Ionicons name="cloud-upload-outline" size={22} color={colors.onPrimary} />
                                <Text style={styles.bigBtnText}>{t('tripReceipts.upload')}</Text>
                            </TouchableOpacity>
                            <Text style={styles.hint}>{t('tripReceipts.emptyHint')}</Text>
                        </View>
                    ) : (
                        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 92 }}>
                            {/* Receipt cards — tap opens the receipt sheet. */}
                            <Text style={styles.sectionTitle}>{t('tripFinal.receiptsCount', { count: receipts.length })}</Text>
                            {receipts.map(r => (
                                <TouchableOpacity
                                    key={r.id}
                                    style={styles.rcard}
                                    activeOpacity={0.8}
                                    onPress={() => setSheetReceipt(r)}
                                >
                                    <View>
                                        <ChainLogoChip chainId={r.chainId ?? chainIdByName(r.chainName ?? '') ?? 0} name={r.chainName ?? undefined} size={38} />
                                        {!!r.staleReceipt && (
                                            <View style={styles.staleBadge}>
                                                <Ionicons name="alert" size={11} color={colors.onPrimary} />
                                            </View>
                                        )}
                                    </View>
                                    <View style={{ flex: 1, minWidth: 0 }}>
                                        <Text style={styles.rstore} numberOfLines={1}>{r.chainName ?? r.storeName ?? `#${r.id}`}</Text>
                                        <Text style={styles.rsub} numberOfLines={1}>
                                            {[r.receiptDate ? formatDate(r.receiptDate) : null, t(`items.count_${ltPluralSuffix(r.items.length)}`, { count: r.items.length })].filter(Boolean).join(' · ')}
                                        </Text>
                                    </View>
                                    <Text style={styles.rtot}>{formatEuro(receiptTotal(r))}</Text>
                                    <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                                </TouchableOpacity>
                            ))}

                            {/* Identified items — duplicate/same-product lines merged;
                                the price shown is the ACTUAL paid (promo-adjusted). */}
                            {(() => {
                                const merged = mergeReceiptItems(receipts);
                                return (
                                    <>
                                        <Text style={styles.sectionTitle}>{`${t('tripFinal.itemsSection')} · ${merged.length}`}</Text>
                                        {merged.map(m => {
                                            const qtyLabel = mergedQtyLabel(m);
                                            return (
                                                <View key={m.key} style={styles.itemRow}>
                                                    <View style={styles.thumbWrap}>
                                                        {m.imageUrl
                                                            ? <Image source={{ uri: m.imageUrl }} style={styles.itemImage} />
                                                            : <View style={[styles.itemImage, styles.itemImageEmpty]} />}
                                                        {multi && (
                                                            <View style={styles.itemBadge}>
                                                                <ChainLogoChip chainId={m.chainId ?? chainIdByName(m.chainName ?? '') ?? 0} name={m.chainName ?? undefined} size={18} />
                                                            </View>
                                                        )}
                                                    </View>
                                                    <View style={{ flex: 1, minWidth: 0 }}>
                                                        <Text style={styles.itemName} numberOfLines={1}>{m.name}</Text>
                                                        {qtyLabel && <Text style={styles.itemMeta}>{qtyLabel}</Text>}
                                                    </View>
                                                    <Text style={styles.itemPrice}>{formatEuro(m.lineTotal)}</Text>
                                                </View>
                                            );
                                        })}
                                    </>
                                );
                            })()}
                        </ScrollView>
                    )
                )}

                {/* ── STATS PANE ── */}
                {tab === 'stats' && (
                    locked == null ? (
                        <View style={styles.centered}><MaterialProgress size="large" color={colors.primary} /></View>
                    ) : pendingSwipeIds.length > 0 ? (
                        // Mandatory swipe queue hosted in-place: clear it here, then
                        // reload straight into the stats (no route bounce).
                        <View style={styles.swipeHost}>
                            <SwipeQueue
                                receiptIds={pendingSwipeIds}
                                voluntary={false}
                                renderHeader
                                onAllDone={() => { void load(); }}
                                onExit={() => setTab('receipt')}
                            />
                        </View>
                    ) : locked ? (
                        <View style={styles.centered}><Text style={styles.hint}>{t('tripMap.statsLocked')}</Text></View>
                    ) : stats ? (
                        <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + 92 }}>
                            {/* hero */}
                            <View style={styles.hero}>
                                <Text style={styles.heroVal}>{formatEuro(stats.totalSpent)}</Text>
                                <Text style={styles.heroLbl}>{t('trips.statSpent')}</Text>
                            </View>

                            {/* two mains */}
                            <View style={styles.mrow}>
                                <TouchableOpacity style={styles.mcard} activeOpacity={0.7} onPress={() => setSavingsOpen(true)}>
                                    <View style={styles.mcapRow}>
                                        <Text style={styles.mcap}>{stats.savings > 0 ? t('trips.statSaved') : stats.savings < 0 ? t('trips.statOverpaid') : t('tripFinal.avgPriceCap')}</Text>
                                        <Ionicons name="chevron-forward" size={13} color={colors.textMuted} />
                                    </View>
                                    <Text style={[styles.mval, stats.savings > 0 && { color: colors.success }, stats.savings < 0 && { color: colors.error }]}>
                                        {stats.savings === 0 ? '—' : `${stats.savings > 0 ? '+' : '−'}${formatEuro(Math.abs(stats.savings))}`}
                                    </Text>
                                    <Text style={styles.mfoot}>{stats.savings === 0 ? t('tripFinal.avgPriceFoot') : t('tripFinal.vsAverage')}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={styles.mcard}
                                    activeOpacity={score?.score != null ? 0.7 : 1}
                                    onPress={() => { if (score?.score != null) setPlanningOpen(true); }}
                                >
                                    <View style={styles.mcapRow}>
                                        <Text style={styles.mcap}>{t('tripFinal.planning')}</Text>
                                        {score?.score != null && <Ionicons name="chevron-forward" size={13} color={colors.textMuted} />}
                                    </View>
                                    <Text style={styles.mval}>
                                        {score?.score != null ? score.score : '—'}<Text style={styles.mvalSub}>{score?.score != null ? '/100' : ''}</Text>
                                    </Text>
                                    {score?.deltaPct != null && (
                                        <Text style={[styles.mfoot, styles.mfootStrong, { color: score.deltaPct >= 0 ? colors.success : colors.error }]}>
                                            {`${score.deltaPct >= 0 ? '+' : '−'}${Math.abs(score.deltaPct)}% ${t('tripFinal.vsUsual')}`}
                                        </Text>
                                    )}
                                </TouchableOpacity>
                            </View>

                            {/* donut carousel */}
                            <View style={styles.donutCard}>
                                <DonutCarousel pages={donutPages} />
                            </View>

                            {/* extra metrics */}
                            <Text style={styles.secLbl}>{t('tripFinal.moreMetrics')}</Text>
                            <View style={styles.mrow}>
                                <TouchableOpacity
                                    style={styles.mcard}
                                    activeOpacity={stats.promoItemCount > 0 ? 0.7 : 1}
                                    onPress={() => { if (stats.promoItemCount > 0) setDiscountsOpen(true); }}
                                >
                                    <View style={styles.mcapRow}>
                                        <Text style={styles.mcap}>{t('tripFinal.promoItems')}</Text>
                                        {stats.promoItemCount > 0 && <Ionicons name="chevron-forward" size={13} color={colors.textMuted} />}
                                    </View>
                                    <Text style={styles.mval}>{stats.promoItemCount}</Text>
                                    <Text style={styles.mfoot}>{stats.promoSavings > 0 ? t('tripFinal.promoSaved', { amount: formatEuro(stats.promoSavings) }) : t('tripFinal.promoNone')}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={styles.mcard}
                                    activeOpacity={impulseItems.length > 0 ? 0.7 : 1}
                                    onPress={() => { if (impulseItems.length > 0) setImpulseOpen(true); }}
                                >
                                    <View style={styles.mcapRow}>
                                        <Text style={styles.mcap}>{t('tripFinal.impulse')}</Text>
                                        {impulseItems.length > 0 && <Ionicons name="chevron-forward" size={13} color={colors.textMuted} />}
                                    </View>
                                    <Text style={styles.mval}>{score?.impulseCount ?? 0}</Text>
                                    <Text style={styles.mfoot}>{t('tripFinal.impulseFoot', { count: score?.impulseCount ?? 0 })}</Text>
                                </TouchableOpacity>
                            </View>
                            <View style={styles.mrow}>
                                <TouchableOpacity
                                    style={styles.mcard}
                                    activeOpacity={missedItems.length > 0 ? 0.7 : 1}
                                    onPress={() => { if (missedItems.length > 0) setMissedOpen(true); }}
                                >
                                    <View style={styles.mcapRow}>
                                        <Text style={styles.mcap}>{t('tripFinal.forgotten')}</Text>
                                        {missedItems.length > 0 && <Ionicons name="chevron-forward" size={13} color={colors.textMuted} />}
                                    </View>
                                    <Text style={styles.mval}>{score?.forgottenCount ?? 0}</Text>
                                    <Text style={styles.mfoot}>{t('tripFinal.forgottenFoot', { count: score?.forgottenCount ?? 0 })}</Text>
                                </TouchableOpacity>
                                {prediction ? (
                                    <TouchableOpacity style={styles.mcard} activeOpacity={0.7} onPress={() => setPredictionOpen(true)}>
                                        <View style={styles.mcapRow}>
                                            <Text style={styles.mcap}>{t('tripFinal.prediction')}</Text>
                                            <Ionicons name="chevron-forward" size={13} color={colors.textMuted} />
                                        </View>
                                        <Text style={[styles.mval, prediction.delta > 0 && { color: colors.error }, prediction.delta < 0 && { color: colors.success }]}>
                                            {prediction.delta === 0 ? '—' : `${prediction.delta > 0 ? '+' : '−'}${formatEuro(Math.abs(prediction.delta))}`}
                                        </Text>
                                        <Text style={styles.mfoot}>{prediction.accuracy != null ? t('tripFinal.predictionFoot', { pct: prediction.accuracy }) : ''}</Text>
                                    </TouchableOpacity>
                                ) : <View style={{ flex: 1 }} />}
                            </View>

                            {/* per-user spend split (shared trips only) */}
                            {stats.memberSpend.length > 1 && (() => {
                                const fairShare = stats.totalSpent / stats.memberSpend.length;
                                return (
                                    <>
                                        <Text style={styles.secLbl}>{t('tripFinal.memberSplit')}</Text>
                                        <View style={styles.memberCard}>
                                            {stats.memberSpend.map((m, i) => {
                                                const dev = Math.round((m.total - fairShare) * 100) / 100;
                                                return (
                                                    <View key={m.userId} style={[styles.memberRow, i > 0 && styles.memberDivider]}>
                                                        <UserAvatar name={m.name ?? '?'} color={m.avatarColor} size={30} />
                                                        <Text style={styles.memberName} numberOfLines={1}>{m.name ?? t('tripFinal.someone')}</Text>
                                                        <Text style={styles.memberPaid}>{formatEuro(m.total)}</Text>
                                                        {Math.abs(dev) >= 0.01 && (
                                                            <Text style={[styles.memberDev, { color: dev >= 0 ? colors.success : colors.error }]}>
                                                                {dev >= 0 ? '+' : '−'}{formatEuro(Math.abs(dev))}
                                                            </Text>
                                                        )}
                                                    </View>
                                                );
                                            })}
                                        </View>
                                    </>
                                );
                            })()}
                        </ScrollView>
                    ) : (
                        <View style={styles.centered}><Text style={styles.hint}>{t('tripMap.statsLocked')}</Text></View>
                    )
                )}

                {/* Pane switcher (bottom-left) — THE shared glass dock in its compact
                    form (same blur/tint/rim/shadow/corners as the main nav + map
                    bars, via DockedGlassSheet). Stats is gated until unlock. */}
                <DockedGlassSheet
                    compact
                    barRowHeight={0}
                    barRow={
                        <DockTabsRow
                            hug
                            tabs={[
                                { key: 'receipt', label: t('tripFinal.tabReceipt'), icon: 'receipt-outline' },
                                {
                                    key: 'stats', label: t('tripFinal.tabStats'), icon: 'stats-chart-outline',
                                    // Enterable once any receipt exists — so a pending mandatory
                                    // queue can be reached and swiped here. Locked only when there
                                    // are no receipts at all; a pending queue shows the pink dot.
                                    disabled: (receipts?.length ?? 0) === 0,
                                    locked: (receipts?.length ?? 0) === 0,
                                    dot: pendingSwipeIds.length > 0,
                                },
                            ]}
                            activeKey={tab}
                            onSelect={(k) => setTab(k as 'receipt' | 'stats')}
                        />
                    }
                />
            </View>

            {/* Receipt sheet — the shared non-docked glass sheet. Mounted only
                while a receipt is selected so its photo fetch doesn't run idle. */}
            {sheetReceipt && (
                <GlassSheet onClose={() => setSheetReceipt(null)}>
                    <ReceiptDetailSheet
                        receipt={sheetReceipt}
                        tripId={tripId}
                        isUploader={myId != null && sheetReceipt.uploaderUserId === myId}
                        canModerate={myId != null && trip?.ownerUserId === myId}
                        onClose={() => setSheetReceipt(null)}
                        onChanged={() => { void load(); }}
                    />
                </GlassSheet>
            )}

            {/* Planning-score transparency sheet (tap the Planavimas card). */}
            {planningOpen && score && (
                <GlassSheet autoHeight onClose={() => setPlanningOpen(false)}>
                    <PlanningSheet score={score} />
                </GlassSheet>
            )}

            {/* Discounted-items sheet (tap the Prekės su akcija card). */}
            {discountsOpen && (
                <GlassSheet autoHeight onClose={() => setDiscountsOpen(false)}>
                    <DiscountsSheet receipts={receipts ?? []} />
                </GlassSheet>
            )}

            {/* Impulse sheet (tap the Impulsyvumas card) — bought vs plan. */}
            {impulseOpen && (
                <GlassSheet autoHeight onClose={() => setImpulseOpen(false)}>
                    <PlanReconcileSheet
                        title={t('impulseSheet.title')}
                        items={impulseItems}
                        okLabel={t('impulseSheet.legendOk')}
                        badLabel={t('impulseSheet.legendBad')}
                        badColor={colors.error}
                        showChainBadge={multiChain}
                        note={t('impulseSheet.note')}
                    />
                </GlassSheet>
            )}

            {/* Missed sheet (tap the Praleistos card) — plan vs bought. */}
            {missedOpen && (
                <GlassSheet autoHeight onClose={() => setMissedOpen(false)}>
                    <PlanReconcileSheet
                        title={t('missedSheet.title')}
                        items={missedItems}
                        okLabel={t('missedSheet.legendOk')}
                        badLabel={t('missedSheet.legendBad')}
                        badColor={colors.textMuted}
                        note={t('missedSheet.note')}
                    />
                </GlassSheet>
            )}

            {/* Prediction sheet (tap the Prognozė card) — per-item forecast vs actual. */}
            {predictionOpen && score && (
                <GlassSheet autoHeight onClose={() => setPredictionOpen(false)}>
                    <PredictionSheet score={score} />
                </GlassSheet>
            )}

            {/* Savings / where-it's-cheapest sheet (tap the Sutaupyta card). */}
            {savingsOpen && (
                <GlassSheet autoHeight onClose={() => setSavingsOpen(false)}>
                    <SavingsSheet tripId={tripId} />
                </GlassSheet>
            )}

            <ReceiptUploadSheet
                visible={uploadSheet}
                onClose={() => setUploadSheet(false)}
                listMap={trip && trip.slots.length > 0 ? trip.slots.map(s => `${s.chainId ?? 0}:${s.listId}`).join(',') : undefined}
            />
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    chrome: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
    // Upload button glyph: the tab's receipt icon + a white "+" in a pink dot.
    uploadIcon: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
    uploadPlus: {
        position: 'absolute', top: -3, right: -4, width: 14, height: 14, borderRadius: 7,
        backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center',
        borderWidth: 1.5, borderColor: c.cardBackground,
    },
    title: { flex: 1, fontSize: 22, fontWeight: '800', color: c.textPrimary },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg, padding: spacing.xl },
    hint: { fontSize: 13, color: c.textSecondary, textAlign: 'center', lineHeight: 20 },
    // Section titles across the Kvitai + Stats tabs share ONE treatment:
    // subheading size (like "Kvitai" / "Prekės") in the muted section-label grey.
    secLbl: { ...typography.subheading, color: c.textMuted, marginTop: spacing.lg, marginBottom: spacing.sm, marginHorizontal: spacing.lg },
    // Content section titles (Kvitai · N, Prekės · N) — a real heading, one step
    // below the screen title, not the muted uppercase eyebrow used for stats meta.
    sectionTitle: { ...typography.subheading, color: c.textMuted, marginTop: spacing.lg, marginBottom: spacing.sm, marginHorizontal: spacing.lg },

    bigBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: c.primary, borderRadius: radius.lg, paddingVertical: 13, paddingHorizontal: spacing.lg },
    bigBtnText: { fontSize: 14.5, fontWeight: '700', color: c.onPrimary },

    rcard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: c.cardBackground, borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, padding: spacing.md, marginHorizontal: spacing.lg, marginBottom: spacing.sm },
    rstore: { ...typography.bodySmallStrong, color: c.textPrimary },
    rsub: { ...typography.labelSmall, color: c.textSecondary, marginTop: 2 },
    rtot: { ...typography.bodySmallStrong, fontVariant: ['tabular-nums'], color: c.textPrimary },
    // Red "old receipt" badge riding the store logo's corner (all users see it).
    staleBadge: {
        position: 'absolute', top: -4, right: -4, width: 18, height: 18, borderRadius: 9,
        backgroundColor: c.error, alignItems: 'center', justifyContent: 'center',
        borderWidth: 2, borderColor: c.cardBackground,
    },

    itemRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
    thumbWrap: { width: 40, height: 40 },
    itemImage: { width: 40, height: 40, borderRadius: 10 },
    itemImageEmpty: { backgroundColor: c.surfaceMuted },
    itemBadge: { position: 'absolute', top: -5, left: -5, borderRadius: 11, padding: 1.5, backgroundColor: c.cardBackground },
    itemName: { ...typography.bodySmall, fontWeight: '600', color: c.textPrimary },
    itemMeta: { ...typography.labelSmall, color: c.textSecondary, marginTop: 1 },
    itemPrice: { ...typography.bodySmall, fontWeight: '700', color: c.textPrimary },

    // stats
    hero: { alignItems: 'center', paddingVertical: spacing.md },
    heroVal: { fontSize: 38, fontWeight: '800', color: c.textPrimary, fontVariant: ['tabular-nums'] },
    // Caption sits UNDER the number (value-primary, like the donut centre).
    heroLbl: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', color: c.textMuted, marginTop: 3 },
    mrow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.md },
    mcard: { flex: 1, backgroundColor: c.cardBackground, borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, padding: spacing.md },
    mcapRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    mcap: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: c.textMuted },
    mval: { fontSize: 22, fontWeight: '800', color: c.textPrimary, marginTop: 5, fontVariant: ['tabular-nums'] },
    mvalSub: { fontSize: 13, color: c.textMuted, fontWeight: '700' },
    mfoot: { fontSize: 11, color: c.textSecondary, marginTop: 4 },
    mfootStrong: { fontWeight: '800', fontVariant: ['tabular-nums'] },
    donutCard: { backgroundColor: c.cardBackground, borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.md },
    memberCard: { backgroundColor: c.cardBackground, borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, paddingHorizontal: spacing.md },
    memberRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
    memberDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
    memberName: { flex: 1, ...typography.bodySmall, fontWeight: '600', color: c.textPrimary },
    memberPaid: { ...typography.bodySmallStrong, fontVariant: ['tabular-nums'], color: c.textPrimary },
    memberDev: { ...typography.labelSmall, fontWeight: '800', fontVariant: ['tabular-nums'], minWidth: 54, textAlign: 'right' },

    // Mandatory-swipe host (Stats pane, before stats unlock).
    swipeHost: { flex: 1 },
});
