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
    View, Text, TouchableOpacity, StyleSheet, ScrollView, Image, Alert, ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { MaterialProgress } from '@/components/MaterialProgress';
import { ChainLogoChip } from '../../../components/ChainLogoChip';
import { UserAvatar } from '../../../components/UserAvatar';
import { ScreenBackButton } from '../../../components/ScreenBackButton';
import { DonutCarousel, type DonutPage } from '../../../components/DonutCarousel';
import { chainIdByName, chainBrandColor } from '../../../utils/chainBrandName';
import { formatDate , formatEuro } from '../../../utils/formatCurrency';
import { formatWeekday } from '../../../utils/formatDayDate';
import { useTheme, spacing, radius, typography, type AppTheme } from '../../../constants/theme';
import { DockedGlassSheet } from '../../../components/DockedGlassSheet';
import { DockTabsRow } from '../../../components/FloatingPillTabBar';
import {
    fetchTrips, fetchTripReceipts, fetchTripStats, fetchTripScore, fetchMonthlyTripSpend,
    detachTripReceipt,
    type TripReceipt, type TripStats, type TripScore, type TripSpendEntry, type TripSummary,
} from '../../../utils/tripsApi';
import { downloadReceiptImage, downloadReceiptImages } from '../../../utils/downloadReceipt';
import { ReceiptUploadSheet } from '../../../components/ReceiptUploadSheet';

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

    const [selectMode, setSelectMode] = useState(false);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [downloading, setDownloading] = useState(false);
    const [uploadSheet, setUploadSheet] = useState(false);

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

    // ── download ──────────────────────────────────────────────────────────
    const doDownloadOne = useCallback(async (r: TripReceipt) => {
        setDownloading(true);
        const ok = await downloadReceiptImage(r.id);
        setDownloading(false);
        Alert.alert(ok ? t('tripFinal.dlDoneTitle') : t('tripFinal.dlFailTitle'),
            ok ? t('tripFinal.dlDoneBody', { count: 1 }) : t('tripFinal.dlFailBody'));
    }, [t]);
    const doDownloadSelected = useCallback(async () => {
        const ids = [...selected];
        if (ids.length === 0) return;
        setDownloading(true);
        const n = await downloadReceiptImages(ids);
        setDownloading(false);
        setSelectMode(false); setSelected(new Set());
        Alert.alert(n > 0 ? t('tripFinal.dlDoneTitle') : t('tripFinal.dlFailTitle'),
            n > 0 ? t('tripFinal.dlDoneBody', { count: n }) : t('tripFinal.dlFailBody'));
    }, [selected, t]);
    const toggleSelected = (rid: number) => setSelected(prev => {
        const next = new Set(prev); next.has(rid) ? next.delete(rid) : next.add(rid); return next;
    });

    const onWrongReceipt = useCallback((r: TripReceipt) => {
        Alert.alert(t('tripReceipts.wrongTitle'), t('tripReceipts.wrongBody'), [
            { text: t('common.cancel'), style: 'cancel' },
            {
                text: t('tripReceipts.wrongConfirm'), style: 'destructive',
                onPress: async () => {
                    try { await detachTripReceipt(tripId, r.id); await load(); }
                    catch { Alert.alert(t('tripReceipts.wrongClosedTitle'), t('tripReceipts.wrongClosedBody')); }
                },
            },
        ]);
    }, [tripId, t, load]);

    const multi = (receipts?.length ?? 0) > 1;

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
        const storeSlices = uniqueLabels(stats.chainBreakdown.map(c => ({
            label: c.chainName, value: c.total, color: chainBrandColor(c.chainName),
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

        return [
            { key: 'cat', title: t('tripFinal.byCategory'), slices: catSlices, emptyText: t('profilis.noData') },
            { key: 'trips', title: t('tripFinal.byTrip'), slices: tripSlices, preselect: curIdx >= 0 ? curIdx : null, centerLabel: t('tripFinal.thisMonth'), emptyText: t('profilis.noData') },
            { key: 'store', title: t('tripFinal.byStore'), slices: storeSlices, emptyText: t('profilis.noData') },
        ];
    }, [stats, tripSpend, tripId, colors, t, i18n.language]);

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
                            <View style={styles.actionRow}>
                                <TouchableOpacity style={[styles.bigBtn, { flex: 1 }]} onPress={() => setUploadSheet(true)}>
                                    <Ionicons name="cloud-upload-outline" size={20} color={colors.onPrimary} />
                                    <Text style={styles.bigBtnText}>{t('tripReceipts.upload')}</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[styles.bigBtn, styles.bigBtnAlt]}
                                    onPress={() => { setSelectMode(m => !m); setSelected(new Set()); }}
                                >
                                    <Ionicons name={selectMode ? 'close' : 'download-outline'} size={20} color={colors.primary} />
                                    <Text style={[styles.bigBtnText, { color: colors.primary }]}>
                                        {selectMode ? t('common.cancel') : t('tripFinal.download')}
                                    </Text>
                                </TouchableOpacity>
                            </View>

                            {/* Receipt cards */}
                            <Text style={styles.secLbl}>{t('tripFinal.receiptsCount', { count: receipts.length })}</Text>
                            {receipts.map(r => (
                                <TouchableOpacity
                                    key={r.id}
                                    style={styles.rcard}
                                    activeOpacity={0.8}
                                    onPress={() => selectMode ? toggleSelected(r.id) : router.push(`/receipt-process?receiptId=${r.id}` as any)}
                                    onLongPress={() => onWrongReceipt(r)}
                                >
                                    {selectMode && (
                                        <View style={[styles.check, selected.has(r.id) && styles.checkOn]}>
                                            {selected.has(r.id) && <Ionicons name="checkmark" size={14} color={colors.onPrimary} />}
                                        </View>
                                    )}
                                    <ChainLogoChip chainId={r.chainId ?? chainIdByName(r.chainName ?? '') ?? 0} name={r.chainName ?? undefined} size={38} />
                                    <View style={{ flex: 1, minWidth: 0 }}>
                                        <Text style={styles.rstore} numberOfLines={1}>{r.chainName ?? r.storeName ?? `#${r.id}`}</Text>
                                        <Text style={styles.rsub} numberOfLines={1}>
                                            {[r.receiptDate ? formatDate(r.receiptDate) : null, t('tripFinal.itemsN', { count: r.items.length })].filter(Boolean).join(' · ')}
                                        </Text>
                                    </View>
                                    {!selectMode && <Text style={styles.rtot}>{formatEuro(receiptTotal(r))}</Text>}
                                    {!selectMode && (
                                        <TouchableOpacity onPress={() => doDownloadOne(r)} hitSlop={8} disabled={downloading}>
                                            <Ionicons name="download-outline" size={19} color={colors.textMuted} />
                                        </TouchableOpacity>
                                    )}
                                </TouchableOpacity>
                            ))}

                            {/* Identified items with store badge */}
                            <Text style={styles.secLbl}>{t('tripFinal.itemsSection')}</Text>
                            {receipts.flatMap(r => r.items.map(it => (
                                <View key={`${r.id}-${it.lineIdx}`} style={styles.itemRow}>
                                    <View style={styles.thumbWrap}>
                                        {it.storeProductImageUrl
                                            ? <Image source={{ uri: it.storeProductImageUrl }} style={styles.itemImage} />
                                            : <View style={[styles.itemImage, styles.itemImageEmpty]} />}
                                        {multi && (
                                            <View style={styles.itemBadge}>
                                                <ChainLogoChip chainId={r.chainId ?? chainIdByName(r.chainName ?? '') ?? 0} name={r.chainName ?? undefined} size={18} />
                                            </View>
                                        )}
                                    </View>
                                    <View style={{ flex: 1, minWidth: 0 }}>
                                        <Text style={styles.itemName} numberOfLines={1}>{it.matchedName ?? it.name}</Text>
                                        {it.quantity != null && it.quantity !== 1 && (
                                            <Text style={styles.itemMeta}>{it.quantity}{it.unit ? ` ${it.unit}` : ''}</Text>
                                        )}
                                    </View>
                                    {it.price != null && <Text style={styles.itemPrice}>{formatEuro(Number(it.price))}</Text>}
                                </View>
                            )))}
                        </ScrollView>
                    )
                )}

                {/* ── STATS PANE ── */}
                {tab === 'stats' && (
                    locked == null ? (
                        <View style={styles.centered}><MaterialProgress size="large" color={colors.primary} /></View>
                    ) : locked ? (
                        <View style={styles.centered}><Text style={styles.hint}>{t('tripMap.statsLocked')}</Text></View>
                    ) : stats ? (
                        <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + 92 }}>
                            {/* hero */}
                            <View style={styles.hero}>
                                <Text style={styles.heroLbl}>{t('trips.statSpent')}</Text>
                                <Text style={styles.heroVal}>{formatEuro(stats.totalSpent)}</Text>
                            </View>

                            {/* two mains */}
                            <View style={styles.mrow}>
                                <View style={styles.mcard}>
                                    <Text style={styles.mcap}>{stats.savings > 0 ? t('trips.statSaved') : stats.savings < 0 ? t('trips.statOverpaid') : t('tripFinal.avgPriceCap')}</Text>
                                    <Text style={[styles.mval, stats.savings > 0 && { color: colors.success }, stats.savings < 0 && { color: colors.error }]}>
                                        {stats.savings === 0 ? '—' : `${stats.savings > 0 ? '+' : '−'}${formatEuro(Math.abs(stats.savings))}`}
                                    </Text>
                                    <Text style={styles.mfoot}>{stats.savings === 0 ? t('tripFinal.avgPriceFoot') : t('tripFinal.vsAverage')}</Text>
                                </View>
                                <View style={styles.mcard}>
                                    <Text style={styles.mcap}>{t('tripFinal.planning')}</Text>
                                    <Text style={styles.mval}>
                                        {score?.score != null ? score.score : '—'}<Text style={styles.mvalSub}>{score?.score != null ? '/100' : ''}</Text>
                                    </Text>
                                    <Text style={styles.mfoot}>{t('tripFinal.planningFoot')}</Text>
                                </View>
                            </View>

                            {/* donut carousel */}
                            <View style={styles.donutCard}>
                                <DonutCarousel pages={donutPages} />
                            </View>

                            {/* extra metrics */}
                            <Text style={styles.secLbl}>{t('tripFinal.moreMetrics')}</Text>
                            <View style={styles.mrow}>
                                <View style={styles.mcard}>
                                    <Text style={styles.mcap}>{t('tripFinal.promoItems')}</Text>
                                    <Text style={styles.mval}>{stats.promoItemCount}</Text>
                                    <Text style={styles.mfoot}>{stats.promoSavings > 0 ? t('tripFinal.promoSaved', { amount: formatEuro(stats.promoSavings) }) : t('tripFinal.promoNone')}</Text>
                                </View>
                                <View style={styles.mcard}>
                                    <Text style={styles.mcap}>{t('tripFinal.impulse')}</Text>
                                    <Text style={styles.mval}>{score?.impulseCount ?? 0}</Text>
                                    <Text style={styles.mfoot}>{t('tripFinal.impulseFoot', { count: score?.impulseCount ?? 0 })}</Text>
                                </View>
                            </View>
                            <View style={styles.mrow}>
                                <View style={styles.mcard}>
                                    <Text style={styles.mcap}>{t('tripFinal.forgotten')}</Text>
                                    <Text style={styles.mval}>{score?.forgottenCount ?? 0}</Text>
                                    <Text style={styles.mfoot}>{t('tripFinal.forgottenFoot', { count: score?.forgottenCount ?? 0 })}</Text>
                                </View>
                                {prediction ? (
                                    <View style={styles.mcard}>
                                        <Text style={styles.mcap}>{t('tripFinal.prediction')}</Text>
                                        <Text style={[styles.mval, prediction.delta > 0 && { color: colors.error }, prediction.delta < 0 && { color: colors.success }]}>
                                            {prediction.delta === 0 ? '—' : `${prediction.delta > 0 ? '+' : '−'}${formatEuro(Math.abs(prediction.delta))}`}
                                        </Text>
                                        <Text style={styles.mfoot}>{prediction.accuracy != null ? t('tripFinal.predictionFoot', { pct: prediction.accuracy }) : ''}</Text>
                                    </View>
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
                                { key: 'stats', label: t('tripFinal.tabStats'), icon: 'stats-chart-outline', disabled: locked !== false, locked: locked !== false },
                            ]}
                            activeKey={tab}
                            onSelect={(k) => setTab(k as 'receipt' | 'stats')}
                        />
                    }
                />
            </View>

            {/* download selection footer */}
            {selectMode && tab === 'receipt' && (
                <View style={[styles.dlBar, { paddingBottom: insets.bottom + spacing.sm }]}>
                    <TouchableOpacity onPress={() => setSelected(new Set((receipts ?? []).map(r => r.id)))}>
                        <Text style={styles.dlAll}>{t('tripFinal.selectAll')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.dlBtn, selected.size === 0 && { opacity: 0.5 }]} onPress={doDownloadSelected} disabled={selected.size === 0 || downloading}>
                        {downloading ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.dlBtnText}>{t('tripFinal.downloadN', { count: selected.size })}</Text>}
                    </TouchableOpacity>
                </View>
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
    title: { flex: 1, fontSize: 22, fontWeight: '800', color: c.textPrimary },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg, padding: spacing.xl },
    hint: { fontSize: 13, color: c.textSecondary, textAlign: 'center', lineHeight: 20 },
    secLbl: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', color: c.textMuted, marginTop: spacing.lg, marginBottom: spacing.sm, marginHorizontal: spacing.lg },

    actionRow: { flexDirection: 'row', gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
    bigBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: c.primary, borderRadius: radius.lg, paddingVertical: 13, paddingHorizontal: spacing.lg },
    bigBtnAlt: { flex: 1, backgroundColor: c.cardBackground, borderWidth: 1, borderColor: c.primary },
    bigBtnText: { fontSize: 14.5, fontWeight: '700', color: c.onPrimary },

    rcard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: c.cardBackground, borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, padding: spacing.md, marginHorizontal: spacing.lg, marginBottom: spacing.sm },
    rstore: { ...typography.bodySmallStrong, color: c.textPrimary },
    rsub: { ...typography.labelSmall, color: c.textSecondary, marginTop: 2 },
    rtot: { ...typography.bodySmallStrong, fontVariant: ['tabular-nums'], color: c.textPrimary },
    check: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
    checkOn: { backgroundColor: c.primary, borderColor: c.primary },

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
    heroLbl: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', color: c.textMuted },
    heroVal: { fontSize: 38, fontWeight: '800', color: c.textPrimary, marginTop: 2, fontVariant: ['tabular-nums'] },
    mrow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.md },
    mcard: { flex: 1, backgroundColor: c.cardBackground, borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, padding: spacing.md },
    mcap: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: c.textMuted },
    mval: { fontSize: 22, fontWeight: '800', color: c.textPrimary, marginTop: 5, fontVariant: ['tabular-nums'] },
    mvalSub: { fontSize: 13, color: c.textMuted, fontWeight: '700' },
    mfoot: { fontSize: 11, color: c.textSecondary, marginTop: 4 },
    donutCard: { backgroundColor: c.cardBackground, borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.md },
    memberCard: { backgroundColor: c.cardBackground, borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, paddingHorizontal: spacing.md },
    memberRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
    memberDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
    memberName: { flex: 1, ...typography.bodySmall, fontWeight: '600', color: c.textPrimary },
    memberPaid: { ...typography.bodySmallStrong, fontVariant: ['tabular-nums'], color: c.textPrimary },
    memberDev: { ...typography.labelSmall, fontWeight: '800', fontVariant: ['tabular-nums'], minWidth: 54, textAlign: 'right' },


    // download footer
    dlBar: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.md, backgroundColor: c.cardBackground, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
    dlAll: { ...typography.bodySmallStrong, color: c.primary },
    dlBtn: { backgroundColor: c.primary, borderRadius: radius.pill, paddingVertical: spacing.sm, paddingHorizontal: spacing.xl, minWidth: 130, alignItems: 'center' },
    dlBtnText: { ...typography.bodySmallStrong, color: c.onPrimary },
});
