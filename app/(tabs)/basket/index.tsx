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
import Animated from 'react-native-reanimated';
import { useMemo, useRef, useState, useCallback } from 'react';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { glassHeaderOptions } from '../../../constants/navHeader';
import { ScreenHeading } from '../../../components/ScreenHeading';
import { useCollapsingHeader, CollapsingHeader } from '../../../components/CollapsingHeader';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { API_BASE_URL } from '../../../config/api';
import { useSafeBottomTabBarHeight } from '../../../hooks/useSafeBottomTabBarHeight';
import { getUserId } from '../../../config/user';
import { useBasketState } from '../../../state/basketState';
import { useTheme, radius, spacing, type AppTheme } from '../../../constants/theme';
import { ScalePressable } from '../../../components/ScalePressable';
import { SkeletonBox } from '../../../components/SkeletonBox';
import { BrandedQR } from '../../../components/BrandedQR';
import { formatDate } from '../../../utils/formatCurrency';
import { DateFilterButton } from '../../../components/DateFilterButton';
import { buildReceiptDotMap, parseLooseDate, sameDay } from '../../../utils/receiptDots';
import {
    fetchTrips, unarchiveTrip, fetchOwnHousehold, createOwnHousehold,
    createHouseholdInviteUrl, type TripSummary, type HouseholdInfo,
} from '../../../utils/tripsApi';

const STAGE_ICONS: Record<number, keyof typeof Ionicons.glyphMap> = {
    1: 'cart-outline', 2: 'storefront-outline', 3: 'list-outline', 4: 'receipt-outline', 5: 'stats-chart-outline',
};

