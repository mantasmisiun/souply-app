/**
 * Apsipirkimai tab (Souply 2.0 Phase 4): the trips list. Each card is one
 * Apsipirkimas with its DERIVED stage (server: tripListService) and the
 * stage's single CTA; archived trips live in a collapsed "Archyvas" section
 * (tap = explicit resume). The "Sukurti šeimos sąrašą" card at the top mints
 * the household + its invite QR (spec: one household per user).
 *
 * Interim navigation: CTAs point at the existing basket/list/receipt
 * screens until the trip-map surface (MapHost sheet mode) lands.
 */
import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    RefreshControl,
    Modal,
    Alert,
    Platform,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import Animated, { LinearTransition, withTiming, Easing } from 'react-native-reanimated';
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import { ScreenHeading } from '../../../components/ScreenHeading';
import { useCollapsingHeader, CollapsingHeader } from '../../../components/CollapsingHeader';
import { useBackToExit } from '../../../hooks/useBackToExit';
import { useReceiptQueueStore, type QueueItem } from '../../../state/receiptQueueStore';
import { useTripSeenStore, isTripNew } from '../../../state/tripSeenStore';
import { ChainLogoChip } from '../../../components/ChainLogoChip';
import { ProgressGlow } from '../../../components/ProgressGlow';
import { requestStoreResolution } from '../../../utils/storeResolution';
import { chainNameById, chainBrandColorById } from '../../../utils/chainBrandName';
import { linkReceiptToList } from '../../../services/receiptProcessingService';
import { StoreResolutionOverlay } from '../../../components/receipt/StoreResolutionOverlay';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useTranslation } from 'react-i18next';
import { API_BASE_URL } from '../../../config/api';
import { useSafeBottomTabBarHeight } from '../../../hooks/useSafeBottomTabBarHeight';
import { getUserId } from '../../../config/user';
import { useBasketState } from '../../../state/basketState';
import { useTheme, radius, spacing, type AppTheme } from '../../../constants/theme';
import { ScalePressable } from '../../../components/ScalePressable';
import { UserAvatar } from '../../../components/UserAvatar';
import { SkeletonBox } from '../../../components/SkeletonBox';
import { formatDate } from '../../../utils/formatCurrency';
import { formatWeekday } from '../../../utils/formatDayDate';
import CalendarBadge from '../../../components/CalendarBadge';
import { useShoppingSheet } from '../../../state/shoppingSheet';
import { buildReceiptDotMap, parseLooseDate, sameDay } from '../../../utils/receiptDots';
import {
    fetchTrips, unarchiveTrip, fetchOwnHousehold,
    type TripSummary, type HouseholdInfo,
} from '../../../utils/tripsApi';
import { tripStageHref } from '../../../utils/tripStageRoute';
import { ShoppingFilterChips } from '../../../components/basket/ShoppingFilterChips';
import { shouldRefetchOnFocus } from '../../../utils/focusStaleness';

const AnimatedTouchable = Animated.createAnimatedComponent(TouchableOpacity);

/** Card removal: a clean, quick fade + slight shrink — no overshoot. */
function cardExit() {
    'worklet';
    return {
        initialValues: { opacity: 1, transform: [{ scale: 1 }] },
        animations: {
            opacity: withTiming(0, { duration: 200, easing: Easing.in(Easing.quad) }),
            transform: [{ scale: withTiming(0.94, { duration: 200, easing: Easing.in(Easing.quad) }) }],
        },
    };
}

const STAGE_ICONS: Record<number, keyof typeof Ionicons.glyphMap> = {
    1: 'cart-outline', 2: 'storefront-outline', 3: 'list-outline', 4: 'receipt-outline', 5: 'stats-chart-outline',
};

/** Flattened, virtualisable rows (same pattern as app/shopping-list/index.tsx
 *  and ShoppingListDetail): every card used to mount at once inside an
 *  Animated.ScrollView, which is what made switching to this tab feel slow. */
type TripRow =
    | { kind: 'processing'; key: string; item: QueueItem }
    | { kind: 'trip'; key: string; trip: TripSummary }
    | { kind: 'empty'; key: string }
    | { kind: 'archiveHeader'; key: string }
    | { kind: 'archived'; key: string; trip: TripSummary; isLast: boolean };
const tripRowKey = (r: TripRow) => r.key;

/** One list-level transition (FlatList itemLayoutAnimation) replaces the old
 *  per-card `layout` prop — identical 240ms cubic-out motion, but Reanimated
 *  no longer snapshots every card on mount. */
const rowLayout = LinearTransition.duration(240).easing(Easing.out(Easing.cubic));

/** Overlapping member-avatar circles for a shared card (up to 3 + "+N"). */
function MemberStack({ members, total, styles }: {
    members: { initial: string; color: string | null }[];
    total: number;
    styles: ReturnType<typeof makeStyles>;
}) {
    const shown = members.slice(0, 3);
    const extra = total - shown.length;
    return (
        <View style={styles.memberStack}>
            {shown.map((m, i) => (
                <View key={i} style={i > 0 ? styles.memberOverlap : undefined}>
                    <UserAvatar name={m.initial} color={m.color} size={22} style={styles.memberRing} />
                </View>
            ))}
            {extra > 0 && (
                <View style={[styles.memberOverlap, styles.memberMore]}>
                    <Text style={styles.memberMoreText}>+{extra}</Text>
                </View>
            )}
        </View>
    );
}

