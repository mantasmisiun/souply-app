/**
 * Trip detail on the ONE map (Souply 2.0 Phase 4, first slice): MapHost +
 * slot pills + the GlassStageSheet with the trip overview page. Stage-3
 * slots render the PROGRESS pill variant ("2/10" checked); stage-4+ slots
 * show their receipt state. The bar carries the stage's CTA and the trip
 * QR invite lives on the overview page (member-gated server-side).
 *
 * The stores→plans page-stack pages arrive in the next slice — this shell
 * owns the surface they will push onto.
 */
import { View, Text, TouchableOpacity, StyleSheet, Modal } from 'react-native';
import MapView from 'react-native-maps';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { MaterialProgress } from '@/components/MaterialProgress';
import { MapHost } from '../../components/map/MapHost';
import { GlassStageSheet, SHEET_HANDLE_H, type SheetPage } from '../../components/GlassStageSheet';
import { GlassIconButton } from '../../components/GlassIconButton';
import { BrandedQR } from '../../components/BrandedQR';
import { ChainLogoChip } from '../../components/ChainLogoChip';
import { useBakedPills, MapPillMarker, type MapPillSpec } from '../../components/map/MapPill';
import { chainIdByName } from '../../utils/chainBrandName';
import { useTheme, radius, spacing, type AppTheme } from '../../constants/theme';
import { VILNIUS_FALLBACK , tryGpsCoords } from '../../utils/location';
import { fetchTrips, createTripInviteUrl, fetchTripStats, type TripSummary, type TripSlot, type TripStats } from '../../utils/tripsApi';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import { buildCandidatePool } from '../../utils/candidatePool';
import { getLocationSettings } from '../../utils/locationStorage';
import { scoreAllCombinations, type ScoredCombo, type StoreResult } from '../../utils/splitBasketScore';
import { Alert } from 'react-native';

const BAR_H = 64;

