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
    View, Text, TouchableOpacity, StyleSheet, ScrollView, Image, Alert,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { MaterialProgress } from '@/components/MaterialProgress';
import { ProgressGlow } from '../../../components/ProgressGlow';
import { useReceiptQueueStore } from '../../../state/receiptQueueStore';
import { useTripSeenStore } from '../../../state/tripSeenStore';
import { ChainLogoChip } from '../../../components/ChainLogoChip';
import { UserAvatar } from '../../../components/UserAvatar';
import { ScreenBackButton } from '../../../components/ScreenBackButton';
import { GlassIconButton } from '../../../components/GlassIconButton';
import { IdentifyButton } from '../../../components/IdentifyButton';
import { GlassSheet } from '../../../components/GlassSheet';
import { ReceiptDetailSheet } from '../../../components/receipt/ReceiptDetailSheet';
import { PlanningSheet } from '../../../components/receipt/PlanningSheet';
import { SavingsSheet } from '../../../components/receipt/SavingsSheet';
import { DiscountsSheet } from '../../../components/receipt/DiscountsSheet';
import { PlanReconcileSheet, type PlanReconcileItem } from '../../../components/receipt/PlanReconcileSheet';
import { PredictionSheet } from '../../../components/receipt/PredictionSheet';
import { AnimatedNumber } from '../../../components/AnimatedNumber';
import { SwipeQueueOverlay } from '../../../components/swipe/SwipeQueueOverlay';
import { DonutCarousel, type DonutPage } from '../../../components/DonutCarousel';
import { chainIdByName, chainBrandColor, chainBrandName } from '../../../utils/chainBrandName';
import { formatDate , formatEuro } from '../../../utils/formatCurrency';
import { formatMonthKey } from '../../../utils/monthNames';
import { formatItemAmount } from '../../../utils/amountDisplay';
import { formatWeekday } from '../../../utils/formatDayDate';
import { ltPluralSuffix } from '../../../utils/ltPlural';
import { mergeReceiptItems, mergedQtyLabel, type MergedReceiptItem } from '../../../utils/mergeReceiptItems';
import Animated, { LinearTransition, FadeInDown } from 'react-native-reanimated';
import { ScanRevealRow, type ScanMode } from '../../../components/ScanRevealRow';
import { useTheme, spacing, radius, typography, type AppTheme } from '../../../constants/theme';
import { DockedGlassSheet } from '../../../components/DockedGlassSheet';
import { DockTabsRow } from '../../../components/FloatingPillTabBar';
import {
    fetchTrips, fetchTripReceipts, fetchTripStats, fetchTripScore, fetchMonthlyTripSpend,
    type TripReceipt, type TripStats, type TripScore, type TripSpendEntry, type TripSummary,
} from '../../../utils/tripsApi';
import { ReceiptUploadSheet } from '../../../components/ReceiptUploadSheet';
import { linkReceiptToList } from '../../../services/receiptProcessingService';
import { detachReceiptFromTrip } from '../../../utils/tripsApi';
import { getUserId } from '../../../config/user';
import { API_BASE_URL } from '../../../config/api';

// Donut palette for categories / trips (stores use chain brand colours).
const PALETTE = ['#EB6784', '#5EA29A', '#E8894D', '#6C8AE4', '#B07CD6', '#E0A93B', '#58B368', '#E06C9F', '#4CA0B3', '#C76B6B'];

const monthOf = (iso: string): string => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
// What the shopper actually paid = the receipt's printed footer total (combo/set-deal
// discounts land there, not on line prices). Fall back to the line-sum only when the
// printed total wasn't readable.
const receiptTotal = (r: TripReceipt): number =>
    r.printedTotal != null
        ? Number(r.printedTotal)
        : r.items.reduce((s, it) => s + (it.lineTotal != null ? Number(it.lineTotal) : (it.price != null ? Number(it.price) : 0)), 0);

/**
 * One identified-item row of the Kvitai pane. Memoised: `merged` is the union
 * of ALL line items across every trip receipt, and the screen re-renders on
 * queue progress ticks, tab flips and sheet toggles — without the memo every
 * one of those re-rendered every row. Props are primitives / stable objects,
 * so an unchanged row skips entirely (animMode/animDelay only flip during a
 * heal's staggered reveal).
 */
const MergedItemRow = memo(function MergedItemRow({ m, multi, animMode, animDelay, styles }: {
    m: MergedReceiptItem;
    multi: boolean;
    animMode: ScanMode | undefined;
    animDelay: number;
    styles: ReturnType<typeof makeStyles>;
}) {
    const qtyLabel = mergedQtyLabel(m);
    return (
        <Animated.View
            layout={LinearTransition.duration(360)}
            entering={animMode === 'inserted' ? FadeInDown.duration(340) : undefined}
        >
            <ScanRevealRow mode={animMode} delay={animDelay}>
                <View style={styles.itemRow}>
                    <View style={styles.thumbWrap}>
                        {m.imageUrl
                            ? <Image source={{ uri: m.imageUrl }} style={styles.itemImage} />
                            : <View style={[styles.itemImage, styles.itemImageEmpty]}><Text style={styles.itemBeet}>🫜</Text></View>}
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
                    {m.regularTotal > m.lineTotal + 0.005 ? (
                        // Discounted (line promo or combo/set-deal): struck regular over the paid net.
                        <View style={styles.itemPriceCol}>
                            <Text style={styles.itemRegularStrike}>{formatEuro(m.regularTotal)}</Text>
                            <Text style={[styles.itemPrice, styles.itemPricePromo]}>{formatEuro(m.lineTotal)}</Text>
                        </View>
                    ) : (
                        <Text style={styles.itemPrice}>{formatEuro(m.lineTotal)}</Text>
                    )}
                </View>
            </ScanRevealRow>
        </Animated.View>
    );
});

