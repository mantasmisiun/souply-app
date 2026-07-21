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
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import Animated, { LinearTransition, withTiming, Easing } from 'react-native-reanimated';
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import { ScreenHeading } from '../../../components/ScreenHeading';
import { useCollapsingHeader, CollapsingHeader } from '../../../components/CollapsingHeader';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { API_BASE_URL } from '../../../config/api';
import { useSafeBottomTabBarHeight } from '../../../hooks/useSafeBottomTabBarHeight';
import { getUserId } from '../../../config/user';
import { useBasketState } from '../../../state/basketState';
import { useTheme, radius, spacing, type AppTheme } from '../../../constants/theme';
import { ScalePressable } from '../../../components/ScalePressable';
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

export default function TripsScreen() {
    const colors = useTheme();
    const { t, i18n } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    const header = useCollapsingHeader();
    const tabBarHeight = useSafeBottomTabBarHeight();
    const { setDraftBasketId } = useBasketState();

    const [trips, setTrips] = useState<TripSummary[]>([]);
    const [household, setHousehold] = useState<HouseholdInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [pullRefreshing, setPullRefreshing] = useState(false);
    const [archiveOpen, setArchiveOpen] = useState(false);
    const hasFetchedRef = useRef(false);

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
        } catch (error) {
            console.error('Failed to fetch trips:', error);
        } finally {
            if (silent) setRefreshing(false);
            setLoading(false);
        }
    }, [setDraftBasketId]);

    useFocusEffect(useCallback(() => {
        const silent = hasFetchedRef.current;
        hasFetchedRef.current = true;
        fetchAll(silent);
    }, [fetchAll]));

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

    // ONE screen per stage (simplified flow): the card resolves straight to
    // the stage's screen — basket detail / comparison map / closest
    // unfinished list / receipts / stats. No trip container in between.
    const openTrip = useCallback((trip: TripSummary) => {
        void tripStageHref(trip).then(href => router.push(href as any)).catch(() => {});
    }, [router]);

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

    // Title as a string (archive rows, which already show the date on the right).
    const tripTitle = (trip: TripSummary) =>
        customName(trip) ?? formatWeekday(trip.anchorDate, i18n.language);

    // Title as JSX: the last-activity calendar badge ALWAYS shows; the text is the
    // custom name when renamed, else the full weekday.
    const renderTripTitle = (trip: TripSummary) => {
        const title = customName(trip) ?? formatWeekday(trip.anchorDate, i18n.language);
        return (
            <View style={styles.titleRow}>
                <CalendarBadge date={trip.anchorDate} size={30} />
                <Text style={styles.cardTitle} numberOfLines={1}>{title}</Text>
            </View>
        );
    };

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

    if (loading) return (
        <View style={styles.container}>
            <CollapsingHeader controller={header} smallTitle={t('tabs.trips')} />
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
            <Animated.ScrollView
                {...header.scroll}
                style={styles.container}
                contentInsetAdjustmentBehavior="never"
                stickyHeaderIndices={[1]}
                contentContainerStyle={[styles.list, { paddingTop: 0, paddingBottom: tabBarHeight + 24 }]}
                refreshControl={
                    <RefreshControl
                        refreshing={pullRefreshing}
                        onRefresh={async () => { setPullRefreshing(true); await fetchAll(false); setPullRefreshing(false); }}
                        colors={[colors.primary]}
                        tintColor={colors.primary}
                    />
                }
            >
                {/* index 0: large title (scrolls away) */}
                <ScreenHeading title={t('tabs.trips')} onLayout={header.onTitleLayout} />
                {/* index 1: filter chips — native sticky, pin under the bar */}
                <View style={{ backgroundColor: colors.pageBackground }}>
                    <ShoppingFilterChips />
                </View>
                {active.length === 0 ? (
                    <View style={styles.centered}>
                        <Ionicons name="cart-outline" size={56} color={colors.textMuted} />
                        <Text style={styles.emptyText}>{t('trips.empty')}</Text>
                        <Text style={styles.emptySubText}>{t('trips.emptyBody')}</Text>
                        <ScalePressable style={styles.emptyButton} onPress={() => router.navigate('/(tabs)/catalog' as any)}>
                            <Text style={styles.emptyButtonText}>{t('basketTab.emptyCta')}</Text>
                        </ScalePressable>
                    </View>
                ) : (
                    active.map(trip => {
                        const preview = trip.basket?.itemPreview ?? [];
                        return (
                        <AnimatedTouchable
                            key={trip.id}
                            style={styles.card}
                            onPress={() => openTrip(trip)}
                            activeOpacity={0.8}
                            exiting={cardExit}
                            layout={LinearTransition.duration(240).easing(Easing.out(Easing.cubic))}
                        >
                            <View style={styles.cardMain}>
                                <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                                    <View style={styles.cardTop}>
                                        <View style={styles.cartChip}>
                                            <Ionicons name="cart-outline" size={14} color={colors.primary} />
                                            <Text style={styles.cartChipText}>{trip.basket?.itemCount ?? 0}</Text>
                                        </View>
                                        {trip.memberCount > 1 && (
                                            <View style={styles.membersChip}>
                                                <Ionicons name="people-outline" size={12} color={colors.textSecondary} />
                                                <Text style={styles.membersChipText}>{trip.memberCount}</Text>
                                            </View>
                                        )}
                                    </View>
                                    {renderTripTitle(trip)}
                                </View>
                                <View style={styles.ctaBtn}>
                                    <Text style={styles.ctaText}>{stageCta(trip.stage)}</Text>
                                    <Ionicons name="chevron-forward" size={16} color={colors.primary} />
                                </View>
                            </View>
                            {preview.length > 0 ? (
                                // Newest items first, spanning the FULL card width —
                                // each name caps and ellipsises so 3+ fit.
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
                        </AnimatedTouchable>
                        );
                    })
                )}

                {/* Archyvas — collapsed by default; tap a row = explicit resume. */}
                {archived.length > 0 && (
                    <View style={styles.archiveSection}>
                        <TouchableOpacity style={styles.archiveHeader} onPress={() => setArchiveOpen(v => !v)}>
                            <Text style={styles.archiveTitle}>{t('trips.archive')}</Text>
                            <Text style={styles.archiveCount}>{archived.length}</Text>
                            <Ionicons name={archiveOpen ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textSecondary} />
                        </TouchableOpacity>
                        {(archiveOpen || (selectedDate != null && active.length === 0)) && archived.map(trip => (
                            <TouchableOpacity key={trip.id} style={styles.archiveRow} onPress={() => onArchivedTap(trip)}>
                                <Ionicons name={STAGE_ICONS[trip.stage]} size={18} color={colors.textMuted} />
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.archiveRowTitle} numberOfLines={1}>{tripTitle(trip)}</Text>
                                    <Text style={styles.archiveRowMeta} numberOfLines={1}>
                                        {trip.isAdHoc ? t('trips.adHocMeta', { count: trip.receiptCount }) : stageLabel(trip.stage)}
                                    </Text>
                                </View>
                                <Text style={styles.archiveRowDate}>{formatDate(trip.anchorDate)}</Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                )}
            </Animated.ScrollView>

        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { alignItems: 'center', justifyContent: 'center', padding: 32 },
    // No horizontal pad here: the title + sticky chips span full width; the
    // cards carry their own side margin (see `card` / `archiveSection`).
    list: { paddingBottom: 16 },

    filterRow: {
        flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 8,
        backgroundColor: c.cardBackground,
        borderBottomWidth: 0.5, borderBottomColor: c.border,
    },
    householdCard: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
        backgroundColor: c.cardBackground, borderRadius: radius.lg, padding: 14, marginBottom: 12,
        borderWidth: 1.5, borderColor: c.primary, borderStyle: 'dashed',
    },
    householdIcon: {
        width: 40, height: 40, borderRadius: radius.md,
        backgroundColor: c.primaryMuted ?? c.surfaceMuted,
        alignItems: 'center', justifyContent: 'center',
    },
    householdTitle: { fontSize: 15, fontWeight: '700', color: c.textPrimary },
    householdSub: { fontSize: 12, color: c.textSecondary, marginTop: 2 },

    card: {
        backgroundColor: c.cardBackground, borderRadius: radius.lg, padding: 14, marginBottom: 10,
        marginHorizontal: 16,
        borderWidth: 3, borderColor: 'transparent', borderLeftColor: c.primary,
        gap: 6,
    },
    cardMain: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    cartChip: {
        flexDirection: 'row', alignItems: 'center', gap: 4,
        backgroundColor: c.primaryMuted ?? c.surfaceMuted, borderRadius: radius.pill,
        paddingHorizontal: 10, paddingVertical: 4,
    },
    cartChipText: { fontSize: 13, fontWeight: '800', color: c.primary },
    previewRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    previewName: { flexShrink: 1, fontSize: 12, color: c.textSecondary, maxWidth: '38%' },
    previewDot: { fontSize: 12, color: c.textMuted },
    ctaBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingLeft: 4 },
    cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
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
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    cardMeta: { fontSize: 13, color: c.textSecondary, marginTop: 3 },
    ctaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 2, marginTop: 8 },
    ctaText: { fontSize: 13, fontWeight: '700', color: c.primary },

    archiveSection: {
        marginTop: 12, marginHorizontal: 16, borderRadius: radius.lg, overflow: 'hidden',
        borderWidth: 1, borderColor: c.border, backgroundColor: c.cardBackground,
    },
    archiveHeader: {
        flexDirection: 'row', alignItems: 'center', gap: 8,
        paddingHorizontal: 14, paddingVertical: 12,
    },
    archiveTitle: { flex: 1, fontSize: 14, fontWeight: '700', color: c.textPrimary },
    archiveCount: { fontSize: 13, fontWeight: '600', color: c.textSecondary },
    archiveRow: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
        paddingHorizontal: 14, paddingVertical: 10,
        borderTopWidth: 0.5, borderTopColor: c.borderSubtle,
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