export default function TripMapScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    const { bottom: bottomInset } = useSafeAreaInsets();
    const { id } = useLocalSearchParams<{ id: string }>();
    const tripId = Number(id);

    const mapRef = useRef<MapView>(null);
    const [trip, setTrip] = useState<TripSummary | null>(null);
    const [mapReady, setMapReady] = useState(false);
    const [contentH, setContentH] = useState(240);
    const [qrOpen, setQrOpen] = useState(false);
    const [qrUrl, setQrUrl] = useState<string | null>(null);
    const [stats, setStats] = useState<TripStats | null>(null);
    const framedRef = useRef(false);

    const load = useCallback(async () => {
        try {
            const trips = await fetchTrips();
            const found = trips.find(tr => tr.id === tripId) ?? null;
            setTrip(found);
            // Spend/savings appear once any receipt is in (stage-5 material).
            if (found && found.receiptCount > 0) {
                fetchTripStats(tripId).then(setStats).catch(() => {});
            }
        } catch {}
    }, [tripId]);
    useFocusEffect(useCallback(() => { load(); }, [load]));

    const slotsWithCoords = useMemo(
        () => (trip?.slots ?? []).filter((s): s is TripSlot & { latitude: number; longitude: number } =>
            s.latitude != null && s.longitude != null),
        [trip],
    );

    // Frame the camera around the trip's stores once both map + data exist.
    const frame = useCallback(() => {
        if (framedRef.current || !mapReady || slotsWithCoords.length === 0) return;
        framedRef.current = true;
        mapRef.current?.fitToCoordinates(
            slotsWithCoords.map(s => ({ latitude: s.latitude, longitude: s.longitude })),
            { edgePadding: { top: 120, right: 60, bottom: 320, left: 60 }, animated: false },
        );
    }, [mapReady, slotsWithCoords]);
    useFocusEffect(useCallback(() => { frame(); }, [frame]));

    // ── Slot pills: progress variant while shopping, state marks after ──────
    const pillSpecs: MapPillSpec[] = useMemo(() => slotsWithCoords.map(s => {
        const chainId = s.chainId ?? chainIdByName(s.chainName ?? '') ?? 0;
        if (trip?.stage === 3) {
            return {
                key: `t${tripId}-s${s.listId}-p${s.checkedCount}/${s.itemCount}`,
                chainId,
                lines: [`${s.checkedCount}/${s.itemCount}`],
                variant: 'progress' as const,
            };
        }
        const label = s.hasReceipt ? '✓' : s.receiptSkipped ? '—' : (s.storeName ?? s.chainName ?? '');
        return {
            key: `t${tripId}-s${s.listId}-${s.hasReceipt ? 'r' : s.receiptSkipped ? 'k' : 'n'}`,
            chainId,
            lines: [label],
            variant: s.hasReceipt ? 'cheapest' as const : 'neutral' as const,
        };
    }), [slotsWithCoords, trip?.stage, tripId]);
    const { uriFor, sizeFor, bakery } = useBakedPills(pillSpecs);

    // ── Sheet: overview page (slots, receipts, members) ─────────────────────
    const openSlot = useCallback((slot: TripSlot) => {
        router.push(`/shopping-list/${slot.listId}` as any);
    }, [router]);

    const openQr = useCallback(async () => {
        setQrOpen(true);
        setQrUrl(null);
        try { setQrUrl(await createTripInviteUrl(tripId)); } catch { setQrOpen(false); }
    }, [tripId]);

    // ── ZERO-DECISION SEARCH (stage 1-2): tap Parduotuvės → search with
    // defaults (GPS + saved store count), rank PLANS (combos + singles) and
    // push the plans page onto the sheet stack. ──────────────────────────────
    type Plan = { key: string; stores: StoreResult[]; combo: ScoredCombo | null; total: number };
    const [plans, setPlans] = useState<Plan[] | null>(null);
    const [planPath, setPlanPath] = useState<('plans' | Plan)[]>([]);
    const [searching, setSearching] = useState(false);
    const [creating, setCreating] = useState(false);

    const runSearch = useCallback(async () => {
        if (!trip?.basket || searching) return;
        setSearching(true);
        try {
            const gps = await tryGpsCoords();
            const coords = gps ?? (slotsWithCoords[0]
                ? { lat: slotsWithCoords[0].latitude, lng: slotsWithCoords[0].longitude }
                : { lat: 55.9349, lng: 23.3137 });
            const [pool, settings] = await Promise.all([
                buildCandidatePool({ lat: coords.lat, lng: coords.lng }),
                getLocationSettings(),
            ]);
            const origin = pool.searchCenter ?? coords;
            const body: Record<string, any> = { lat: origin.lat, lng: origin.lng };
            if (pool.storeIds.length > 0) body.storeIds = pool.storeIds;
            const res = await fetch(`${API_BASE_URL}/api/baskets/${trip.basket.id}/calculate`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const stores: StoreResult[] = await res.json();
            const itemsRes = await fetch(`${API_BASE_URL}/api/baskets/${trip.basket.id}/items`);
            const itemsData = await itemsRes.json().catch(() => []);
            const criticalIds = new Set<number>(
                (Array.isArray(itemsData) ? itemsData : []).filter((it: any) => it.isCritical).map((it: any) => Number(it.productId)));
            const maxStores = (settings.storeCount === 1 ? 1 : settings.storeCount === 2 ? 2 : 3) as 1 | 2 | 3;
            const combos = maxStores <= 1 ? [] : scoreAllCombinations(stores, criticalIds, maxStores);

            const ranked: Plan[] = [
                ...stores.map(st => ({ key: `s-${st.storeId}`, stores: [st], combo: null as ScoredCombo | null, total: st.total })),
                ...combos.filter(c => c.isViable && !c.hasMissingCritical)
                    .map(c => ({ key: `c-${c.storeIds.slice().sort((a, b) => a - b).join('-')}`, stores: c.stores, combo: c, total: c.splitTotal })),
            ].sort((a, b) => a.total - b.total).slice(0, 8);
            setPlans(ranked);
            setPlanPath(['plans']);
        } catch {
            Alert.alert(t('trips.searchErrorTitle'), t('trips.searchErrorBody'));
        } finally {
            setSearching(false);
        }
    }, [trip, searching, slotsWithCoords, t]);

    const createListsForPlan = useCallback(async (plan: Plan) => {
        if (!trip?.basket || creating) return;
        setCreating(true);
        try {
            const userId = await getUserId();
            for (const store of plan.stores) {
                const assigned = plan.combo
                    ? new Set(Object.entries(plan.combo.itemAssignments)
                        .filter(([, sid]) => sid === store.storeId).map(([pid]) => Number(pid)))
                    : null;
                const items = store.items
                    .filter((it: any) => (assigned ? assigned.has(it.productId) : !it.isMissing))
                    .map((it: any) => {
                        const wasSubstituted = it.isSubstituted || it.isCrossChainAverage;
                        return {
                            productId: it.productId,
                            storeProductId: wasSubstituted ? null : (it.storeProductId || null),
                            quantity: wasSubstituted
                                ? it.quantity
                                : (it.storeProductId ? (it.isWeighable ? it.quantity : it.packsNeeded || it.quantity) : it.quantity),
                            price: it.totalPrice,
                        };
                    });
                const res = await fetch(`${API_BASE_URL}/api/shopping-lists`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId, storeId: store.storeId, basketId: trip.basket.id, items }),
                });
                if (!res.ok && res.status !== 409) throw new Error(`HTTP ${res.status}`);
            }
            setPlans(null);
            setPlanPath([]);
            framedRef.current = false; // reframe on the new slot pills
            await load();
        } catch {
            Alert.alert(t('trips.searchErrorTitle'), t('results.errorCreateList'));
        } finally {
            setCreating(false);
        }
    }, [trip, creating, load, t]);

    const stageCtaAction = useCallback(() => {
        if (!trip) return;
        if (trip.stage <= 1 && trip.basket) { router.push(`/basket/${trip.basket.id}` as any); return; }
        if (trip.stage === 2 && trip.basket) { runSearch(); return; }
        if (trip.stage === 3 || trip.stage === 4) {
            const slot = trip.slots.find(s => trip.stage === 3
                ? s.listStatus === 'active'
                : (s.listStatus === 'completed' && !s.hasReceipt && !s.receiptSkipped)) ?? trip.slots[0];
            if (slot) openSlot(slot);
            return;
        }
        router.push('/receipt' as any);
    }, [trip, router, openSlot, runSearch]);

    const slotStatus = (s: TripSlot) => {
        if (s.listStatus === 'active') return t('trips.slotShopping', { have: s.checkedCount, total: s.itemCount });
        if (s.hasReceipt) return t('trips.slotReceiptIn');
        if (s.receiptSkipped) return t('trips.slotSkipped');
        return t('trips.slotAwaiting');
    };

    const planLabel = (pl: { stores: StoreResult[]; combo: ScoredCombo | null }) =>
        pl.combo
            ? pl.stores.map(st => st.chainName).join(' + ')
            : t('trips.planSingle', { chain: pl.stores[0]?.chainName ?? '' });

    const basePages: SheetPage[] = useMemo(() => [{
        key: 'overview',
        content: trip ? (
            <View style={styles.page}>
                {trip.slots.length > 0 && (
                    <>
                        <Text style={styles.section}>{t('trips.sheetStores')}</Text>
                        {trip.slots.map(s => (
                            <TouchableOpacity key={s.listId} style={styles.row} onPress={() => openSlot(s)}>
                                <ChainLogoChip chainId={s.chainId ?? chainIdByName(s.chainName ?? '') ?? 0} name={s.chainName ?? undefined} size={30} />
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.rowTitle} numberOfLines={1}>{s.storeName ?? s.chainName}</Text>
                                    <Text style={styles.rowMeta} numberOfLines={1}>{slotStatus(s)}</Text>
                                </View>
                                <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                            </TouchableOpacity>
                        ))}
                    </>
                )}
                <Text style={styles.section}>{t('trips.sheetMembers', { count: trip.memberCount })}</Text>
                <TouchableOpacity style={styles.row} onPress={openQr}>
                    <View style={styles.inviteIcon}>
                        <Ionicons name="qr-code-outline" size={18} color={colors.primary} />
                    </View>
                    <Text style={[styles.rowTitle, { color: colors.primary, flex: 1 }]}>{t('trips.invite')}</Text>
                </TouchableOpacity>
                {stats && stats.receiptCount > 0 && (
                    <>
                        <Text style={styles.section}>{t('trips.sheetStats')}</Text>
                        <View style={styles.statsRow}>
                            <View style={styles.statBox}>
                                <Text style={styles.statValue}>€{stats.totalSpent.toFixed(2)}</Text>
                                <Text style={styles.statLabel}>{t('trips.statSpent')}</Text>
                            </View>
                            <View style={styles.statBox}>
                                <Text style={[styles.statValue, { color: stats.savings >= 0 ? colors.success : colors.textPrimary }]}>
                                    €{Math.abs(stats.savings).toFixed(2)}
                                </Text>
                                <Text style={styles.statLabel}>
                                    {stats.savings >= 0 ? t('trips.statSaved') : t('trips.statOverpaid')}
                                </Text>
                            </View>
                        </View>
                        {stats.categoryBreakdown.slice(0, 3).map(c => (
                            <View key={c.categoryName} style={styles.catRow}>
                                <Text style={styles.catName} numberOfLines={1}>{c.categoryName}</Text>
                                <Text style={styles.catTotal}>€{c.total.toFixed(2)}</Text>
                            </View>
                        ))}
                    </>
                )}
                {trip.receiptCount > 0 && (
                    <>
                        <Text style={styles.section}>{t('trips.sheetReceipts', { count: trip.receiptCount })}</Text>
                        <TouchableOpacity style={styles.row} onPress={() => router.push('/receipt' as any)}>
                            <View style={styles.inviteIcon}>
                                <Ionicons name="receipt-outline" size={18} color={colors.primary} />
                            </View>
                            <Text style={[styles.rowTitle, { flex: 1 }]}>{t('trips.viewReceipts')}</Text>
                            <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                        </TouchableOpacity>
                    </>
                )}
            </View>
        ) : <MaterialProgress size="large" color={colors.primary} />,
    }], [trip, stats, styles, colors, t, openSlot, openQr, router]);

    // Find-My page stack: overview → plans → plan (X pops one level).
    const pages: SheetPage[] = useMemo(() => {
        const out = [...basePages];
        for (const entry of planPath) {
            if (entry === 'plans') {
                out.push({
                    key: 'plans',
                    content: (
                        <View style={styles.page}>
                            <View style={styles.pageHeader}>
                                <Text style={styles.pageTitle}>{t('trips.plansTitle')}</Text>
                                <TouchableOpacity style={styles.xBtn} onPress={() => setPlanPath([])} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                    <Ionicons name="close" size={18} color={colors.textSecondary} />
                                </TouchableOpacity>
                            </View>
                            {(plans ?? []).map(pl => (
                                <TouchableOpacity key={pl.key} style={styles.row} onPress={() => setPlanPath(['plans', pl])}>
                                    <View style={styles.planBadges}>
                                        {pl.stores.slice(0, 3).map((st, i) => (
                                            <ChainLogoChip key={st.storeId} chainId={st.chainId ?? 0} name={st.chainName} size={26}
                                                style={i > 0 ? { marginLeft: -8 } : null} />
                                        ))}
                                    </View>
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.rowTitle} numberOfLines={1}>{planLabel(pl)}</Text>
                                        <Text style={styles.rowMeta} numberOfLines={1}>
                                            {t('trips.planStores', { count: pl.stores.length })}
                                        </Text>
                                    </View>
                                    <Text style={styles.planTotal}>€{pl.total.toFixed(2)}</Text>
                                    <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                                </TouchableOpacity>
                            ))}
                        </View>
                    ),
                });
            } else {
                const pl = entry;
                out.push({
                    key: `plan-${pl.key}`,
                    content: (
                        <View style={styles.page}>
                            <View style={styles.pageHeader}>
                                <Text style={styles.pageTitle} numberOfLines={1}>{planLabel(pl)}</Text>
                                <TouchableOpacity style={styles.xBtn} onPress={() => setPlanPath(['plans'])} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                    <Ionicons name="close" size={18} color={colors.textSecondary} />
                                </TouchableOpacity>
                            </View>
                            {pl.stores.map(st => {
                                const assigned = pl.combo
                                    ? Object.values(pl.combo.itemAssignments).filter(sid => sid === st.storeId).length
                                    : st.items.filter((it: any) => !it.isMissing).length;
                                const subtotal = pl.combo
                                    ? st.items.filter((it: any) => pl.combo!.itemAssignments[it.productId] === st.storeId)
                                        .reduce((sum: number, it: any) => sum + (it.totalPrice || 0), 0)
                                    : st.total;
                                return (
                                    <View key={st.storeId} style={styles.row}>
                                        <ChainLogoChip chainId={st.chainId ?? 0} name={st.chainName} size={30} />
                                        <View style={{ flex: 1 }}>
                                            <Text style={styles.rowTitle} numberOfLines={1}>{st.storeName}</Text>
                                            <Text style={styles.rowMeta} numberOfLines={1}>
                                                {t('trips.planStoreLine', { count: assigned, km: st.distance?.toFixed(1) ?? '?' })}
                                            </Text>
                                        </View>
                                        <Text style={styles.planTotal}>€{subtotal.toFixed(2)}</Text>
                                    </View>
                                );
                            })}
                            <TouchableOpacity
                                style={[styles.createBtn, creating && { opacity: 0.6 }]}
                                onPress={() => createListsForPlan(pl)}
                                disabled={creating}
                            >
                                {creating
                                    ? <MaterialProgress color={colors.onPrimary} />
                                    : <Text style={styles.createBtnText}>{t('trips.createLists')}</Text>}
                            </TouchableOpacity>
                        </View>
                    ),
                });
            }
        }
        return out;
    }, [basePages, planPath, plans, styles, colors, t, creating, createListsForPlan]);

    const snaps = useMemo(() => {
        const full = Math.min(620, SHEET_HANDLE_H + BAR_H + contentH + 16);
        return [BAR_H + SHEET_HANDLE_H, Math.min(340, full), full];
    }, [contentH]);

    const initialRegion = {
        latitude: slotsWithCoords[0]?.latitude ?? VILNIUS_FALLBACK.lat,
        longitude: slotsWithCoords[0]?.longitude ?? VILNIUS_FALLBACK.lng,
        latitudeDelta: 0.05,
        longitudeDelta: 0.05,
    };

    return (
        <>
            <Stack.Screen options={{ headerShown: false }} />
            <MapHost
                mapRef={mapRef}
                initialRegion={initialRegion}
                onMapReady={() => { setMapReady(true); }}
                mapReady={mapReady}
                baseOverlay={
                    <View style={styles.backWrap}>
                        <GlassIconButton icon="chevron-back" glass solid onPress={() => router.back()} size={22} />
                    </View>
                }
                persistentOverlay={
                    <GlassStageSheet
                        snaps={snaps}
                        initialStage={1}
                        bar={(
                            <View style={[styles.bar, { height: BAR_H }]}>
                                <View style={styles.stageChip}>
                                    <Text style={styles.stageChipText}>{trip ? t(`trips.stage${trip.stage}`) : '…'}</Text>
                                </View>
                                <TouchableOpacity style={styles.ctaBtn} onPress={stageCtaAction} activeOpacity={0.85} disabled={searching}>
                                    {searching
                                        ? <MaterialProgress size="small" color={colors.onPrimary} />
                                        : <Text style={styles.ctaBtnText}>
                                            {trip ? (trip.stage === 2 ? t('trips.ctaStores') : t(`trips.cta${trip.stage}`)) : ''}
                                          </Text>}
                                </TouchableOpacity>
                            </View>
                        )}
                        pages={pages}
                        onPopPage={() => setPlanPath(p => p.slice(0, -1))}
                        onContentHeight={setContentH}
                        colors={colors}
                        bottomInset={bottomInset}
                    />
                }
            >
                {slotsWithCoords.map((s, i) => {
                    const spec = pillSpecs[i];
                    return (
                        <MapPillMarker
                            key={`slot-${s.listId}`}
                            coordinate={{ latitude: s.latitude, longitude: s.longitude }}
                            chainId={spec.chainId}
                            pillUri={uriFor(spec.key)}
                            pillSize={sizeFor(spec.key)}
                            zIndex={2}
                            onPress={() => openSlot(s)}
                        />
                    );
                })}
            </MapHost>
            {bakery}

            {/* Trip invite QR. */}
            <Modal visible={qrOpen} transparent animationType="fade" onRequestClose={() => setQrOpen(false)}>
                <TouchableOpacity style={styles.qrBackdrop} activeOpacity={1} onPress={() => setQrOpen(false)}>
                    <View style={styles.qrCard} onStartShouldSetResponder={() => true}>
                        <Text style={styles.qrTitle}>{t('trips.tripQrTitle')}</Text>
                        <Text style={styles.qrBody}>{t('trips.tripQrBody')}</Text>
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
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    backWrap: { position: 'absolute', left: spacing.md, zIndex: 20, top: 0, marginTop: 54 },
    bar: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingHorizontal: spacing.lg, gap: spacing.md,
    },
    stageChip: {
        backgroundColor: c.primaryMuted ?? c.surfaceMuted, borderRadius: radius.pill,
        paddingHorizontal: 10, paddingVertical: 5,
    },
    stageChipText: { fontSize: 12, fontWeight: '800', color: c.primary },
    ctaBtn: {
        backgroundColor: c.primary, borderRadius: radius.pill,
        paddingHorizontal: 18, paddingVertical: 10,
    },
    ctaBtnText: { fontSize: 14, fontWeight: '700', color: c.onPrimary },

    page: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
    section: {
        fontSize: 12, fontWeight: '700', color: c.textMuted,
        textTransform: 'uppercase', letterSpacing: 0.4,
        marginTop: spacing.md, marginBottom: spacing.xs,
    },
    row: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
        paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.borderSubtle,
    },
    rowTitle: { fontSize: 15, fontWeight: '600', color: c.textPrimary },
    rowMeta: { fontSize: 12, color: c.textSecondary, marginTop: 1 },
    inviteIcon: {
        width: 30, height: 30, borderRadius: 15,
        backgroundColor: c.primaryMuted ?? c.surfaceMuted,
        alignItems: 'center', justifyContent: 'center',
    },

    statsRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.sm },
    statBox: {
        flex: 1, backgroundColor: c.surfaceMuted, borderRadius: radius.md,
        paddingVertical: 10, alignItems: 'center',
    },
    statValue: { fontSize: 17, fontWeight: '800', color: c.textPrimary },
    statLabel: { fontSize: 11, color: c.textSecondary, marginTop: 2 },
    catRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
    catName: { flex: 1, fontSize: 13, color: c.textSecondary },
    catTotal: { fontSize: 13, fontWeight: '700', color: c.textPrimary },

    pageHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.sm },
    pageTitle: { fontSize: 17, fontWeight: '800', color: c.textPrimary, flex: 1 },
    xBtn: {
        width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
        backgroundColor: c.surfaceMuted,
    },
    planBadges: { flexDirection: 'row', alignItems: 'center' },
    planTotal: { fontSize: 15, fontWeight: '800', color: c.primary, marginRight: 4 },
    createBtn: {
        marginTop: spacing.lg, backgroundColor: c.primary, borderRadius: radius.pill,
        paddingVertical: 14, alignItems: 'center',
    },
    createBtnText: { color: c.onPrimary, fontWeight: '700', fontSize: 15 },

    qrBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: 28 },
    qrCard: { backgroundColor: c.cardBackground, borderRadius: radius.xl, padding: 22, gap: 10, alignItems: 'center', maxWidth: 380, width: '100%' },
    qrTitle: { fontSize: 17, fontWeight: '800', color: c.textPrimary },
    qrBody: { fontSize: 13, color: c.textSecondary, textAlign: 'center', lineHeight: 18 },
    qrBox: { padding: 16, alignItems: 'center', justifyContent: 'center', minHeight: 232 },
    qrClose: { paddingVertical: 10, paddingHorizontal: 24 },
    qrCloseText: { fontSize: 14, fontWeight: '700', color: c.primary },
});