/** In-flight receipt-queue item as a card shaped like a trip card, with a
 *  bottom-edge progress glow + status line. Only shown on the Shopping screen;
 *  the work itself runs in the global background queue. */
function ProcessingCard({ item, onResolveStore }: { item: QueueItem; onResolveStore?: (item: QueueItem) => void }) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const isError = item.status === 'error';
    // PARKED for a missing purchase date: the scan is fine, only the date didn't
    // read. Ask for it here rather than defaulting to today — a receipt from last
    // week would otherwise land on the wrong day with no hint to the user.
    const needsDate = item.status === 'needs_date';
    // PARKED because the receipt's chain isn't one of the trip's planned stores
    // (planned Maxima + Lidl, shopped at IKI). Silently dropping the link is what
    // made a perfectly parsed receipt vanish into its own ad-hoc trip.
    const needsStoreChoice = item.status === 'needs_store';
    // PARKED after saving: the receipt exists but never attached to its list.
    const needsLink = item.status === 'needs_link';
    const [linking, setLinking] = useState(false);
    const [showPicker, setShowPicker] = useState(false);
    const resolveDate = useReceiptQueueStore.getState().resolveDate;
    const resolveStoreLink = useReceiptQueueStore.getState().resolveStoreLink;
    const retryLink = useCallback(async () => {
        if (item.linkReceiptId == null || item.linkListId == null) return;
        setLinking(true);
        const ok = await linkReceiptToList(item.linkListId, item.linkReceiptId);
        setLinking(false);
        // Success clears the card; failure leaves it so the user can try again.
        if (ok) useReceiptQueueStore.getState().removeItem(item.id);
    }, [item.id, item.linkReceiptId, item.linkListId]);
    // Recoverable store_unrecognized failure → offer the "Rasti parduotuvę" map.
    const needsStore = isError && item.errorReason === 'store_unrecognized' && item.storeChainId != null;
    const fraction = item.progressTotal && item.progressTotal > 0
        ? Math.max(0.05, Math.min(1, (item.progressDone ?? 0) / item.progressTotal))
        : 0.08;
    const title = needsDate ? t('receiptQueue.needsDateTitle')
        : needsStoreChoice ? t('receiptQueue.needsStoreTitle')
        : needsLink ? t('receiptQueue.linkFailedTitle')
        : isError ? (item.error || t('banners.receiptQueue.error'))
        : t('banners.receiptQueue.processing');
    const status = item.progress
        ?? (item.status === 'pending' ? t('banners.receiptQueue.queued', { count: 1 })
            : item.status === 'awaiting_network' ? t('banners.receiptQueue.awaitingNetwork')
            : t('banners.receiptQueue.processing'));
    return (
        <View style={[styles.card, styles.processingCard]}>
            <View style={styles.cardMain}>
                <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                    <View style={styles.cardTop}>
                        <View style={styles.cartChip}>
                            <Ionicons name="receipt-outline" size={14} color={colors.primary} />
                        </View>
                    </View>
                    <Text style={styles.processingTitle} numberOfLines={2}>{title}</Text>
                    {needsDate ? (
                        <Text style={styles.cardMeta} numberOfLines={2}>{t('receiptQueue.needsDate')}</Text>
                    ) : needsStoreChoice ? (
                        <>
                            <Text style={styles.cardMeta} numberOfLines={3}>{t('receiptQueue.needsStore')}</Text>
                            {chainNameById(item.linkDetectedChainId) != null && (
                                <Text style={styles.cardMeta} numberOfLines={1}>
                                    {t('receiptQueue.needsStoreDetected', { chain: chainNameById(item.linkDetectedChainId) })}
                                </Text>
                            )}
                        </>
                    ) : needsLink ? (
                        <Text style={styles.cardMeta} numberOfLines={3}>{t('receiptQueue.linkFailed')}</Text>
                    ) : !isError && <Text style={styles.cardMeta} numberOfLines={1}>{status}</Text>}
                </View>
                {needsStoreChoice ? (
                    <TouchableOpacity
                        onPress={() => useReceiptQueueStore.getState().removeItem(item.id)}
                        hitSlop={8}
                        accessibilityLabel={t('common.close')}
                    >
                        <Ionicons name="close" size={20} color={colors.textSecondary} />
                    </TouchableOpacity>
                ) : needsLink ? (
                    <View style={styles.cardActions}>
                        <TouchableOpacity style={styles.resolveBtn} onPress={retryLink} disabled={linking} hitSlop={6}>
                            {linking
                                ? <MaterialProgress size="small" color={colors.onPrimary} />
                                : <Ionicons name="link-outline" size={14} color={colors.onPrimary} />}
                            <Text style={styles.resolveBtnText}>{t('receiptQueue.retryLink')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            onPress={() => useReceiptQueueStore.getState().removeItem(item.id)}
                            hitSlop={8}
                            accessibilityLabel={t('common.close')}
                        >
                            <Ionicons name="close" size={20} color={colors.textSecondary} />
                        </TouchableOpacity>
                    </View>
                ) : needsDate ? (
                    <View style={styles.cardActions}>
                        <TouchableOpacity style={styles.resolveBtn} onPress={() => setShowPicker(true)} hitSlop={6}>
                            <Ionicons name="calendar-outline" size={14} color={colors.onPrimary} />
                            <Text style={styles.resolveBtnText}>{t('receiptQueue.enterDate')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            onPress={() => useReceiptQueueStore.getState().removeItem(item.id)}
                            hitSlop={8}
                            accessibilityLabel={t('common.close')}
                        >
                            <Ionicons name="close" size={20} color={colors.textSecondary} />
                        </TouchableOpacity>
                    </View>
                ) : isError ? (
                    <View style={styles.cardActions}>
                        {needsStore && (
                            <TouchableOpacity style={styles.resolveBtn} onPress={() => onResolveStore?.(item)} hitSlop={6}>
                                <Ionicons name="location-outline" size={14} color={colors.onPrimary} />
                                <Text style={styles.resolveBtnText}>{t('basketDetail.findStore')}</Text>
                            </TouchableOpacity>
                        )}
                        <TouchableOpacity
                            onPress={() => useReceiptQueueStore.getState().removeItem(item.id)}
                            hitSlop={8}
                            accessibilityLabel={t('common.close')}
                        >
                            <Ionicons name="close" size={20} color={colors.textSecondary} />
                        </TouchableOpacity>
                    </View>
                ) : (
                    <MaterialProgress size="small" color={colors.primary} />
                )}
            </View>
            {/* One button per PLANNED store of the trip this receipt was uploaded
                for, plus the explicit opt-out. Picking a store fulfils that slot
                (what the interactive scan's chain-gate override does); "keep
                separate" is today's ad-hoc behaviour, now a choice, not a silent
                default. */}
            {needsStoreChoice && (
                <View style={styles.linkChoices}>
                    {(item.linkOptions ?? []).map(o => (
                        <TouchableOpacity
                            key={o.listId}
                            style={styles.linkChoiceBtn}
                            onPress={() => resolveStoreLink(item.id, o.listId)}
                            hitSlop={6}
                        >
                            <View style={[styles.linkChoiceDot, { backgroundColor: chainBrandColorById(o.chainId) }]} />
                            <Text style={styles.linkChoiceText} numberOfLines={1}>
                                {chainNameById(o.chainId) ?? t('common.store')}
                            </Text>
                        </TouchableOpacity>
                    ))}
                    <TouchableOpacity
                        style={[styles.linkChoiceBtn, styles.linkChoiceGhost]}
                        onPress={() => resolveStoreLink(item.id, null)}
                        hitSlop={6}
                    >
                        <Text style={[styles.linkChoiceText, { color: colors.textSecondary }]} numberOfLines={1}>
                            {t('receiptQueue.keepSeparate')}
                        </Text>
                    </TouchableOpacity>
                </View>
            )}
            {!isError && !needsDate && !needsStoreChoice && !needsLink && <ProgressGlow edge="bottom" fraction={fraction} color={colors.primary} />}
            {showPicker && (
                <DateTimePicker
                    value={new Date()}
                    mode="date"
                    display={Platform.OS === 'ios' ? 'inline' : 'calendar'}
                    // A receipt can't be from the future, and two years back is
                    // ample — same bounds as the interactive scan's date gate.
                    maximumDate={new Date()}
                    minimumDate={new Date(new Date().getFullYear() - 2, new Date().getMonth(), new Date().getDate())}
                    onChange={(e: DateTimePickerEvent, d?: Date) => {
                        setShowPicker(false);
                        if (e.type === 'dismissed' || !d) return;
                        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                        resolveDate(item.id, iso);   // re-queues the item with the date injected
                    }}
                />
            )}
        </View>
    );
}

export default function TripsScreen() {
    const colors = useTheme();
    const { t, i18n } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    const header = useCollapsingHeader();
    const tabBarHeight = useSafeBottomTabBarHeight();
    const { setDraftBasketId } = useBasketState();

    // Android back: peel the dock sheet first (sub-pane → main → collapse),
    // then fall through to press-back-again-to-exit.
    const sheetIntercept = useCallback(() => {
        const s = useShoppingSheet.getState();
        if (s.sheetView !== 'main' && s.sheetGoBack) { s.sheetGoBack(); return true; }
        if (s.sheetStage > 0 && s.collapseSheet) { s.collapseSheet(); return true; }
        return false;
    }, []);
    const { backToExitToast } = useBackToExit(sheetIntercept);

    // In-flight receipt uploads → processing cards at the top of the list.
    const queueItems = useReceiptQueueStore(s => s.items);
    const queueInitialize = useReceiptQueueStore(s => s.initialize);
    const lastCompletedAt = useReceiptQueueStore(s => s.lastCompletedAt);
    // "New" (pink + badge) until the card is opened — persisted per-trip watermark.
    const seenTrips = useTripSeenStore(s => s.seen);
    const seenInit = useTripSeenStore(s => s.initialized);
    const markTripOpened = useTripSeenStore(s => s.markOpened);
    useEffect(() => { void useTripSeenStore.getState().initialize(); }, []);
    useEffect(() => { void queueInitialize(); }, [queueInitialize]);
    // PARKED statuses belong here too: a park is a QUESTION, and this is the
    // screen the user lands on. Without them an item waiting for a date / a store
    // choice / a link retry had no card at all outside the trip screen — it just
    // sat in the queue, invisible, which is indistinguishable from a silent fail.
    const processingItems = useMemo(
        () => queueItems.filter(i => i.status === 'processing' || i.status === 'pending'
            || i.status === 'awaiting_network' || i.status === 'error'
            || i.status === 'needs_date' || i.status === 'needs_store' || i.status === 'needs_link'),
        [queueItems]);

    // Store-unrecognized error → open the chain-scoped store map; on pick, drop the
    // errored item and re-enqueue with the resolved store injected (skips matchStore).
    const [resolveOpen, setResolveOpen] = useState(false);
    const onResolveStore = useCallback((item: QueueItem) => {
        if (item.storeChainId == null) return;
        const p = requestStoreResolution(item.storeChainId, item.storeChainName ?? '', item.storeOcrAddress ?? null);
        setResolveOpen(true);
        void p.then((picked) => {
            setResolveOpen(false);
            if (!picked) return;
            const store = useReceiptQueueStore.getState();
            store.removeItem(item.id);
            store.addItems([{
                uris: item.uris,
                isPdf: item.isPdf,
                resolvedStore: { storeId: picked.storeId, storeName: picked.storeName, storeAddress: picked.storeAddress },
            }]);
        });
    }, []);

    const [trips, setTrips] = useState<TripSummary[]>([]);
    const [household, setHousehold] = useState<HouseholdInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [pullRefreshing, setPullRefreshing] = useState(false);
    const [archiveOpen, setArchiveOpen] = useState(false);
    const hasFetchedRef = useRef(false);
    // Success timestamp for the focus-staleness gate (profileStore's
    // `lastFetched` shape). A failed fetch leaves it untouched so the next
    // focus retries immediately.
    const lastFetchedAtRef = useRef<number | null>(null);

    const fetchAll = useCallback(async (silent: boolean) => {
        if (silent) setRefreshing(true);
        try {
            const userId = await getUserId();
            const [tripRes, hhRes, basketRes] = await Promise.all([
                fetchTrips().catch(() => [] as TripSummary[]),
                fetchOwnHousehold().catch(() => null),
                // Draft-basket sync only (Browse's add-to-basket target).
                fetch(`${API_BASE_URL}/api/baskets/user/${userId}`).then(r => r.json()).catch(() => []),
            ]);
            setTrips(tripRes);
            setHousehold(hhRes);
            const draft = Array.isArray(basketRes) ? basketRes.find((b: any) => b.status === 'draft' && b.householdId == null) : null;
            setDraftBasketId(draft ? draft.id : null);
            lastFetchedAtRef.current = Date.now();
        } catch (error) {
            console.error('Failed to fetch trips:', error);
        } finally {
            if (silent) setRefreshing(false);
            setLoading(false);
        }
    }, [setDraftBasketId]);

    useFocusEffect(useCallback(() => {
        // Staleness gate: a tab switch within the TTL reuses state instead of
        // re-firing all three requests (with freezeOnBlur, EVERY switch used to
        // pay for them). Explicit refreshes — pull-to-refresh, the
        // receipt-completed effect, unarchive, the dock sheet's refreshTrips —
        // call fetchAll directly and always hit the network.
        if (!shouldRefetchOnFocus(lastFetchedAtRef.current)) return;
        const silent = hasFetchedRef.current;
        hasFetchedRef.current = true;
        fetchAll(silent);
    }, [fetchAll]));

    // A queued receipt just finished (markDone bumps lastCompletedAt) → silently
    // refetch so the new ad-hoc trip card appears and the processing card clears.
    useEffect(() => {
        if (lastCompletedAt) void fetchAll(true);
    }, [lastCompletedAt, fetchAll]);

    // Calendar filter (spec): dot per trip on its best-known shopping date,
    // chain-coloured via the trip's slots; ad-hoc trips dot as "Kita". The
    // filter UI lives in the Shopping dock sheet now — state comes from the
    // shared store (shared/SMART_BASKET_SPEC.md §1).
    const selectedDate = useShoppingSheet(st => st.selectedDate);
    const tripDotMap = useMemo(() => buildReceiptDotMap(trips.flatMap(tr => {
        const date = parseLooseDate(tr.anchorDate);
        const chains = tr.slots.map(sl => sl.chainName).filter((c): c is string => !!c);
        return (chains.length > 0 ? chains : ['Kita']).map(chainName => ({ date, chainName }));
    })), [trips]);
    // Publish sheet inputs.
    useEffect(() => { useShoppingSheet.getState().setDotMap(tripDotMap); }, [tripDotMap]);
    useEffect(() => {
        useShoppingSheet.getState().setHousehold(household);
    }, [household]);

    const selectedStages = useShoppingSheet(st => st.selectedStages);
    const byDate = useCallback((tr: TripSummary) => {
        if (selectedStages != null && !selectedStages.has(tr.stage)) return false;
        if (!selectedDate) return true;
        const d = parseLooseDate(tr.anchorDate);
        return d != null && sameDay(d, selectedDate);
    }, [selectedDate, selectedStages]);

    // Baskets removed via the detail sheet — hidden by a PERSISTENT filter (not
    // just dropped from `trips`) so the exit animation plays once and the focus
    // re-fetch can't momentarily re-add the card before the server DELETE lands.
    const [hiddenBasketIds, setHiddenBasketIds] = useState<Set<number>>(new Set());
    const notHidden = useCallback(
        (tr: TripSummary) => !(tr.basket != null && hiddenBasketIds.has(tr.basket.id)),
        [hiddenBasketIds]);

    const active = useMemo(() => trips.filter(tr => tr.archivedAt == null && byDate(tr) && notHidden(tr)), [trips, byDate, notHidden]);
    const archived = useMemo(() => trips.filter(tr => tr.archivedAt != null && byDate(tr) && notHidden(tr)), [trips, byDate, notHidden]);

    // Archyvas expands on tap, or auto-expands when a calendar day filter
    // matched only archived trips (same condition the old inline JSX used).
    const archiveExpanded = archiveOpen || (selectedDate != null && active.length === 0);

    // Flattened row model for the virtualised list. Stable keys (never index):
    // `q:` queue items, `trip:`/`arch:` trips.
    const rows = useMemo<TripRow[]>(() => {
        const out: TripRow[] = [];
        for (const item of processingItems) out.push({ kind: 'processing', key: `q:${item.id}`, item });
        if (active.length === 0 && processingItems.length === 0) {
            out.push({ kind: 'empty', key: 'empty' });
        } else {
            for (const trip of active) out.push({ kind: 'trip', key: `trip:${trip.id}`, trip });
        }
        if (archived.length > 0) {
            out.push({ kind: 'archiveHeader', key: 'archiveHeader' });
            if (archiveExpanded) {
                archived.forEach((trip, i) => out.push({
                    kind: 'archived', key: `arch:${trip.id}`, trip, isLast: i === archived.length - 1,
                }));
            }
        }
        return out;
    }, [processingItems, active, archived, archiveExpanded]);

    // ONE screen per stage (simplified flow): the card resolves straight to
    // the stage's screen — basket detail / comparison map / closest
    // unfinished list / receipts / stats. No trip container in between.
    const openTrip = useCallback((trip: TripSummary) => {
        markTripOpened(trip.id, trip.receiptCount); // clears its New/pink state
        void tripStageHref(trip).then(href => router.push(href as any)).catch(() => {});
    }, [router, markTripOpened]);

    const onArchivedTap = useCallback((trip: TripSummary) => {
        Alert.alert(
            t('trips.resumeTitle'),
            t('trips.resumeBody'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('trips.resumeConfirm'),
                    onPress: async () => {
                        try { await unarchiveTrip(trip.id); await fetchAll(true); } catch {}
                    },
                },
            ],
        );
    }, [t, fetchAll]);

    // Register the dock sheet's refresh callback (household/invites live in
    // the sheet itself now) + the optimistic card-removal used by Remove:
    // drop the trip that owns a basket so its card plays the exit animation.
    useEffect(() => {
        const st = useShoppingSheet.getState();
        st.setRefreshTrips(() => { void fetchAll(true); });
        st.setRemoveTripByBasket((basketId: number) => {
            setHiddenBasketIds(prev => new Set(prev).add(basketId));
        });
        return () => { st.setRefreshTrips(null); st.setRemoveTripByBasket(null); };
    }, [fetchAll]);

    const stageLabel = (s: number) => t(`trips.stage${s}`);
    const stageCta = (s: number) => t(`trips.cta${s}`);

    // A custom name (trip or basket rename) or the ad-hoc label wins; otherwise the
    // title is AUTO — derived from the last-activity date, shown as a calendar
    // badge + full weekday rather than the cryptic "Ket liepos 16" string.
    const customName = (trip: TripSummary): string | null =>
        trip.name ?? trip.basket?.name ?? (trip.isAdHoc ? t('trips.adHocName') : null);

    // Title text: the custom name when renamed, else the full weekday. The card
    // renders the date separately as a full-height CalendarBadge column.
    const tripTitle = (trip: TripSummary) =>
        customName(trip) ?? formatWeekday(trip.anchorDate, i18n.language);

    const slotLine = (trip: TripSummary) => {
        if (trip.slots.length === 0) {
            return trip.basket ? t('trips.itemCount', { count: trip.basket.itemCount }) : null;
        }
        return trip.slots.map(s => {
            const name = s.chainName ?? s.storeName ?? '?';
            if (trip.stage === 3) return `${name} ${s.checkedCount}/${s.itemCount}`;
            if (trip.stage >= 4) return s.hasReceipt ? `${name} ✓` : s.receiptSkipped ? `${name} —` : name;
            return name;
        }).join(' · ');
    };

    const renderRow = ({ item: row }: { item: TripRow }) => {
        switch (row.kind) {
            case 'processing':
                return <ProcessingCard item={row.item} onResolveStore={onResolveStore} />;
            case 'empty':
                return (
                    <View style={styles.centered}>
                        <Ionicons name="cart-outline" size={56} color={colors.textMuted} />
                        <Text style={styles.emptyText}>{t('trips.empty')}</Text>
                        <Text style={styles.emptySubText}>{t('trips.emptyBody')}</Text>
                        <ScalePressable style={styles.emptyButton} onPress={() => router.navigate('/(tabs)/catalog' as any)}>
                            <Text style={styles.emptyButtonText}>{t('basketTab.emptyCta')}</Text>
                        </ScalePressable>
                    </View>
                );
            case 'archiveHeader':
                // Archyvas — collapsed by default; tap a row = explicit resume.
                return (
                    <TouchableOpacity
                        style={[styles.archiveHeader, archiveExpanded ? styles.archiveHeaderOpen : styles.archiveHeaderClosed]}
                        onPress={() => setArchiveOpen(v => !v)}
                    >
                        <Text style={styles.archiveTitle}>{t('trips.archive')}</Text>
                        <Text style={styles.archiveCount}>{archived.length}</Text>
                        <Ionicons name={archiveExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textSecondary} />
                    </TouchableOpacity>
                );
            case 'archived': {
                const trip = row.trip;
                return (
                    <TouchableOpacity
                        style={[styles.archiveRow, row.isLast && styles.archiveRowLast]}
                        onPress={() => onArchivedTap(trip)}
                    >
                        <Ionicons name={STAGE_ICONS[trip.stage]} size={18} color={colors.textMuted} />
                        <View style={{ flex: 1 }}>
                            <Text style={styles.archiveRowTitle} numberOfLines={1}>{tripTitle(trip)}</Text>
                            <Text style={styles.archiveRowMeta} numberOfLines={1}>
                                {trip.isAdHoc ? t('trips.adHocMeta', { count: trip.receiptCount }) : stageLabel(trip.stage)}
                            </Text>
                        </View>
                        <Text style={styles.archiveRowDate}>{formatDate(trip.anchorDate)}</Text>
                    </TouchableOpacity>
                );
            }
            case 'trip': {
                const trip = row.trip;
                const hasReceipt = trip.receiptCount > 0;
                // Once the trip has LISTS, they are the source of truth for the
                // card's count + preview: the basket is consumed into the lists,
                // so its own itemCount/itemPreview go stale (an emptied basket
                // rendered "0" and a blank preview row on a stage-3/4 card).
                const listItems = trip.slots.reduce((n, s) => n + (s.itemCount ?? 0), 0);
                const listPreview = trip.slots.flatMap(s => s.itemPreview ?? []);
                const preview = trip.slots.length > 0 ? listPreview : (trip.basket?.itemPreview ?? []);
                const plannedCount = trip.slots.length > 0 ? listItems : (trip.basket?.itemCount ?? 0);
                const isNew = seenInit && isTripNew(seenTrips, trip.id, trip.receiptCount);
                const chains = trip.chains ?? [];
                const shownChains = chains.slice(0, 4);
                const chainOverflow = chains.length - shownChains.length;
                return (
                    <AnimatedTouchable
                        style={[styles.card, isNew && styles.cardNew]}
                        onPress={() => openTrip(trip)}
                        activeOpacity={0.8}
                        exiting={cardExit}
                    >
                        <View style={styles.cardMain}>
                            {/* Date column: every row (count/logos, title, preview) sits to
                                its RIGHT, so the calendar reads as the card's anchor rather
                                than a chip glued to the title. The badge keeps its natural
                                near-square tear-off proportions and centres in the column —
                                stretching it to the full row height read as a tall ribbon. */}
                            <View style={styles.calCol}>
                                <CalendarBadge date={trip.anchorDate} size={60} />
                            </View>
                            <View style={styles.cardBody}>
                                <View style={styles.cardTop}>
                                    <View style={styles.cardTopLeft}>
                                        {/* Uploaded receipt → receipt icon + recognised line count;
                                            otherwise the planned shopping-list count. */}
                                        <View style={styles.cartChip}>
                                            <Ionicons name={hasReceipt ? 'receipt-outline' : 'cart-outline'} size={14} color={colors.primary} />
                                            <Text style={styles.cartChipText}>{hasReceipt ? trip.recognisedItemCount : plannedCount}</Text>
                                        </View>
                                        {/* Chain logos: receipt chains full colour, planned-only dimmed. */}
                                        {shownChains.length > 0 && (
                                            <View style={styles.logoStrip}>
                                                {shownChains.map(c => (
                                                    <ChainLogoChip key={c.chainId} chainId={c.chainId} name={c.chainName ?? undefined} size={22} dimmed={!c.hasReceipt} style={styles.logoChip} />
                                                ))}
                                                {chainOverflow > 0 && <Text style={styles.logoMore}>+{chainOverflow}</Text>}
                                            </View>
                                        )}
                                    </View>
                                    <View style={styles.cardTopRight}>
                                        {isNew && (
                                            <View style={styles.newBadge}><Text style={styles.newBadgeText}>{t('trips.newBadge')}</Text></View>
                                        )}
                                        {trip.memberCount > 1 && (
                                            <MemberStack members={trip.members ?? []} total={trip.memberCount} styles={styles} />
                                        )}
                                    </View>
                                </View>
                                <Text style={styles.cardTitle} numberOfLines={1}>{tripTitle(trip)}</Text>
                                {preview.length > 0 ? (
                                    // Newest items first — each name caps and ellipsises so 3+ fit.
                                    <View style={styles.previewRow}>
                                        {preview.slice(0, 3).map((name, i) => (
                                            <React.Fragment key={i}>
                                                {i > 0 && <Text style={styles.previewDot}>·</Text>}
                                                <Text style={styles.previewName} numberOfLines={1}>{name}</Text>
                                            </React.Fragment>
                                        ))}
                                    </View>
                                ) : slotLine(trip) ? (
                                    <Text style={styles.cardMeta} numberOfLines={1}>{slotLine(trip)}</Text>
                                ) : null}
                            </View>
                            <View style={styles.ctaBtn}>
                                <Text style={styles.ctaText}>{stageCta(trip.stage)}</Text>
                                <Ionicons name="chevron-forward" size={16} color={colors.primary} />
                            </View>
                        </View>
                    </AnimatedTouchable>
                );
            }
        }
    };

    if (loading) return (
        <View style={styles.container}>
            <CollapsingHeader controller={header} smallTitle={t('tabs.trips')} />
            {backToExitToast}
            <View style={{ padding: 16, gap: 12 }}>
                <ScreenHeading title={t('tabs.trips')} />
                {Array.from({ length: 4 }).map((_, i) => (
                    <SkeletonBox key={i} width="100%" height={84} borderRadius={14} />
                ))}
            </View>
        </View>
    );

    return (
        <View style={styles.container}>
            <CollapsingHeader controller={header} smallTitle={t('tabs.trips')} />
            {backToExitToast}
            {/* ALWAYS-PINNED filter chips (the repo's CollapsingHeader pinned-row
                pattern — shopping-list/discounts do the same): a real row ABOVE
                the list, not stickyHeaderIndices — RN sticky cells don't mix with
                the FlatList's itemLayoutAnimation cell renderer. The family card
                deliberately scrolls away with the title: it's a navigation
                shortcut, not a list control, and pinning it would eat viewport.
                onPinnedLayout drops the header's dissolve strip below the chips. */}
            <View onLayout={header.onPinnedLayout} style={{ backgroundColor: colors.pageBackground }}>
                <ShoppingFilterChips />
            </View>
            <Animated.FlatList
                {...header.scroll}
                style={styles.container}
                data={rows}
                keyExtractor={tripRowKey}
                renderItem={renderRow}
                // Cell moves (a trip disappearing, archive expand/collapse)
                // animate at the list level — same motion the per-card `layout`
                // prop used to provide.
                itemLayoutAnimation={rowLayout}
                initialNumToRender={12}
                contentInsetAdjustmentBehavior="never"
                contentContainerStyle={[styles.list, { paddingTop: 0, paddingBottom: tabBarHeight + 24 }]}
                refreshControl={
                    <RefreshControl
                        refreshing={pullRefreshing}
                        onRefresh={async () => { setPullRefreshing(true); await fetchAll(false); setPullRefreshing(false); }}
                        colors={[colors.primary]}
                        tintColor={colors.primary}
                    />
                }
                ListHeaderComponent={
                    <>
                        {/* Large title (scrolls away — the collapsing bar takes over) */}
                        <ScreenHeading title={t('tabs.trips')} onLayout={header.onTitleLayout} />
                        {/* Family card (when enabled) — scrolls with the content;
                            only the chips row above the list stays pinned. */}
                        {household && (
                            <TouchableOpacity
                                style={styles.familyCard}
                                activeOpacity={0.85}
                                onPress={() => router.push('/family' as any)}
                            >
                                <View style={styles.familyIcon}>
                                    <Ionicons name="home" size={22} color={colors.onPrimary} />
                                </View>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.familyCardTitle}>{t('family.cardTitle')}</Text>
                                    <Text style={styles.familyCardSub}>{t('trips.householdMembers', { count: household.members.length })}</Text>
                                </View>
                                <Ionicons name="chevron-forward" size={20} color={colors.primary} />
                            </TouchableOpacity>
                        )}
                    </>
                }
            />

            {/* Store-resolution map (chain-scoped pills) for a store_unrecognized upload. */}
            {resolveOpen && (
                <Modal visible transparent animationType="slide" onRequestClose={() => setResolveOpen(false)}>
                    <StoreResolutionOverlay onCancel={() => setResolveOpen(false)} />
                </Modal>
            )}
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { alignItems: 'center', justifyContent: 'center', padding: 32 },
    // No horizontal pad here: the title + sticky chips span full width; the
    // cards carry their own side margin (see `card` / `archiveHeader`).
    list: { paddingBottom: 16 },

    filterRow: {
        flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 8,
        backgroundColor: c.cardBackground,
        borderBottomWidth: 0.5, borderBottomColor: c.border,
    },
    // Pinned family-shopping card — stands out: pink-tinted fill, solid pink
    // icon disc, pink border. Navigates to the family (Basket/History) screen.
    familyCard: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
        backgroundColor: c.primaryMuted ?? c.surfaceMuted, borderRadius: radius.lg, padding: 14,
        marginHorizontal: 16, marginTop: 4, marginBottom: 10,
        borderWidth: 1, borderColor: c.primary,
    },
    familyIcon: {
        width: 40, height: 40, borderRadius: radius.md,
        backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center',
    },
    familyCardTitle: { fontSize: 15, fontWeight: '800', color: c.textPrimary },
    familyCardSub: { fontSize: 12, color: c.primary, marginTop: 2, fontWeight: '600' },

    card: {
        backgroundColor: c.cardBackground, borderRadius: radius.lg, padding: 14, marginBottom: 10,
        marginHorizontal: 16,
        borderWidth: 3, borderColor: 'transparent', borderLeftColor: c.primary,
        gap: 6,
    },
    // Same card shell, clipped so the bottom-edge progress glow follows the corners.
    processingCard: { overflow: 'hidden' },
    processingTitle: { fontSize: 15, fontWeight: '800', color: c.textPrimary },
    cardActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    resolveBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: c.primary, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 7 },
    resolveBtnText: { fontSize: 13, fontWeight: '800', color: c.onPrimary },
    // needs_store: one pill per planned store of the trip + the "keep separate" opt-out.
    linkChoices: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingTop: 10 },
    linkChoiceBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, backgroundColor: c.surfaceMuted, paddingHorizontal: 12, paddingVertical: 7 },
    linkChoiceGhost: { backgroundColor: 'transparent' },
    linkChoiceDot: { width: 8, height: 8, borderRadius: 4 },
    linkChoiceText: { fontSize: 13, fontWeight: '700', color: c.textPrimary },
    // `stretch` gives the date column the full content height to centre within.
    cardMain: { flexDirection: 'row', alignItems: 'stretch', gap: 10 },
    calCol: { justifyContent: 'center' },
    cardBody: { flex: 1, minWidth: 0, gap: 4 },
    cartChip: {
        flexDirection: 'row', alignItems: 'center', gap: 4,
        backgroundColor: c.primaryMuted ?? c.surfaceMuted, borderRadius: radius.pill,
        paddingHorizontal: 10, paddingVertical: 4,
    },
    cartChipText: { fontSize: 13, fontWeight: '800', color: c.primary },
    // New (unopened receipt) card: pink-tinted fill + full pink border, set apart
    // from the pinned family card (also pink) by the "New" badge + receipt content.
    cardNew: { backgroundColor: c.primaryMuted ?? c.surfaceMuted, borderColor: c.primary },
    cardTopLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1, minWidth: 0 },
    cardTopRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    logoStrip: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    logoChip: {},
    logoMore: { fontSize: 11, fontWeight: '800', color: c.textMuted, marginLeft: 2 },
    newBadge: { backgroundColor: c.primary, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
    newBadgeText: { fontSize: 10, fontWeight: '900', color: c.onPrimary, letterSpacing: 0.3 },
    previewRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    previewName: { flexShrink: 1, fontSize: 12, color: c.textSecondary, maxWidth: '38%' },
    previewDot: { fontSize: 12, color: c.textMuted },
    // alignSelf keeps the CTA vertically centred now that the row stretches.
    ctaBtn: { flexDirection: 'row', alignItems: 'center', alignSelf: 'center', gap: 2, paddingLeft: 4 },
    cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 },
    // Overlapping member avatars — top-right of a shared card.
    memberStack: { flexDirection: 'row', alignItems: 'center' },
    memberOverlap: { marginLeft: -8 },
    memberRing: { borderWidth: 1.5, borderColor: c.cardBackground },
    memberMore: {
        width: 22, height: 22, borderRadius: 11, backgroundColor: c.surfaceMuted,
        borderWidth: 1.5, borderColor: c.cardBackground, alignItems: 'center', justifyContent: 'center',
    },
    memberMoreText: { fontSize: 10, fontWeight: '800', color: c.textSecondary },
    stageChip: {
        flexDirection: 'row', alignItems: 'center', gap: 4,
        backgroundColor: c.primaryMuted ?? c.surfaceMuted, borderRadius: radius.pill,
        paddingHorizontal: 8, paddingVertical: 3,
    },
    stageChipText: { fontSize: 11, fontWeight: '700', color: c.primary },
    membersChip: {
        flexDirection: 'row', alignItems: 'center', gap: 3,
        backgroundColor: c.surfaceMuted, borderRadius: radius.pill,
        paddingHorizontal: 7, paddingVertical: 3,
    },
    membersChipText: { fontSize: 11, fontWeight: '700', color: c.textSecondary },
    cardTitle: { fontSize: 16, fontWeight: '700', color: c.textPrimary, flexShrink: 1 },
    cardMeta: { fontSize: 13, color: c.textSecondary, marginTop: 3 },
    ctaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 2, marginTop: 8 },
    ctaText: { fontSize: 13, fontWeight: '700', color: c.primary },

    // The archive card is split across FlatList rows (header row + N trip
    // rows), so each row draws its slice of the old single-container border:
    // the header owns the top edge + corners, every row the sides, the last
    // row the bottom edge + corners.
    archiveHeader: {
        flexDirection: 'row', alignItems: 'center', gap: 8,
        paddingHorizontal: 14, paddingVertical: 12,
        marginTop: 12, marginHorizontal: 16,
        backgroundColor: c.cardBackground,
        borderWidth: 1, borderColor: c.border,
        borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    },
    archiveHeaderClosed: { borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg },
    archiveHeaderOpen: { borderBottomWidth: 0 },
    archiveTitle: { flex: 1, fontSize: 14, fontWeight: '700', color: c.textPrimary },
    archiveCount: { fontSize: 13, fontWeight: '600', color: c.textSecondary },
    archiveRow: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
        paddingHorizontal: 14, paddingVertical: 10,
        marginHorizontal: 16,
        backgroundColor: c.cardBackground,
        borderLeftWidth: 1, borderRightWidth: 1,
        borderLeftColor: c.border, borderRightColor: c.border,
        borderTopWidth: 0.5, borderTopColor: c.borderSubtle,
    },
    archiveRowLast: {
        borderBottomWidth: 1, borderBottomColor: c.border,
        borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg,
    },
    archiveRowTitle: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
    archiveRowMeta: { fontSize: 12, color: c.textMuted, marginTop: 1 },
    archiveRowDate: { fontSize: 12, color: c.textSecondary },

    emptyText: { fontSize: 16, color: c.textSecondary, fontWeight: '600', marginTop: 16, textAlign: 'center' },
    emptySubText: { fontSize: 13, color: c.textMuted, marginTop: 6, textAlign: 'center', lineHeight: 18 },
    emptyButton: { marginTop: 20, backgroundColor: c.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: radius.pill },
    emptyButtonText: { color: c.onPrimary, fontWeight: '700', fontSize: 14 },


    qrBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: 28 },
    qrCard: { backgroundColor: c.cardBackground, borderRadius: radius.xl, padding: 22, gap: 10, alignItems: 'center', maxWidth: 380, width: '100%' },
    qrTitle: { fontSize: 17, fontWeight: '800', color: c.textPrimary },
    qrBody: { fontSize: 13, color: c.textSecondary, textAlign: 'center', lineHeight: 18 },
    qrBox: { padding: 16, alignItems: 'center', justifyContent: 'center', minHeight: 232 },
    qrClose: { paddingVertical: 10, paddingHorizontal: 24 },
    qrCloseText: { fontSize: 14, fontWeight: '700', color: c.primary },
});