export default function TripFinalScreen() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { t, i18n } = useTranslation();
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { id, tab: tabParam, upload: uploadParam } = useLocalSearchParams<{ id: string; tab?: string; upload?: string }>();
    const tripId = Number(id);

    const [tab, setTab] = useState<'receipt' | 'stats'>(tabParam === 'stats' ? 'stats' : 'receipt');
    const [trip, setTrip] = useState<TripSummary | null>(null);
    const [receipts, setReceipts] = useState<TripReceipt[] | null>(null);
    const [stats, setStats] = useState<TripStats | null>(null);
    const [score, setScore] = useState<TripScore | null>(null);
    const [tripSpend, setTripSpend] = useState<TripSpendEntry[]>([]);
    const [locked, setLocked] = useState<boolean | null>(null);

    // ?upload=1 (the stage-4 "Įkelti kvitą" CTA) opens the capture sheet on
    // arrival — that CTA exists to upload, so don't make the user hunt for it.
    const [uploadSheet, setUploadSheet] = useState(uploadParam === '1');
    const [retakeReceiptId, setRetakeReceiptId] = useState<number | null>(null);
    const [voluntaryOpen, setVoluntaryOpen] = useState(false);
    // Voluntary identify-queue card count across the trip's receipts — the pink
    // CTA only shows when there's something to swipe (matching the other voluntary
    // entry points, which gate on the same endpoint). Per-receipt sum: any >0 means
    // the combined queue has cards.
    const [voluntaryCount, setVoluntaryCount] = useState(0);
    // Has the (slow) count resolved yet? Drives the button's loading pulse so the
    // CTA shows up immediately (breathing) rather than popping in seconds later.
    const [voluntaryCountLoaded, setVoluntaryCountLoaded] = useState(false);
    const voluntarySeqRef = useRef(0);
    const [sheetReceipt, setSheetReceipt] = useState<TripReceipt | null>(null);
    const [planningOpen, setPlanningOpen] = useState(false);
    const [savingsOpen, setSavingsOpen] = useState(false);
    const [discountsOpen, setDiscountsOpen] = useState(false);
    const [impulseOpen, setImpulseOpen] = useState(false);
    const [missedOpen, setMissedOpen] = useState(false);
    const [predictionOpen, setPredictionOpen] = useState(false);
    const [myId, setMyId] = useState<string | null>(null);
    useEffect(() => { void getUserId().then(setMyId); }, []);
    // Raises this trip's seen-receipts watermark (never lowers it).
    const markTripSeen = useTripSeenStore(s => s.markOpened);

    const load = useCallback(async () => {
        try {
            const rs = await fetchTripReceipts(tripId);
            setReceipts(rs);
            // Mark what the user has ACTUALLY seen. The watermark used to be written
            // only when the card was tapped, recording the count AT THAT MOMENT — so
            // finishing a list (0 receipts) stamped 0, and the upload you then made
            // right here pushed the count to 1, flagging your own receipt as "New"
            // the instant you left. Stamping it from the screen that displays them
            // means anything you looked at is seen; a receipt a HOUSEHOLD MEMBER adds
            // later still lifts the count above the watermark and flags correctly.
            markTripSeen(tripId, rs.length);
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
    }, [tripId, markTripSeen]);
    useFocusEffect(useCallback(() => { void load(); }, [load]));

    // A background heal (retake) of one of this trip's receipts just finished →
    // reload so the merged/renewed lines land (and drive the reveal animation).
    const queueItems = useReceiptQueueStore(s => s.items);
    const addQueueItems = useReceiptQueueStore(s => s.addItems);
    const removeQueueItem = useReceiptQueueStore(s => s.removeItem);
    const resolveStoreLink = useReceiptQueueStore(s => s.resolveStoreLink);
    const resolveStoreTrip = useReceiptQueueStore(s => s.resolveStoreTrip);

    // DEV-ONLY: re-run the whole OCR→parse→heal pipeline on the receipt's CACHED
    // photo (no camera). Downloads the stored image, then enqueues it exactly
    // like "Perfotografuoti" (a heal keyed to this receipt) — lets us test parser
    // changes (deskew) against the same image without re-photographing.
    const devRerunFromCache = useCallback(async (r: TripReceipt) => {
        try {
            const imageRes = await fetch(`${API_BASE_URL}/api/receipts/${r.id}/image`);
            const imageData = imageRes.ok ? await imageRes.json().catch(() => null) : null;
            const url = imageData?.url as string | undefined;
            if (!url) { Alert.alert('Dev re-run', 'No stored image URL for this receipt.'); return; }
            const objKey = url.split('?')[0].split('/').pop() || `receipt-${r.id}.jpg`;
            const localUri = `${FileSystem.cacheDirectory ?? ''}rerun-${Date.now()}-${objKey}`;
            const dl = await FileSystem.downloadAsync(url, localUri);
            if (dl.status !== 200) { Alert.alert('Dev re-run', `Download failed (${dl.status}).`); return; }
            const linkMap = trip && trip.slots.length > 0
                ? Object.fromEntries(trip.slots.map(s => [s.chainId ?? 0, s.listId]))
                : undefined;
            // DEV: full REPLACE (not heal-merge) so a parser change that only corrects an
            // already-priced line (e.g. removing a phantom discount) actually surfaces.
            addQueueItems([{ uris: [dl.uri], healReceiptId: r.id, devReplace: true, linkMap }]);
            Alert.alert('Dev re-run', 'Re-running the pipeline on the cached photo (heal). Watch the card progress.');
        } catch (e: any) {
            Alert.alert('Dev re-run', `Failed: ${e?.message ?? e}`);
        }
    }, [addQueueItems, trip]);
    const lastQueueDoneAt = useReceiptQueueStore(s => s.lastCompletedAt);
    useEffect(() => { if (lastQueueDoneAt) void load(); }, [lastQueueDoneAt, load]);
    // Receipt ids with an in-flight retake → show heal progress on their card.
    const healingReceiptIds = useMemo(() => new Set(
        queueItems.filter(q => q.healReceiptId != null
            && (q.status === 'processing' || q.status === 'pending' || q.status === 'awaiting_network'))
            .map(q => q.healReceiptId as number)), [queueItems]);

    // NEW (non-heal) uploads whose target list belongs to THIS trip → render a
    // placeholder receipt card with live progress (same shape as a real card)
    // so a fresh upload isn't invisible while it processes. No top banner.
    const tripListIds = useMemo(
        () => new Set((trip?.slots ?? []).map(s => s.listId).filter((n): n is number => n != null)),
        [trip]);
    // 'error' is INCLUDED: a failed upload must keep its card and explain itself.
    // Without it the card simply vanished mid-processing and the user was left
    // guessing whether the receipt had been accepted (it hadn't).
    const pendingUploads = useMemo(() => queueItems.filter(q =>
        q.healReceiptId == null
        && (q.status === 'processing' || q.status === 'pending'
            || q.status === 'awaiting_network' || q.status === 'error'
            || q.status === 'needs_date' || q.status === 'needs_store' || q.status === 'needs_link')
        && ((q.fallbackLinkId != null && tripListIds.has(q.fallbackLinkId))
            || (q.linkMap != null && Object.values(q.linkMap).some(lid => tripListIds.has(lid))))
    ), [queueItems, tripListIds]);

    // BACKSTOP: an upload aimed at THIS trip that finished attached somewhere
    // else (or nowhere). Before this, its progress card simply disappeared on
    // completion and the receipt turned up as a stray ad-hoc trip — the exact
    // shape of "it silently failed". Never let that be invisible again.
    const lastCompleted = useReceiptQueueStore(s => s.lastCompleted);
    const [detachedDismissed, setDetachedDismissed] = useState<number | null>(null);
    const detachedUpload = useMemo(() => {
        if (!lastCompleted) return null;
        if (detachedDismissed === lastCompleted.receiptId) return null;
        const aimedHere = lastCompleted.intendedListIds.some(lid => tripListIds.has(lid));
        if (!aimedHere) return null;
        const landedHere = lastCompleted.linkedListId != null && tripListIds.has(lastCompleted.linkedListId);
        return landedHere ? null : lastCompleted;
    }, [lastCompleted, tripListIds, detachedDismissed]);

    // Detach = "this receipt isn't part of this shopping". Confirmed, because it
    // moves the receipt out of every stat this trip shows.
    const confirmDetach = useCallback((r: TripReceipt) => {
        Alert.alert(
            t('tripReceipts.detachTitle'),
            t('tripReceipts.detachBody', { store: r.chainName ?? r.storeName ?? `#${r.id}` }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('tripReceipts.detachConfirm'),
                    style: 'destructive',
                    onPress: async () => {
                        const ok = await detachReceiptFromTrip(tripId, r.id);
                        if (ok) void load();
                        else Alert.alert(t('tripReceipts.detachTitle'), t('tripReceipts.detachFailed'));
                    },
                },
            ],
        );
    }, [tripId, t, load]);

    // Merged Kvitai item list + a per-key reveal assignment: when a heal changes
    // the data, diff vs the previous list — a changed line = 'refreshed', a new
    // key = 'inserted' — and stagger them so they scan in one at a time.
    // A receipt fails the footer-reconciliation check (Σ line paid ≠ printed
    // total by >10%) → its parsed lines are UNRELIABLE, so the derived stats
    // (Prognozė, Sutaupyta, planning) must be shown with a warning, not as
    // truth. Server sets `lowQuality`; we surface it here.
    const anyLowQuality = useMemo(() => (receipts ?? []).some(r => !!r.lowQuality), [receipts]);
    const merged = useMemo(() => mergeReceiptItems(receipts ?? []), [receipts]);
    // Discounted rows drive the "Prekės su akcija" card + sheet — a real discount is a
    // regular total above the paid one (line promos AND combo/set-deals, since
    // mergeReceiptItems folds the footer combo into the net lineTotal).
    const discounted = useMemo(() => merged.filter(m => m.regularTotal > m.lineTotal + 0.005), [merged]);
    const discountSavings = useMemo(
        () => Math.round(discounted.reduce((s, m) => s + (m.regularTotal - m.lineTotal), 0) * 100) / 100,
        [discounted],
    );
    const [mergedAnim, setMergedAnim] = useState<Map<string, { mode: ScanMode; order: number }>>(new Map());
    const prevSigRef = useRef<Map<string, string> | null>(null);
    useEffect(() => {
        const cur = new Map(merged.map(m => [m.key, `${m.name}|${m.lineTotal}|${m.imageUrl ?? ''}`]));
        const prev = prevSigRef.current;
        prevSigRef.current = cur;
        if (!prev) return; // first population — nothing to reveal
        const changed = new Map<string, { mode: ScanMode; order: number }>();
        let order = 0;
        for (const m of merged) {
            const sig = cur.get(m.key)!;
            if (!prev.has(m.key)) changed.set(m.key, { mode: 'inserted', order: order++ });
            else if (prev.get(m.key) !== sig) changed.set(m.key, { mode: 'refreshed', order: order++ });
        }
        if (changed.size === 0) return;
        setMergedAnim(changed);
        const to = setTimeout(() => setMergedAnim(new Map()), changed.size * 140 + 520 + 300);
        return () => clearTimeout(to);
    }, [merged]);

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

    // Sum the voluntary-queue-count across the trip's receipts (advisory UI — a
    // stale-drop seq guards racing refreshes). Any positive → the CTA is worth it.
    const refreshVoluntaryCount = useCallback(async () => {
        const ids = (receipts ?? []).map(r => r.id);
        if (ids.length === 0) { setVoluntaryCount(0); return; }
        const seq = ++voluntarySeqRef.current;
        try {
            const userId = await getUserId();
            const counts = await Promise.all(ids.map(async id => {
                try {
                    const res = await fetch(`${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/voluntary-queue-count?receiptId=${id}`);
                    if (!res.ok) return 0;
                    const data = await res.json();
                    return Number.isFinite(data?.count) ? Number(data.count) : 0;
                } catch { return 0; }
            }));
            if (seq === voluntarySeqRef.current) {
                setVoluntaryCount(counts.reduce((a, b) => a + b, 0));
                setVoluntaryCountLoaded(true);
            }
        } catch { if (seq === voluntarySeqRef.current) setVoluntaryCountLoaded(true); /* advisory */ }
    }, [receipts]);

    // Fetch the voluntary count ONCE per receipts-load (and after a session, via
    // onVoluntaryDone) — NOT on every Kvitai↔Statistika toggle. The count only
    // changes after a swipe, so re-running the (server-side) queue assembly on each
    // tab switch was pure waste (the repeated "RECEIPT … CARDING" logs).
    useEffect(() => {
        if (pendingSwipeIds.length === 0) void refreshVoluntaryCount();
    }, [refreshVoluntaryCount, pendingSwipeIds.length]);

    // Voluntary session end: reload now (the overlay closes, revealing the
    // still-mounted stats so figures/donut animate the delta) + a catch-up reload
    // a few seconds later — swipe votes POST on a 3s undo delay and the snapshot
    // recompute is async, so the last votes may not be in the immediate reload.
    const catchUpRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (catchUpRef.current) clearTimeout(catchUpRef.current); }, []);
    const onVoluntaryDone = useCallback(() => {
        setVoluntaryOpen(false);
        void load();
        void refreshVoluntaryCount();
        if (catchUpRef.current) clearTimeout(catchUpRef.current);
        catchUpRef.current = setTimeout(() => { void load(); void refreshVoluntaryCount(); }, 4500);
    }, [load, refreshVoluntaryCount]);

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
            meta: formatItemAmount({ quantity: li.quantity, isWeighable: li.isWeighable, unit: li.packUnit, packAmount: li.packAmount, canonicalStep: li.canonicalStep }), ok: li.bought,
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
                    {/* Stats tab: a pink CTA to swipe the voluntary identify-queue —
                        users help match receipt items to products. */}
                    {tab === 'stats' && !voluntaryOpen && pendingSwipeIds.length === 0 && (voluntaryCount > 0 || !voluntaryCountLoaded) && (
                        <IdentifyButton
                            loading={!voluntaryCountLoaded}
                            onPress={() => { if (voluntaryCount > 0) setVoluntaryOpen(true); }}
                            titleTop={t('tripFinal.identifyTop')}
                            titleBottom={t('tripFinal.identifyBottom')}
                            accessibilityLabel={t('tripFinal.helpIdentify')}
                        />
                    )}
                </View>

                {/* ── RECEIPT PANE ── */}
                {tab === 'receipt' && (
                    receipts == null ? (
                        <View style={styles.centered}><MaterialProgress size="large" color={colors.primary} /></View>
                    ) : receipts.length === 0 && pendingUploads.length === 0 ? (
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
                            <Text style={styles.sectionTitle}>{t('tripFinal.receiptsCount', { count: receipts.length + pendingUploads.length })}</Text>
                            {/* BACKSTOP: the upload finished but not on THIS trip. Say so —
                                the old behaviour was the progress card simply vanishing. */}
                            {detachedUpload && (
                                <View style={[styles.rcard, { borderColor: colors.primary }]}>
                                    <View style={styles.pendingIcon}>
                                        <Ionicons name="information-circle-outline" size={20} color={colors.primary} />
                                    </View>
                                    <View style={{ flex: 1, minWidth: 0 }}>
                                        <Text style={styles.rstore} numberOfLines={1}>{t('tripReceipts.detachedTitle')}</Text>
                                        <Text style={styles.rsub} numberOfLines={2}>{t('tripReceipts.detachedBody')}</Text>
                                    </View>
                                    <TouchableOpacity
                                        onPress={() => setDetachedDismissed(detachedUpload.receiptId)}
                                        hitSlop={8}
                                        accessibilityLabel={t('common.close')}
                                    >
                                        <Ionicons name="close" size={18} color={colors.textSecondary} />
                                    </TouchableOpacity>
                                </View>
                            )}
                            {/* Placeholder cards for a fresh upload still processing — same shape
                                as a real receipt card, with a spinner + bottom progress glow. */}
                            {pendingUploads.map(q => {
                                const frac = q.progressTotal
                                    ? Math.max(0.05, Math.min(1, (q.progressDone ?? 0) / q.progressTotal))
                                    : 0.08;
                                // FAILED upload: say what went wrong ON the card and offer a
                                // retry, instead of the card quietly disappearing.
                                if (q.status === 'error') {
                                    return (
                                        <View key={`pending-${q.id}`} style={styles.rcard}>
                                            <View style={styles.pendingIcon}>
                                                <Ionicons name="alert-circle-outline" size={20} color={colors.error} />
                                            </View>
                                            <View style={{ flex: 1, minWidth: 0 }}>
                                                <Text style={styles.rstore} numberOfLines={1}>{t('tripReceipts.failedTitle')}</Text>
                                                <Text style={styles.rsub} numberOfLines={2}>
                                                    {q.error || t('tripReceipts.failedGeneric')}
                                                </Text>
                                            </View>
                                            <TouchableOpacity
                                                style={styles.retryBtn}
                                                onPress={() => {
                                                    // Drop the failed row and open the CAPTURE sheet. Replaying the
                                                    // same pixels would just fail the same way — the photo itself is
                                                    // usually the problem (blurred, cropped, badly oriented), so the
                                                    // useful retry is a NEW capture or file.
                                                    removeQueueItem(q.id);
                                                    setUploadSheet(true);
                                                }}
                                                hitSlop={8}
                                            >
                                                <Ionicons name="refresh" size={14} color={colors.onPrimary} />
                                                <Text style={styles.retryBtnText}>{t('tripReceipts.retry')}</Text>
                                            </TouchableOpacity>
                                            <TouchableOpacity onPress={() => removeQueueItem(q.id)} hitSlop={8}>
                                                <Ionicons name="close" size={18} color={colors.textSecondary} />
                                            </TouchableOpacity>
                                        </View>
                                    );
                                }
                                // PARKED, not failed. needs_store: the receipt is from a
                                // store this trip didn't plan — the obvious answer HERE is
                                // "yes, it belongs to this trip", so offer that directly
                                // (the Shopping card offers the per-store choice).
                                // needs_link: the receipt saved but never attached — retry
                                // just the link, no re-scan.
                                if (q.status === 'needs_store' || q.status === 'needs_link') {
                                    return (
                                        <View key={`pending-${q.id}`} style={styles.rcard}>
                                            <View style={styles.pendingIcon}>
                                                <Ionicons name="help-circle-outline" size={20} color={colors.primary} />
                                            </View>
                                            <View style={{ flex: 1, minWidth: 0 }}>
                                                <Text style={styles.rstore} numberOfLines={1}>
                                                    {q.status === 'needs_store'
                                                        ? t('receiptQueue.needsStoreTitle')
                                                        : t('receiptQueue.linkFailedTitle')}
                                                </Text>
                                                <Text style={styles.rsub} numberOfLines={2}>
                                                    {q.status === 'needs_store'
                                                        ? t('receiptQueue.needsStore')
                                                        : t('receiptQueue.linkFailed')}
                                                </Text>
                                            </View>
                                            <TouchableOpacity
                                                style={styles.retryBtn}
                                                onPress={() => {
                                                    if (q.status === 'needs_store') {
                                                        // The receipt's chain matches a planned store → that
                                                        // slot. Otherwise it joins the TRIP with no slot: it
                                                        // is part of this shopping, but it fulfils nobody's
                                                        // plan, and saying otherwise marks the wrong store done.
                                                        const chainSlot = (q.linkOptions ?? []).find(
                                                            o => o.chainId === q.linkDetectedChainId && tripListIds.has(o.listId));
                                                        if (chainSlot) resolveStoreLink(q.id, chainSlot.listId);
                                                        else resolveStoreTrip(q.id, tripId);
                                                        return;
                                                    }
                                                    if (q.linkReceiptId != null && q.linkListId != null) {
                                                        void linkReceiptToList(q.linkListId, q.linkReceiptId)
                                                            .then(ok => { if (ok) { removeQueueItem(q.id); void load(); } });
                                                    }
                                                }}
                                                hitSlop={8}
                                            >
                                                <Ionicons name="link-outline" size={14} color={colors.onPrimary} />
                                                <Text style={styles.retryBtnText}>{t('tripReceipts.attachHere')}</Text>
                                            </TouchableOpacity>
                                            <TouchableOpacity onPress={() => removeQueueItem(q.id)} hitSlop={8}>
                                                <Ionicons name="close" size={18} color={colors.textSecondary} />
                                            </TouchableOpacity>
                                        </View>
                                    );
                                }
                                return (
                                    <View key={`pending-${q.id}`} style={styles.rcard}>
                                        <View style={styles.pendingIcon}>
                                            <Ionicons name="receipt-outline" size={20} color={colors.textMuted} />
                                        </View>
                                        <View style={{ flex: 1, minWidth: 0 }}>
                                            <Text style={styles.rstore} numberOfLines={1}>{t('tripReceipts.processingTitle')}</Text>
                                            <Text style={styles.rsub} numberOfLines={1}>{q.progress || t('tripReceipts.processing')}</Text>
                                        </View>
                                        <MaterialProgress size="small" color={colors.primary} />
                                        <ProgressGlow edge="bottom" fraction={frac} />
                                    </View>
                                );
                            })}
                            {receipts.map(r => {
                                const healItem = queueItems.find(q => q.healReceiptId === r.id
                                    && (q.status === 'processing' || q.status === 'pending' || q.status === 'awaiting_network'));
                                const healFraction = healItem?.progressTotal
                                    ? Math.max(0.05, Math.min(1, (healItem.progressDone ?? 0) / healItem.progressTotal))
                                    : 0.08;
                                return (
                                <TouchableOpacity
                                    key={r.id}
                                    style={styles.rcard}
                                    activeOpacity={0.8}
                                    onPress={() => setSheetReceipt(r)}
                                    // A wrong attach had no undo — the only way out was
                                    // linking it somewhere else. Long-press detaches
                                    // (server enforces owner / 7-day uploader window).
                                    onLongPress={() => confirmDetach(r)}
                                    delayLongPress={450}
                                >
                                    <View>
                                        <ChainLogoChip chainId={r.chainId ?? chainIdByName(r.chainName ?? '') ?? 0} name={r.chainName ?? undefined} size={38} />
                                        {!!r.staleReceipt && (
                                            <View style={styles.staleBadge}>
                                                <Ionicons name="alert" size={11} color={colors.onPrimary} />
                                            </View>
                                        )}
                                        {!r.staleReceipt && !!r.lowQuality && !healItem && (
                                            <View style={styles.scanBadge}>
                                                <Ionicons name="scan" size={10} color="#FFFFFF" />
                                            </View>
                                        )}
                                    </View>
                                    <View style={{ flex: 1, minWidth: 0 }}>
                                        <Text style={styles.rstore} numberOfLines={1}>{r.chainName ?? r.storeName ?? `#${r.id}`}</Text>
                                        <Text style={styles.rsub} numberOfLines={1}>
                                            {healItem
                                                ? (healItem.progress || t('retake.healing'))
                                                : [r.receiptDate ? formatDate(r.receiptDate) : null, t(`items.count_${ltPluralSuffix(r.items.length)}`, { count: r.items.length })].filter(Boolean).join(' · ')}
                                        </Text>
                                    </View>
                                    {healItem
                                        ? <MaterialProgress size="small" color={colors.primary} />
                                        : <><Text style={styles.rtot}>{formatEuro(receiptTotal(r))}</Text>
                                            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} /></>}
                                    {/* Heal-in-progress → bottom-edge progress glow on the card. */}
                                    {healItem && <ProgressGlow edge="bottom" fraction={healFraction} />}
                                </TouchableOpacity>
                                );
                            })}
                            {/* DEV: re-run the pipeline on the CACHED photo (test parser
                                changes without re-photographing). __DEV__ only. */}
                            {__DEV__ && receipts.filter(r => !healingReceiptIds.has(r.id)).map(r => (
                                <TouchableOpacity key={`dev-rerun-${r.id}`} style={styles.devRerunBtn} onPress={() => devRerunFromCache(r)} activeOpacity={0.7}>
                                    <Ionicons name="refresh" size={14} color={colors.textSecondary} />
                                    <Text style={styles.devRerunText}>{`DEV · re-run + REPLACE #${r.id} (cached photo)`}</Text>
                                </TouchableOpacity>
                            ))}
                            {/* Low-quality scan → offer a retake that HEALS the receipt.
                                Hidden while THIS receipt is already being healed. */}
                            {receipts.filter(r => r.lowQuality && !healingReceiptIds.has(r.id)).map(r => (
                                <View key={`rt-${r.id}`} style={styles.retakeBanner}>
                                    <Ionicons name="scan-outline" size={20} color={colors.primary} />
                                    <View style={{ flex: 1, minWidth: 0 }}>
                                        <Text style={styles.retakeTitle}>{t('retake.bannerTitle')}</Text>
                                        <Text style={styles.retakeSub} numberOfLines={1}>{t('retake.bannerSub', { count: r.unmatchedCount ?? 0 })}</Text>
                                    </View>
                                    <TouchableOpacity style={styles.retakeBtn} onPress={() => setRetakeReceiptId(r.id)} hitSlop={6}>
                                        <Text style={styles.retakeBtnText}>{t('retake.action')}</Text>
                                    </TouchableOpacity>
                                </View>
                            ))}

                            {/* Identified items — duplicate/same-product lines merged;
                                the price shown is the ACTUAL paid (promo-adjusted). */}
                            <Text style={styles.sectionTitle}>{`${t('tripFinal.itemsSection')} · ${merged.length}`}</Text>
                            {merged.map(m => {
                                const a = mergedAnim.get(m.key);
                                return (
                                    <MergedItemRow
                                        key={m.key}
                                        m={m}
                                        multi={multi}
                                        animMode={a?.mode}
                                        animDelay={(a?.order ?? 0) * 140}
                                        styles={styles}
                                    />
                                );
                            })}
                        </ScrollView>
                    )
                )}

                {/* ── STATS PANE ── */}
                {tab === 'stats' && (
                    <>
                    {locked == null ? (
                        <View style={styles.centered}><MaterialProgress size="large" color={colors.primary} /></View>
                    ) : pendingSwipeIds.length > 0 ? (
                        // Mandatory swipe queue: same overlay presentation as the
                        // voluntary flow below (shared <SwipeQueueOverlay> → identical
                        // ScreenNavBar). Clears in-place, then reloads into the stats.
                        <SwipeQueueOverlay
                            receiptIds={pendingSwipeIds}
                            voluntary={false}
                            onAllDone={() => { void load(); }}
                            onExit={() => setTab('receipt')}
                        />
                    ) : locked ? (
                        <View style={styles.centered}><Text style={styles.hint}>{t('tripMap.statsLocked')}</Text></View>
                    ) : stats ? (
                        <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + 92 }}>
                            {/* hero */}
                            <View style={styles.hero}>
                                <AnimatedNumber value={stats.totalSpent} format={formatEuro} style={styles.heroVal} />
                                <Text style={styles.heroLbl}>{t('trips.statSpent')}</Text>
                            </View>

                            {/* Reconciliation warning — DEV ONLY. It fires on heuristics
                                (unmatched-line fraction, a gap vs the printed total)
                                that have legitimate causes we now model one by one:
                                set deals, and loyalty money paid off an earned
                                balance. Until it stops crying wolf it's a developer
                                signal, not something to put in front of a shopper. */}
                            {__DEV__ && anyLowQuality && (
                                <View style={styles.qualityWarn}>
                                    <Ionicons name="warning-outline" size={16} color={colors.onWarning ?? colors.onPrimary} />
                                    <Text style={styles.qualityWarnText} numberOfLines={3}>{t('tripReceipts.statsLowQuality')}</Text>
                                </View>
                            )}

                            {/* two mains */}
                            <View style={styles.mrow}>
                                {/* Cross-store headline — MUST match the SavingsSheet it opens
                                    (paid vs the median alternative basket). Using the per-item
                                    `savings` here said "+0,14 saved" while the sheet showed the
                                    most-expensive store; savedVsMedian is the same basis, so the
                                    sign can't contradict the detail. */}
                                <TouchableOpacity style={styles.mcard} activeOpacity={0.7} onPress={() => setSavingsOpen(true)}>
                                    <View style={styles.mcapRow}>
                                        <Text style={styles.mcap}>{stats.savedVsMedian == null ? t('tripFinal.avgPriceCap') : stats.savedVsMedian > 0 ? t('trips.statSaved') : stats.savedVsMedian < 0 ? t('trips.statOverpaid') : t('tripFinal.avgPriceCap')}</Text>
                                        <Ionicons name="chevron-forward" size={13} color={colors.textMuted} />
                                    </View>
                                    <AnimatedNumber
                                        value={stats.savedVsMedian ?? 0}
                                        format={(n) => Math.abs(n) < 0.005 ? '—' : `${n > 0 ? '+' : '−'}${formatEuro(Math.abs(n))}`}
                                        style={[styles.mval, (stats.savedVsMedian ?? 0) > 0 && { color: colors.success }, (stats.savedVsMedian ?? 0) < 0 && { color: colors.error }]}
                                    />
                                    <Text style={styles.mfoot}>{stats.savedVsMedian == null ? t('tripFinal.avgPriceFoot') : t('tripFinal.vsAverage')}</Text>
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
                                        {score?.score != null
                                            ? <><AnimatedNumber value={score.score} format={(n) => String(Math.round(n))} /><Text style={styles.mvalSub}>/100</Text></>
                                            : '—'}
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
                                    activeOpacity={discounted.length > 0 ? 0.7 : 1}
                                    onPress={() => { if (discounted.length > 0) setDiscountsOpen(true); }}
                                >
                                    <View style={styles.mcapRow}>
                                        <Text style={styles.mcap}>{t('tripFinal.promoItems')}</Text>
                                        {discounted.length > 0 && <Ionicons name="chevron-forward" size={13} color={colors.textMuted} />}
                                    </View>
                                    <AnimatedNumber value={discounted.length} format={(n) => String(Math.round(n))} style={styles.mval} />
                                    <Text style={styles.mfoot}>{discountSavings > 0 ? t('tripFinal.promoSaved', { amount: formatEuro(discountSavings) }) : t('tripFinal.promoNone')}</Text>
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
                                    <AnimatedNumber value={score?.impulseCount ?? 0} format={(n) => String(Math.round(n))} style={styles.mval} />
                                    <Text style={styles.mfoot}>{t('tripFinal.impulseFoot', { count: score?.impulseCount ?? 0 })}</Text>
                                </TouchableOpacity>
                            </View>
                            {/* Praleistos (missed) is plan-relative — hidden for trips with no
                                planning; prediction likewise only shows with a priced plan, so
                                the whole row drops for a plan-less (ad-hoc) trip. */}
                            {(score?.hasList || prediction) && (
                            <View style={styles.mrow}>
                                {score?.hasList ? (
                                <TouchableOpacity
                                    style={styles.mcard}
                                    activeOpacity={missedItems.length > 0 ? 0.7 : 1}
                                    onPress={() => { if (missedItems.length > 0) setMissedOpen(true); }}
                                >
                                    <View style={styles.mcapRow}>
                                        <Text style={styles.mcap}>{t('tripFinal.forgotten')}</Text>
                                        {missedItems.length > 0 && <Ionicons name="chevron-forward" size={13} color={colors.textMuted} />}
                                    </View>
                                    <AnimatedNumber value={score?.forgottenCount ?? 0} format={(n) => String(Math.round(n))} style={styles.mval} />
                                    <Text style={styles.mfoot}>{t('tripFinal.forgottenFoot', { count: score?.forgottenCount ?? 0 })}</Text>
                                </TouchableOpacity>
                                ) : <View style={{ flex: 1 }} />}
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
                            )}

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
                        // Reached only when the trip is UNLOCKED (receipts exist) but the stats
                        // fetch is still in flight — load() sets locked=false before stats arrive.
                        // Show a spinner, not the "įkėlus kvitą" locked copy that briefly flashed.
                        <View style={styles.centered}><MaterialProgress size="large" color={colors.primary} /></View>
                    )}
                    {/* Voluntary identify-queue as an OVERLAY over the (still-mounted)
                        stats content, so closing it reveals the refreshed figures + donut
                        animating the change instead of a cold remount. Shares the exact
                        <SwipeQueueOverlay> the mandatory queue above uses. */}
                    {voluntaryOpen && (
                        <SwipeQueueOverlay
                            receiptIds={receipts?.map(r => String(r.id)) ?? []}
                            voluntary
                            onAllDone={onVoluntaryDone}
                            onExit={() => { setVoluntaryOpen(false); void refreshVoluntaryCount(); }}
                        />
                    )}
                    </>
                )}

                {/* Pane switcher (bottom-left) — THE shared glass dock in its compact
                    form (same blur/tint/rim/shadow/corners as the main nav + map
                    bars, via DockedGlassSheet). Stats is gated until unlock. Hidden
                    while the voluntary swipe overlay covers the screen — switching
                    panes under it would be invisible and confusing. */}
                {!voluntaryOpen && !(tab === 'stats' && pendingSwipeIds.length > 0) && <DockedGlassSheet
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
                />}
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
                    <PredictionSheet score={score} lowQuality={anyLowQuality} />
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
            {/* Retake → the SAME Take-photo/Upload sheet, but heals this receipt. */}
            <ReceiptUploadSheet
                visible={retakeReceiptId != null}
                onClose={() => setRetakeReceiptId(null)}
                healReceiptId={retakeReceiptId ?? undefined}
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

    rcard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: c.cardBackground, borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, padding: spacing.md, marginHorizontal: spacing.lg, marginBottom: spacing.sm, overflow: 'hidden' },
    pendingIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: c.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
    retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: c.primary, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 6 },
    retryBtnText: { fontSize: 12, fontWeight: '800', color: c.onPrimary },
    rstore: { ...typography.bodySmallStrong, color: c.textPrimary },
    rsub: { ...typography.labelSmall, color: c.textSecondary, marginTop: 2 },
    rtot: { ...typography.bodySmallStrong, fontVariant: ['tabular-nums'], color: c.textPrimary },
    // Red "old receipt" badge riding the store logo's corner (all users see it).
    staleBadge: {
        position: 'absolute', top: -4, right: -4, width: 18, height: 18, borderRadius: 9,
        backgroundColor: c.error, alignItems: 'center', justifyContent: 'center',
        borderWidth: 2, borderColor: c.cardBackground,
    },
    // Passive low-scan-quality hint on the receipt card corner (amber, camera).
    scanBadge: {
        position: 'absolute', top: -4, right: -4, width: 18, height: 18, borderRadius: 9,
        backgroundColor: '#E39A17', alignItems: 'center', justifyContent: 'center',
        borderWidth: 2, borderColor: c.cardBackground,
    },
    // Retake banner — a low-quality scan can be improved by re-shooting.
    retakeBanner: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
        backgroundColor: c.primaryMuted ?? c.surfaceMuted, borderRadius: radius.lg,
        borderWidth: 1, borderColor: c.primary,
        padding: spacing.md, marginHorizontal: spacing.lg, marginBottom: spacing.sm,
    },
    qualityWarn: {
        flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm,
        backgroundColor: c.warning ?? c.error, borderRadius: radius.md,
        paddingVertical: spacing.sm, paddingHorizontal: spacing.md, marginBottom: spacing.md,
    },
    devRerunBtn: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
        borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, borderStyle: 'dashed',
        borderRadius: radius.md, paddingVertical: spacing.sm, paddingHorizontal: spacing.md,
        marginHorizontal: spacing.lg, marginBottom: spacing.sm,
    },
    devRerunText: { ...typography.labelSmall, color: c.textSecondary },
    qualityWarnText: { flex: 1, ...typography.labelSmall, color: c.onWarning ?? c.onPrimary, lineHeight: 17 },
    retakeTitle: { fontSize: 14, fontWeight: '800', color: c.textPrimary },
    retakeSub: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
    retakeBtn: { backgroundColor: c.primary, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 7 },
    retakeBtnText: { fontSize: 13, fontWeight: '800', color: c.onPrimary },

    itemRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
    thumbWrap: { width: 40, height: 40 },
    itemImage: { width: 40, height: 40, borderRadius: 10 },
    itemImageEmpty: { backgroundColor: c.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
    itemBeet: { fontSize: 20, opacity: 0.5 },
    itemBadge: { position: 'absolute', top: -5, left: -5, borderRadius: 11, padding: 1.5, backgroundColor: c.cardBackground },
    itemName: { ...typography.bodySmall, fontWeight: '600', color: c.textPrimary },
    itemMeta: { ...typography.labelSmall, color: c.textSecondary, marginTop: 1 },
    itemPrice: { ...typography.bodySmall, fontWeight: '700', color: c.textPrimary },
    itemPriceCol: { alignItems: 'flex-end' },
    itemRegularStrike: { ...typography.labelSmall, color: c.textMuted, textDecorationLine: 'line-through' },
    itemPricePromo: { color: c.primary },

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

});