export default function TripsScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    const header = useCollapsingHeader();
    const insets = useSafeAreaInsets();
    const tabBarHeight = useSafeBottomTabBarHeight();
    const { setDraftBasketId } = useBasketState();

    const [trips, setTrips] = useState<TripSummary[]>([]);
    const [household, setHousehold] = useState<HouseholdInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [pullRefreshing, setPullRefreshing] = useState(false);
    const [archiveOpen, setArchiveOpen] = useState(false);
    // Household QR sheet: null = closed; 'loading' while the invite mints.
    const [qrUrl, setQrUrl] = useState<string | null>(null);
    const [qrOpen, setQrOpen] = useState(false);
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
    // chain-coloured via the trip's slots; ad-hoc trips dot as "Kita".
    const [selectedDate, setSelectedDate] = useState<Date | null>(null);
    const tripDotMap = useMemo(() => buildReceiptDotMap(trips.flatMap(tr => {
        const date = parseLooseDate(tr.anchorDate);
        const chains = tr.slots.map(sl => sl.chainName).filter((c): c is string => !!c);
        return (chains.length > 0 ? chains : ['Kita']).map(chainName => ({ date, chainName }));
    })), [trips]);
    const byDate = useCallback((tr: TripSummary) => {
        if (!selectedDate) return true;
        const d = parseLooseDate(tr.anchorDate);
        return d != null && sameDay(d, selectedDate);
    }, [selectedDate]);

    const active = useMemo(() => trips.filter(tr => tr.archivedAt == null && byDate(tr)), [trips, byDate]);
    const archived = useMemo(() => trips.filter(tr => tr.archivedAt != null && byDate(tr)), [trips, byDate]);

    // Stage CTA → the existing surface that continues the journey.
    const openTrip = useCallback((trip: TripSummary) => {
        if (trip.stage <= 1) {
            if (trip.basket) router.push(`/basket/${trip.basket.id}` as any);
            return;
        }
        // Stages 2+ live on the trip-map surface (zero-decision search,
        // slots, invites, receipts).
        router.push(`/trip/${trip.id}` as any);
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

    const openHouseholdQr = useCallback(async () => {
        setQrOpen(true);
        setQrUrl(null);
        try {
            if (!household) {
                await createOwnHousehold();
                const hh = await fetchOwnHousehold();
                setHousehold(hh);
            }
            setQrUrl(await createHouseholdInviteUrl());
        } catch {
            setQrOpen(false);
            Alert.alert(t('trips.householdErrorTitle'), t('trips.householdErrorBody'));
        }
    }, [household, t]);

    const stageLabel = (s: number) => t(`trips.stage${s}`);
    const stageCta = (s: number) => t(`trips.cta${s}`);

    const tripTitle = (trip: TripSummary) =>
        trip.name ?? (trip.isAdHoc ? t('trips.adHocName') : formatDate(trip.anchorDate));

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
            <Stack.Screen options={glassHeaderOptions()} />
            <ScreenHeading title={t('tabs.trips')} topInset={insets.top} />
            <View style={{ padding: 16, gap: 12 }}>
                {Array.from({ length: 4 }).map((_, i) => (
                    <SkeletonBox key={i} width="100%" height={84} borderRadius={14} />
                ))}
            </View>
        </View>
    );

    return (
        <View style={styles.container}>
            <CollapsingHeader
                controller={header}
                background={colors.cardBackground}
                collapsing={<ScreenHeading title={t('tabs.trips')} />}
                pinned={(
                    <>
                        <View style={styles.filterRow}>
                            <DateFilterButton
                                value={selectedDate}
                                onChange={setSelectedDate}
                                label={t('receipts.filterDate')}
                                markedDates={tripDotMap}
                            />
                        </View>
                        {refreshing && (
                            <View style={styles.refreshingBanner}>
                                <MaterialProgress size="small" color={colors.primary} />
                                <Text style={styles.refreshingText}>{t('basketTab.loading')}</Text>
                            </View>
                        )}
                    </>
                )}
            />
            <Animated.ScrollView
                {...header.scroll}
                contentInsetAdjustmentBehavior="never"
                contentContainerStyle={[styles.list, { paddingTop: header.paddingTop + 12, paddingBottom: tabBarHeight + 24 }]}
                refreshControl={
                    <RefreshControl
                        refreshing={pullRefreshing}
                        onRefresh={async () => { setPullRefreshing(true); await fetchAll(false); setPullRefreshing(false); }}
                        colors={[colors.primary]}
                        tintColor={colors.primary}
                    />
                }
            >
                {/* Household card: create-or-invite, always at the top (spec). */}
                <TouchableOpacity style={styles.householdCard} onPress={openHouseholdQr} activeOpacity={0.85}>
                    <View style={styles.householdIcon}>
                        <Ionicons name="home-outline" size={22} color={colors.primary} />
                    </View>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.householdTitle}>
                            {household ? (household.name ?? t('trips.householdCardExisting')) : t('trips.householdCardNew')}
                        </Text>
                        <Text style={styles.householdSub}>
                            {household
                                ? t('trips.householdMembers', { count: household.members.length })
                                : t('trips.householdCardNewSub')}
                        </Text>
                    </View>
                    <Ionicons name="qr-code-outline" size={22} color={colors.primary} />
                </TouchableOpacity>

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
                    active.map(trip => (
                        <TouchableOpacity key={trip.id} style={styles.card} onPress={() => openTrip(trip)} activeOpacity={0.8}>
                            <View style={styles.cardTop}>
                                <View style={styles.stageChip}>
                                    <Ionicons name={STAGE_ICONS[trip.stage]} size={12} color={colors.primary} />
                                    <Text style={styles.stageChipText}>{stageLabel(trip.stage)}</Text>
                                </View>
                                {trip.memberCount > 1 && (
                                    <View style={styles.membersChip}>
                                        <Ionicons name="people-outline" size={12} color={colors.textSecondary} />
                                        <Text style={styles.membersChipText}>{trip.memberCount}</Text>
                                    </View>
                                )}
                            </View>
                            <Text style={styles.cardTitle} numberOfLines={1}>{tripTitle(trip)}</Text>
                            {slotLine(trip) ? (
                                <Text style={styles.cardMeta} numberOfLines={1}>{slotLine(trip)}</Text>
                            ) : null}
                            <View style={styles.ctaRow}>
                                <Text style={styles.ctaText}>{stageCta(trip.stage)}</Text>
                                <Ionicons name="chevron-forward" size={16} color={colors.primary} />
                            </View>
                        </TouchableOpacity>
                    ))
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

            {/* Household invite QR sheet. */}
            <Modal visible={qrOpen} transparent animationType="fade" onRequestClose={() => setQrOpen(false)}>
                <TouchableOpacity style={styles.qrBackdrop} activeOpacity={1} onPress={() => setQrOpen(false)}>
                    <View style={styles.qrCard} onStartShouldSetResponder={() => true}>
                        <Text style={styles.qrTitle}>{t('trips.householdQrTitle')}</Text>
                        <Text style={styles.qrBody}>{t('trips.householdQrBody')}</Text>
                        <View style={styles.qrBox}>
                            {qrUrl
                                ? <BrandedQR value={qrUrl} size={200} />
                                : <MaterialProgress size="large" color={colors.primary} />}
                        </View>
                        <TouchableOpacity style={styles.qrClose} onPress={() => setQrOpen(false)}>
                            <Text style={styles.qrCloseText}>{t('common.gotIt')}</Text>
                        </TouchableOpacity>
                    </View>
                </TouchableOpacity>
            </Modal>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { alignItems: 'center', justifyContent: 'center', padding: 32 },
    list: { padding: 16 },

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
        borderWidth: 3, borderColor: 'transparent', borderLeftColor: c.primary,
    },
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
    cardTitle: { fontSize: 16, fontWeight: '700', color: c.textPrimary },
    cardMeta: { fontSize: 13, color: c.textSecondary, marginTop: 3 },
    ctaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 2, marginTop: 8 },
    ctaText: { fontSize: 13, fontWeight: '700', color: c.primary },

    archiveSection: {
        marginTop: 12, borderRadius: radius.lg, overflow: 'hidden',
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

    refreshingBanner: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        gap: 6, paddingVertical: 4, backgroundColor: c.surfaceSubtle,
    },
    refreshingText: { fontSize: 11, color: c.textSecondary, fontWeight: '500' },

    qrBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: 28 },
    qrCard: { backgroundColor: c.cardBackground, borderRadius: radius.xl, padding: 22, gap: 10, alignItems: 'center', maxWidth: 380, width: '100%' },
    qrTitle: { fontSize: 17, fontWeight: '800', color: c.textPrimary },
    qrBody: { fontSize: 13, color: c.textSecondary, textAlign: 'center', lineHeight: 18 },
    qrBox: { padding: 16, alignItems: 'center', justifyContent: 'center', minHeight: 232 },
    qrClose: { paddingVertical: 10, paddingHorizontal: 24 },
    qrCloseText: { fontSize: 14, fontWeight: '700', color: c.primary },
});
