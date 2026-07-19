import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    Alert,
    InteractionManager,
 Switch, Modal } from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { StoreCountToggle } from '../map/StoreCountToggle';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect, useNavigation } from 'expo-router';
import React, { useMemo, useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Animated, { FadeIn, useSharedValue } from 'react-native-reanimated';
import { type GestureType } from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';
import { API_BASE_URL } from '../../config/api';
import { useTheme, spacing, radius, elevation, typography, iconSize, type AppTheme } from '../../constants/theme';
import { useBasketState } from '../../state/basketState';
import { useProfileStore } from '../../state/profileStore';
import { loadCachedCoords, tryGpsCoords, persistCoords, type UserCoords } from '../../utils/location';
import LocationPromptModal from '../LocationPromptModal';
import { scoreAllCombinations, type ScoredCombo } from '../../utils/splitBasketScore';
import { type StoreResult, fetchStorePrices } from '../../utils/basketPricing';
import { getStoreDirectory } from '../../utils/storeDirectory';
import { buildCandidatePool, type StoreLite } from '../../utils/candidatePool';
import { orderStopsNearestFirst, orderStopsAlongRoute, buildGoogleMapsRouteUrl } from '../../utils/multiStopRoute';
import { getPresets, getLocationSettings, saveLocationSettings, haversineKm } from '../../utils/locationStorage';
import StoreResultsMap, { type MapPin } from '../results/StoreResultsMap';
import StoreOptionsDock from '../results/StoreOptionsDock';
import { LiquidGlass } from '../LiquidGlass';
import { buildSplitOptions, TRIP_RADIUS_KM, type SheetOption } from '../../utils/splitOptions';
import { BrandedQR } from '../BrandedQR';
import { fetchTrips, createTripInviteUrl } from '../../utils/tripsApi';
import { formatEuro } from '../../utils/formatCurrency';
import { DockedGlassSheet, type DockedSheetControls } from '../DockedGlassSheet';
import { DockActionCard } from '../dock/DockActionCard';
import { DockSection } from '../dock/DockSection';
import { useDockTitleStyle } from '../dock/useDockTitleStyle';
import LocationSettingsPanel from '../LocationSettingsPanel';
import { PresetPointPicker } from '../PresetPointPicker';
import type { PresetKey, LocationPreset } from '../../utils/locationStorage';

// StoreResult / ItemResult now live in utils/basketPricing (shared with the
// lazy /store-prices fetch) — imported above.

/** Hard cap on the single-store list — near a city centre the calc can return
 *  hundreds of stores; we only ever show the top 10 ranked options. */
const MAX_SINGLE_STORES = 10;

/** Width (dp) of one digit segment in the 1·2·3 store-count toggle — also the
 *  sliding indicator's width. Fixed so the pill stays compact, not full-width. */


/**
 * The WORKING store-comparison map surface (price pills, 1·2·3 store-count
 * toggle, tap-a-store options sheet, create list) — extracted from the
 * /basket/results/[id] route so the trip-map Stores experience embeds the
 * exact same surface instead of recreating it (TRIP_MAP_SURFACE_PLAN.md).
 *
 * Standalone (route) mode: back button + own post-create navigation.
 * Embedded mode: `embedded` hides the back button, `bottomClearance` lifts
 * every floating bottom element above the host's tab-bar dock, and
 * `onListsCreated` replaces the post-create navigation.
 */
export default function StoreResultsSurface({ basketId, embedded = false, bottomClearance = 0, onListsCreated }: {
    basketId: string | number;
    embedded?: boolean;
    bottomClearance?: number;
    onListsCreated?: (tripId: number | null) => void;
}) {
    const colors = useTheme();
    const { t } = useTranslation();
    const { clearSessionBasket } = useBasketState();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { bottom: safeBottomInset, top: topInset } = useSafeAreaInsets();
    // Floating bottom UI (options sheet, hint, batch button) clears the host's
    // dock when embedded — the clearance is just extra bottom inset.
    const bottomInset = safeBottomInset + bottomClearance;
    const id = String(basketId);
    const router = useRouter();
    const navigation = useNavigation();
    const [results, setResults] = useState<StoreResult[]>([]);
    const [loading, setLoading] = useState(true);
    const [pullRefreshing, setPullRefreshing] = useState(false);
    const [selectedStoreId, setSelectedStoreId] = useState<number | null>(null);
    const [locationPromptVisible, setLocationPromptVisible] = useState(false);
    const [combos, setCombos] = useState<ScoredCombo[]>([]);
    // Max stores the user agreed to visit (location settings) — caps combo
    // scoring so a 1-store setting never surfaces 2/3-store splits. From the
    // calc meta; defaults to 3 only when meta is missing.
    const [maxStores, setMaxStores] = useState<1 | 2 | 3>(3);
    // Which option the user picked inside the bottom sheet for the tapped store
    // (a combo key, or the single-store key). null = sheet closed.
    const [selectedOptionKey, setSelectedOptionKey] = useState<string | null>(null);
    const [mapMounted, setMapMounted] = useState(false);
    const [userCoords, setUserCoords] = useState<{ lat: number; lng: number } | null>(null);
    // Route mode (location settings) → the two trip endpoints, so the map draws
    // routeFrom → stores → routeTo instead of a single-origin line.
    const [routeEndpoints, setRouteEndpoints] = useState<{
        from: { latitude: number; longitude: number };
        to: { latitude: number; longitude: number };
    } | null>(null);
    // All-Lithuania store directory (un-priced background layer) + on-demand
    // prices for stores the user taps outside the precomputed top-N.
    const [directory, setDirectory] = useState<StoreLite[]>([]);
    const [lazyResults, setLazyResults] = useState<StoreResult[]>([]);
    const [pricingStoreId, setPricingStoreId] = useState<number | null>(null);
    // Area-batch pricing: nearest un-priced stores reported by the map + a flag.
    const [visibleUnpriced, setVisibleUnpriced] = useState<number[]>([]);
    const [batchPricing, setBatchPricing] = useState(false);
    // Trip options (simplified flow): GPS/route settings, Saver mode and the
    // trip invite live on the MAP dock — the one place they change an outcome.
    const [saverMode, setSaverMode] = useState(false);
    const [inviteUrl, setInviteUrl] = useState<string | null>(null);
    const [inviteOpen, setInviteOpen] = useState(false);
    // Quiet reprice triggered by a location change inside the dock (place picked
    // / route completed). Unlike loadResults it does NOT flip global `loading`
    // (the dock stays open) — just a small spinner in the summary bar. The epoch
    // ref discards a superseded run if the user changes location again mid-fetch.
    const [recalcing, setRecalcing] = useState(false);
    const recalcEpochRef = useRef(0);
    // How much the store-options dock occludes the map (grows with its stage) so
    // the tapped store frames above the open sheet.
    const [storeOcclusion, setStoreOcclusion] = useState(0);
    useEffect(() => { void AsyncStorage.getItem('saverMode').then(v => setSaverMode(v === '1')); }, []);
    // ── Glass dock (same component as every new screen). Collapsed = the
    // price-summary bar; expanded = one scroll: Basket/Invite actions,
    // Calculation settings, Location & Route. ──────────────────────────────
    const dockRef = useRef<DockedSheetControls>(null);
    const [dockBarH, setDockBarH] = useState(44);
    const [dockClearance, setDockClearance] = useState(120);
    const [dockExpanded, setDockExpanded] = useState(false);
    // Sheet-over-Google-Maps (canonical RNGH fix): the map's native pan is
    // wrapped in a Gesture.Native and its ref handed to the dock, whose own
    // pan .blocksExternalGesture()s it — so a drag that begins on the bar
    // blocks the map on the native thread (no state toggles, no frame lag).
    // Continuous sheet progress (0 collapsed → 1 full), mirrored out of the
    // dock so the title font can track drag distance on the UI thread (#3).
    const sheetProgress = useSharedValue(0);
    // UI-thread flag: true while a touch is on the sheet → the map's pan is
    // disabled instantly (via useAnimatedProps), so the map can't swallow the
    // drag's move events. No JS-state lag.
    const mapPanBlocked = useSharedValue(false);
    // Reliable map-vs-sheet arbitration: the racy per-touch guards never held,
    // so instead the map is made NON-INTERACTIVE for as long as a sheet is open
    // above the collapsed bar. `storeSheetStage` (0 bar → >0 open) is reported by
    // the store dock; while a sheet is open the map ignores pan AND its leaked
    // onPress, so dragging the sheet's empty area can't move the map and tapping
    // an option can't deselect. `sheetOpenSV` mirrors it onto the UI thread for
    // the map's scrollEnabled animated prop.
    const [storeSheetStage, setStoreSheetStage] = useState(0);
    const anySheetOpen = selectedOptionKey != null ? storeSheetStage > 0 : dockExpanded;
    const sheetOpenSV = useSharedValue(false);
    useEffect(() => { sheetOpenSV.value = anySheetOpen; }, [anySheetOpen, sheetOpenSV]);
    // The map's native gesture, handed to both docks so their pan
    // `.blocksExternalGesture()`s it — a drag that begins on the collapsed bar
    // holds the map's native pan off on the native thread (wins the first drag,
    // which scrollEnabled can't since the map reads it at touch-down).
    const mapNativeGestureRef = useRef<GestureType | undefined>(undefined);
    // Title grows 15→20 when the sheet opens (like the catalog list sheet).
    const titleStyle = useDockTitleStyle(sheetProgress);
    const [settingsRefreshKey, setSettingsRefreshKey] = useState(0);
    // "Define a location" — an inline point-picker overlay that takes over the
    // whole screen (strips the store chrome + dock, shows a centre pin +
    // search). Back cancels and restores the map + dock to where it was.
    const [pickingPreset, setPickingPreset] = useState<{ key: PresetKey; label: string; existing: LocationPreset | null } | null>(null);
    const openPresetPicker = useCallback((key: PresetKey, label: string, existing: LocationPreset | null) => {
        dockRef.current?.collapse();
        setPickingPreset({ key, label, existing });
    }, []);
    const closePresetPicker = useCallback((saved: boolean) => {
        setPickingPreset(null);
        if (saved) setSettingsRefreshKey(k => k + 1);
        requestAnimationFrame(() => dockRef.current?.snapTo(1));
    }, []);
    // Basket item count for the "Basket" dock button.
    const [basketItemCount, setBasketItemCount] = useState(0);
    useEffect(() => {
        let alive = true;
        fetch(`${API_BASE_URL}/api/baskets/${id}/items`)
            .then(r => (r.ok ? r.json() : []))
            .then(rows => { if (alive) setBasketItemCount(Array.isArray(rows) ? rows.length : 0); })
            .catch(() => {});
        return () => { alive = false; };
    }, [id]);
    // Horizontal page slide (Actions ↔ Location & Route): the pages/row are
    // sized in PERCENTAGES and translated in percent too, so they track the
    // sheet's growing width on the UI thread with no JS measurement — the
    // side gaps stay constant at every drag position (matches the catalog
    // sheets, whose content tracks the edges via the built-in peek inset).
    const openInvite = useCallback(async () => {
        setInviteOpen(true);
        setInviteUrl(null);
        try {
            const trips = await fetchTrips();
            const trip = trips.find(tr => tr.basket?.id === Number(id));
            if (!trip) { setInviteOpen(false); return; }
            setInviteUrl(await createTripInviteUrl(trip.id));
        } catch { setInviteOpen(false); }
    }, [id]);

    // Load the directory once — cached on disk for a week, so this is usually
    // an instant memory/disk hit with no network.
    useEffect(() => {
        let alive = true;
        getStoreDirectory().then(d => { if (alive) setDirectory(d); }).catch(() => {});
        return () => { alive = false; };
    }, []);

    // Score every 1–3 store combination in the background (off the paint path)
    // so tapping any store instantly shows its single option plus the splits it
    // belongs to. Includes lazyResults so a store priced by tapping outside the
    // top-N becomes eligible for splits too (Q1: a tap re-anchors splits to that
    // store). The trip-radius cap in buildSplitOptions keeps cross-city pairs out.
    useEffect(() => {
        // Bound the combination pool: scoring is O(C(n,3)), and lazyResults can
        // accumulate across area-batch pricing. Keep the top-N results plus the
        // most recently priced lazy stores (the ones the user is exploring) so a
        // long session can't blow up to thousands of combos.
        const pool = [...results, ...lazyResults.slice(-15)];
        if (pool.length <= 1) { setCombos([]); return; }
        let alive = true;
        (async () => {
            try {
                const itemsRes = await fetch(`${API_BASE_URL}/api/baskets/${id}/items`);
                const itemsData = await itemsRes.json();
                const criticalIds = new Set<number>(
                    (itemsData as any[]).filter(it => it.isCritical).map(it => Number(it.productId)),
                );
                // `maxStores` (1/2/3) is the user's store-count setting — never
                // score wider combos than they agreed to visit.
                const scored = maxStores <= 1 ? [] : scoreAllCombinations(pool, criticalIds, maxStores);
                if (alive) setCombos(scored);
            } catch { /* non-fatal — stores still tappable as single options */ }
        })();
        return () => { alive = false; };
    }, [results, lazyResults, id, maxStores]);


    // Defer the heavy MapView mount until after the toggle's tap interaction so
    // switching to Žemėlapis feels instant (the capsule animates immediately,
    // the map appears a frame later).
    useEffect(() => {
        if (loading || mapMounted) return;
        const task = InteractionManager.runAfterInteractions(() => setMapMounted(true));
        return () => task.cancel();
    }, [loading, mapMounted]);

    const loadResults = async () => {
        // Detail screen now awaits the calc before pushing to this route,
        // so the cache is always populated on entry. The previous 30-second
        // polling loop was a workaround for the old fire-and-navigate
        // pattern and is no longer needed. If we still find an empty cache
        // (e.g., the user reverted the basket to draft from a parallel
        // stack, wiping this key), render the empty state immediately.
        setLoading(true);
        setSelectedStoreId(null);
        setSelectedOptionKey(null);
        setCombos([]);
        setLazyResults([]); // stale once the basket/results change

        const [stored, metaRaw, ls] = await Promise.all([
            AsyncStorage.getItem(`basket_results_${id}`),
            AsyncStorage.getItem(`basket_calc_meta_${id}`),
            getLocationSettings(),
        ]);
        // Store-count is the LIVE location setting (single source of truth) — not
        // frozen in the calc meta — so a change from Settings or the map's 1·2·3
        // toggle is reflected here without a recalc. Read it BEFORE results so
        // combo scoring runs once with the right limit (no 2/3-store flash).
        setMaxStores(ls.storeCount === 1 ? 1 : ls.storeCount === 2 ? 2 : 3);
        if (stored) {
            setResults(JSON.parse(stored) as StoreResult[]);
        } else {
            setResults([]);
        }
        // Starting location for the map (user dot + the route's first leg) = the
        // exact search centre the calc used, persisted in the meta. It's the
        // accurate origin even for preset/bus modes, and unlike the cached GPS
        // coords it has no TTL. (Route mode has no single centre → null; the
        // focus effect then falls back to cached GPS coords.)
        let center: { lat: number; lng: number } | null = null;
        let endpoints: typeof routeEndpoints = null;
        try {
            const meta = metaRaw ? JSON.parse(metaRaw) : null;
            const c = meta?.searchCenter;
            if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) center = { lat: c.lat, lng: c.lng };
            // Route mode → resolve the two endpoint presets to coordinates.
            const s = meta?.settings;
            if (s?.mode === 'route' && s.routeFrom && s.routeTo) {
                const presets = await getPresets();
                const f = presets[s.routeFrom as 'home' | 'work' | 'custom'];
                const to = presets[s.routeTo as 'home' | 'work' | 'custom'];
                if (f && to) {
                    endpoints = {
                        from: { latitude: f.lat, longitude: f.lng },
                        to: { latitude: to.lat, longitude: to.lng },
                    };
                }
            }
        } catch { /* ignore — fall back to single-origin behaviour */ }
        setRouteEndpoints(endpoints);
        if (center) {
            setUserCoords(center);
        } else if (!endpoints) {
            // No single centre (and not route mode) → cached GPS coords.
            const cached = await loadCachedCoords();
            if (cached) setUserCoords({ lat: cached.lat, lng: cached.lng });
        }
        setLoading(false);
    };

    const runRecalcWithCoords = useCallback(async (coords: UserCoords, isPull = false) => {
        if (!isPull) setLoading(true);
        setSelectedStoreId(null);
        try {
            // SAME contract as the basket screen's calc: honour the location
            // settings — candidate pool from the settings, and the calculate
            // origin = the settings-resolved centre (place/bus), falling back
            // to the resolved coords (current/route modes). Previously this
            // recalc posted raw GPS with NO pool, silently reverting a
            // place-mode basket to closest-stores-around-me.
            const [pool, settings] = await Promise.all([
                buildCandidatePool({ lat: coords.lat, lng: coords.lng }),
                getLocationSettings(),
            ]);
            const origin = pool.searchCenter ?? coords;
            const body: Record<string, any> = { lat: origin.lat, lng: origin.lng };
            if (pool.storeIds.length > 0) body.storeIds = pool.storeIds;
            const res = await fetch(`${API_BASE_URL}/api/baskets/${id}/calculate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const newResults = await res.json();
            await Promise.all([
                AsyncStorage.setItem(`basket_results_${id}`, JSON.stringify(newResults)),
                AsyncStorage.setItem(`basket_calc_meta_${id}`, JSON.stringify({
                    storeCount: settings.storeCount,
                    searchCenter: pool.searchCenter,
                    settings,
                })),
            ]);
            await persistCoords(coords);
            setUserCoords({ lat: origin.lat, lng: origin.lng });
            setResults(newResults);
            setSelectedOptionKey(null);
            setLazyResults([]); // re-priced basket → old lazy prices are stale
            setLoading(false);
        } catch {
            Alert.alert(t('results.errorTitle'), t('results.errorRecalc'));
            setLoading(false);
        }
    }, [id]);

    const handleRecalculate = useCallback(async () => {
        const cached = await loadCachedCoords();
        if (cached) { await runRecalcWithCoords(cached); return; }
        const gps = await tryGpsCoords();
        if (gps) { await runRecalcWithCoords(gps); return; }
        setLocationPromptVisible(true);
    }, [runRecalcWithCoords]);

    // A location change inside the dock (Place picked / Route completed / GPS /
    // transport) → quietly reprice from that location and refocus the map. The
    // candidate pool + origin are resolved from the freshly-saved settings
    // (place → its preset, route → the corridor between endpoints, current →
    // GPS). Keeps the dock open (no global loading) and never persists a preset
    // as the cached GPS location.
    const recalcForLocationChange = useCallback(async () => {
        const epoch = ++recalcEpochRef.current;
        setRecalcing(true);
        setSelectedStoreId(null);
        setSelectedOptionKey(null);
        try {
            const [settings, presets] = await Promise.all([getLocationSettings(), getPresets()]);

            // Route mode → resolve both endpoints for the map's route line.
            let endpoints: typeof routeEndpoints = null;
            if (settings.mode === 'route' && settings.routeFrom && settings.routeTo) {
                const f = presets[settings.routeFrom];
                const to = presets[settings.routeTo];
                if (f && to) endpoints = {
                    from: { latitude: f.lat, longitude: f.lng },
                    to: { latitude: to.lat, longitude: to.lng },
                };
            }

            // Calc origin: place → its preset coords; otherwise cached/GPS. The
            // real GPS fix is kept separately so only 'current' mode persists it.
            let coords: { lat: number; lng: number } | null = null;
            let gpsCoords: UserCoords | null = null;
            if (settings.mode === 'specific' && settings.specificPreset) {
                const p = presets[settings.specificPreset];
                if (p) coords = { lat: p.lat, lng: p.lng };
            }
            if (!coords) {
                gpsCoords = (await loadCachedCoords()) ?? (await tryGpsCoords());
                coords = gpsCoords;
            }
            if (!coords && !endpoints) { if (epoch === recalcEpochRef.current) setRecalcing(false); return; }

            const pool = await buildCandidatePool(coords ?? undefined);
            const origin = pool.searchCenter
                ?? (endpoints ? { lat: endpoints.from.latitude, lng: endpoints.from.longitude } : coords!);
            const body: Record<string, any> = { lat: origin.lat, lng: origin.lng };
            if (pool.storeIds.length > 0) body.storeIds = pool.storeIds;

            const res = await fetch(`${API_BASE_URL}/api/baskets/${id}/calculate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const newResults = await res.json();
            // A newer location change started while we were fetching → drop this
            // stale result rather than clobbering the fresher one.
            if (epoch !== recalcEpochRef.current) return;

            await Promise.all([
                AsyncStorage.setItem(`basket_results_${id}`, JSON.stringify(newResults)),
                AsyncStorage.setItem(`basket_calc_meta_${id}`, JSON.stringify({
                    storeCount: settings.storeCount,
                    searchCenter: pool.searchCenter,
                    settings,
                })),
            ]);
            // Only 'current' mode reflects the user's real position → persist it.
            // A preset/route origin must NOT overwrite the cached GPS coords.
            if (settings.mode === 'current' && gpsCoords) await persistCoords(gpsCoords);

            setRouteEndpoints(endpoints);
            setUserCoords(endpoints ? null : { lat: origin.lat, lng: origin.lng });
            setResults(newResults as StoreResult[]);
            setLazyResults([]); // re-priced basket → old lazy prices are stale
        } catch {
            // Non-fatal — keep the previous prices/map on a failed reprice.
        } finally {
            if (epoch === recalcEpochRef.current) setRecalcing(false);
        }
    }, [id]);

    const handlePullRefresh = useCallback(async () => {
        setPullRefreshing(true);
        try {
            let blocked = false;
            try {
                const res = await fetch(`${API_BASE_URL}/api/baskets/${id}`);
                const basket = await res.json();
                if (basket?.status === 'inProgress' || basket?.status === 'completed') {
                    blocked = true;
                }
            } catch {}
            if (blocked) { await loadResults(); return; }
            const cached = await loadCachedCoords();
            if (cached) { await runRecalcWithCoords(cached, true); }
            else {
                const gps = await tryGpsCoords();
                if (gps) { await runRecalcWithCoords(gps, true); }
                else { setLocationPromptVisible(true); }
            }
        } finally {
            setPullRefreshing(false);
        }
    }, [runRecalcWithCoords, id]);

    // The full header config (Parduotuvės/Žemėlapis toggle + back chevron).
    // Kept in a ref so the focus effect can re-assert it without depending on
    // `view` (which would re-run loadResults on every toggle).
    const headerCfgRef = useRef<() => void>(() => {});
    headerCfgRef.current = () => {
        // Results is map-only now → full-bleed map, no native header.
        navigation.setOptions({ headerShown: false });
    };
    useLayoutEffect(() => { headerCfgRef.current(); }, [colors]);

    useFocusEffect(useCallback(() => {
        // Re-assert the header here — after expo-router's own focus event —
        // because an unregistered screen has its options reset to defaults on
        // focus, which otherwise blanks the toggle until the next re-render.
        headerCfgRef.current();

        // Store results render regardless of pending mandatory swipes — the
        // comparison is never gated behind card-swiping. loadResults owns
        // userCoords (calc search-centre primary; see below for the fallback).
        loadResults();
    }, [id, navigation, handleRecalculate, colors.primary]));

    // Results arrive pre-sorted by the calc service (fewest missing →
    // fewest CCA → fewest substituted → lowest total). results[0] is
    // therefore always the recommended option, even on price ties — the
    // tiebreak chain has already settled them. Earlier code returned
    // null on ties, which made the "Daugiau" collapse fall through to
    // showing every store.
    const cheapestStoreId: number | null = results[0]?.storeId ?? null;
    // Collapsed-bar summary: the cheapest basket total + how many stores are
    // priced (the title that stays at the top of the sheet as it expands).
    const pricedCount = useMemo(() => {
        const ids = new Set<number>();
        for (const r of results) ids.add(r.storeId);
        for (const r of lazyResults) ids.add(r.storeId);
        return ids.size;
    }, [results, lazyResults]);

    // Priced stores shown as pills: the top-N results plus any store the user
    // lazily priced by tapping its directory pin (deduped by id). Pins are now
    // UNIFORM — every pin shows its own standalone basket price, whether or not
    // the store is part of a split.
    const singleStores = useMemo(() => results.slice(0, MAX_SINGLE_STORES), [results]);
    const singlePriced = useMemo(() => {
        const byId = new Map<number, StoreResult>();
        for (const s of singleStores) byId.set(s.storeId, s);
        for (const r of lazyResults) if (!byId.has(r.storeId)) byId.set(r.storeId, r);
        return [...byId.values()];
    }, [singleStores, lazyResults]);

    // Options for the tapped store: splits it belongs to (ranked best→worst,
    // within the 10km trip radius, saving framed vs the average store) plus its
    // single-store baseline last. Pure logic lives in utils/splitOptions.
    const buildOptions = useCallback(
        (storeId: number): SheetOption[] => buildSplitOptions(combos, results, lazyResults, storeId),
        [combos, results, lazyResults],
    );

    const selectedOptions = useMemo(
        () => (selectedStoreId == null ? [] : buildOptions(selectedStoreId)),
        [selectedStoreId, buildOptions],
    );
    const selectedOption = useMemo(
        () => selectedOptions.find(o => o.key === selectedOptionKey) ?? selectedOptions[0] ?? null,
        [selectedOptions, selectedOptionKey],
    );
    // Action targets derived from the chosen option.
    const selectedStore = selectedOption && selectedOption.stores.length === 1 ? selectedOption.stores[0] : null;
    const selectedCombo = selectedOption?.combo ?? null;

    // Per store: the price of the CHEAPEST option it belongs to — its own
    // basket total, or the best in-radius split it's part of (then the pin shows
    // the combo's price). Plus the globally cheapest option's stores = the
    // recommended set (one store if a single wins, 2-3 if a split wins).
    const { pinPriceByStore, pinComboByStore, recommendedStoreIds, recommendedStores, recommendedTotal } = useMemo(() => {
        const richById = new Map<number, StoreResult>();
        for (const r of results) richById.set(r.storeId, r);
        for (const r of lazyResults) if (!richById.has(r.storeId)) richById.set(r.storeId, r);

        const priceByStore = new Map<number, number>();
        for (const [, r] of richById) priceByStore.set(r.storeId, r.total);
        // storeId → the combo that provided its shown price (null = a single
        // total won). Drives the pill's partner badge: the price is a split
        // total, so show WHO it splits with.
        const comboByStore = new Map<number, ScoredCombo>();

        // Global best starts as the recommended single store; a cheaper in-radius
        // split takes over.
        let best: { price: number; ids: number[]; stores: StoreResult[] } | null =
            results[0] ? { price: results[0].total, ids: [results[0].storeId], stores: [results[0]] } : null;

        for (const c of combos) {
            if (c.stores.length <= 1 || c.extraDistanceKm > TRIP_RADIUS_KM) continue;
            for (const sid of c.storeIds) {
                const cur = priceByStore.get(sid);
                if (cur == null || c.splitTotal < cur) {
                    priceByStore.set(sid, c.splitTotal);
                    comboByStore.set(sid, c);
                }
            }
            if (!best || c.splitTotal < best.price) {
                const stores = c.storeIds.map(id => richById.get(id)).filter((s): s is StoreResult => !!s);
                if (stores.length === c.storeIds.length) best = { price: c.splitTotal, ids: c.storeIds, stores };
            }
        }
        return {
            pinPriceByStore: priceByStore,
            pinComboByStore: comboByStore,
            recommendedStoreIds: new Set(best?.ids ?? []),
            recommendedStores: best?.stores ?? [],
            // The globally cheapest total — a split combo when one beats every
            // single store, else the cheapest single. Drives the summary bar.
            recommendedTotal: best?.price ?? null,
        };
    }, [results, lazyResults, combos]);

    // Summary-bar total: the cheapest option overall (combo-aware), not just the
    // cheapest single store.
    const cheapestTotal = recommendedTotal;

    // Per-store SHARE of the selected split: Σ of the assigned items' line
    // totals at that store — mirrors splitBasketScore's splitTotal sum exactly,
    // so the members' shares add up to the option total shown before the tap.
    const selectedShareByStore = useMemo(() => {
        const shares = new Map<number, number>();
        const combo = selectedOption?.combo;
        if (!combo) return shares;
        const itemsByStore = new Map<number, Map<number, number>>(); // storeId → productId → totalPrice
        for (const s of selectedOption!.stores) {
            const m = new Map<number, number>();
            for (const it of s.items) if (!it.isMissing && it.totalPrice != null) m.set(it.productId, it.totalPrice);
            itemsByStore.set(s.storeId, m);
        }
        for (const [pidStr, sid] of Object.entries(combo.itemAssignments)) {
            const line = itemsByStore.get(sid)?.get(Number(pidStr));
            if (line != null) shares.set(sid, (shares.get(sid) ?? 0) + line);
        }
        // Round to cents so the pills show clean figures.
        for (const [sid, v] of shares) shares.set(sid, Math.round(v * 100) / 100);
        return shares;
    }, [selectedOption]);

    // Stores shown as pills = the priced set, plus the recommended option's
    // stores and any member of the selected option (so a recommended/chosen
    // split's stores always have a pill, even if one ranked outside the top-N).
    const pinStores = useMemo(() => {
        const byId = new Map<number, StoreResult>();
        for (const s of singlePriced) byId.set(s.storeId, s);
        for (const s of recommendedStores) if (!byId.has(s.storeId)) byId.set(s.storeId, s);
        if (selectedOption) for (const s of selectedOption.stores) if (!byId.has(s.storeId)) byId.set(s.storeId, s);
        return [...byId.values()];
    }, [singlePriced, recommendedStores, selectedOption]);

    const activeIds = useMemo(() => new Set(selectedOption?.storeIds ?? []), [selectedOption]);
    const pins: MapPin[] = useMemo(() =>
        pinStores
            .filter(s => s.latitude != null && s.longitude != null)
            .map(s => {
                const active = activeIds.has(s.storeId);
                // UNSELECTED: the cheapest option's price (a split shows the combo
                // TOTAL + the partner's badge). SELECTED member: the pin's OWN
                // figure — its share of the split (or its single total) — and the
                // partner badge hides (the drawn route already shows the pairing).
                let euro = pinPriceByStore.get(s.storeId) ?? s.total;
                let partnerChainIds: number[] = [];
                if (active && selectedOption) {
                    euro = selectedOption.combo
                        ? (selectedShareByStore.get(s.storeId) ?? euro)
                        : (selectedOption.stores.find(st => st.storeId === s.storeId)?.total ?? euro);
                } else {
                    const combo = pinComboByStore.get(s.storeId);
                    // ALL partners: 2-store combo → 1 badge, 3-store → 2 stacked.
                    partnerChainIds = combo
                        ? combo.stores.filter(st => st.storeId !== s.storeId).map(st => st.chainId)
                        : [];
                }
                return {
                    storeId: s.storeId, chainId: s.chainId, chainName: s.chainName,
                    miniLogoUrl: s.chainMiniLogoUrl ?? s.chainLogoUrl ?? null,
                    latitude: s.latitude as number, longitude: s.longitude as number,
                    euro,
                    active,
                    recommended: recommendedStoreIds.has(s.storeId), // all stores of the best option
                    partnerChainIds,
                };
            }),
        [pinStores, activeIds, pinPriceByStore, pinComboByStore, selectedShareByStore, selectedOption, recommendedStoreIds]);

    // The recommended option's store coordinates — the map frames ALL of them on
    // load (fit for a split, center for a single) so a combo partner is never
    // left outside the initial viewport.
    const recommendedCoords = useMemo(() => {
        const stores = recommendedStores.length
            ? recommendedStores
            : [singlePriced.find(x => x.storeId === cheapestStoreId)].filter((x): x is NonNullable<typeof x> => !!x);
        const cs = stores
            .filter(s => s.latitude != null && s.longitude != null)
            .map(s => ({ latitude: s.latitude as number, longitude: s.longitude as number }));
        return cs.length ? cs : null;
    }, [recommendedStores, singlePriced, cheapestStoreId]);

    // Coords the map zooms to: the selected option's store(s), or null = fit all.
    const focusCoords = useMemo(() => {
        if (!selectedOption) return null;
        const cs = selectedOption.stores
            .filter(s => s.latitude != null && s.longitude != null)
            .map(s => ({ latitude: s.latitude as number, longitude: s.longitude as number }));
        return cs.length ? cs : null;
    }, [selectedOption]);

    const handlePinTap = useCallback((storeId: number) => {
        setSelectedStoreId(storeId);
        setSelectedOptionKey(null); // default to the best option for this store
    }, []);
    const handleSelectOption = useCallback((key: string) => setSelectedOptionKey(key), []);
    const closeSheet = useCallback(() => { setSelectedStoreId(null); setSelectedOptionKey(null); setStoreSheetStage(0); }, []);
    // The MapView's native onPress leaks through the GL surface for taps that
    // land on the floating dock too (no gesture arbitration there). The dock
    // stamps this on every touch that begins on it; a map-press within the window
    // is that same leaked tap — ignore it so choosing an option never deselects.
    // Tap the map to deselect — but ONLY when no sheet is open above the bar.
    // PRIMARY guard: while a sheet is open the map is non-interactive, so a
    // leaked onPress from tapping an option (or the sheet's empty area) must
    // never reach closeSheet. The timestamp stays as a backstop for the brief
    // open-snap window where the reported stage is still settling.
    const sheetPressRef = useRef(0);
    const noteSheetPress = useCallback(() => { sheetPressRef.current = Date.now(); }, []);
    const handleMapTap = useCallback(() => {
        if (anySheetOpen || Date.now() - sheetPressRef.current < 400) return;
        closeSheet();
    }, [anySheetOpen, closeSheet]);

    // Live store-count toggle (1/2/3) on the map. Pure CLIENT re-rank — combos
    // are scored from the already-priced stores, so no server recalc/spinner.
    // Closes the open sheet (so a now-gone combo option can't go stale) and
    // lets the map reframe to the new recommendation; persists to the calc meta
    // so the choice survives re-entering these results.
    const setStoreCount = useCallback(async (n: 1 | 2 | 3) => {
        if (n === maxStores) return;
        setMaxStores(n);
        closeSheet();
        // Persist to the GLOBAL location setting so the basket's settings button
        // reflects it on back, and it stays in sync everywhere. Store-count no
        // longer affects pricing, so this never forces a recalc.
        try { await saveLocationSettings({ storeCount: n }); } catch {}
    }, [maxStores, closeSheet]);

    // Stores that already carry a price pill — excluded from the directory layer.
    const pricedStoreIds = useMemo(
        () => new Set(pins.map(p => p.storeId)),
        [pins],
    );

    // Coords used for on-demand pricing (distance + approximation pool). In
    // route mode userCoords is null, so fall back to the trip's start point.
    const pricingCoords = useMemo<{ lat: number; lng: number } | null>(() => {
        if (userCoords) return { lat: userCoords.lat, lng: userCoords.lng };
        if (routeEndpoints) return { lat: routeEndpoints.from.latitude, lng: routeEndpoints.from.longitude };
        return null;
    }, [userCoords, routeEndpoints]);

    // Tap an un-priced directory store → price the basket there on demand, then
    // open its option sheet. Stores already priced anywhere (a top-N pill, a
    // lower-ranked `results` store, or a previously lazy-priced one) just open
    // their sheet — re-fetching them would hit /store-prices and risk a total
    // that disagrees with the calculate result (the pin-vs-card €0.00 mismatch).
    const handleLazyPrice = useCallback(async (storeId: number) => {
        const known = results.some(r => r.storeId === storeId) || lazyResults.some(r => r.storeId === storeId);
        if (known || pricedStoreIds.has(storeId)) { setSelectedStoreId(storeId); setSelectedOptionKey(null); return; }
        if (pricingStoreId != null) return; // one in-flight at a time
        setPricingStoreId(storeId);
        try {
            const coords = pricingCoords;
            const res = await fetchStorePrices(Number(id), [storeId], coords);
            const priced = res.find(r => r.storeId === storeId);
            if (priced) {
                setLazyResults(prev => prev.some(r => r.storeId === storeId) ? prev : [...prev, priced]);
                setSelectedStoreId(storeId);
                setSelectedOptionKey(null);
            } else {
                Alert.alert('Nėra kainos', 'Šioje parduotuvėje nepavyko įkainoti krepšelio.');
            }
        } catch {
            Alert.alert(t('results.errorTitle'), t('results.errorGetPrice'));
        } finally {
            setPricingStoreId(null);
        }
    }, [id, pricingCoords, pricedStoreIds, pricingStoreId, results, lazyResults]);

    // Area-batch: price every un-priced store the map currently shows (the
    // nearest 10 it reported), in one request, so panning to a new area and
    // filling it in is one tap instead of many.
    const handleBatchPrice = useCallback(async () => {
        if (batchPricing || visibleUnpriced.length === 0) return;
        setBatchPricing(true);
        try {
            const coords = pricingCoords;
            const res = await fetchStorePrices(Number(id), visibleUnpriced, coords);
            if (res.length) {
                setLazyResults(prev => {
                    const have = new Set(prev.map(r => r.storeId));
                    const add = res.filter(r => !have.has(r.storeId));
                    return add.length ? [...prev, ...add] : prev;
                });
            }
        } catch {
            Alert.alert(t('results.errorTitle'), t('results.errorPriceStores'));
        } finally {
            setBatchPricing(false);
        }
    }, [batchPricing, visibleUnpriced, id, pricingCoords]);

    // Vykti for the selected option (single or split). In ROUTE mode it's a
    // through-trip: routeFrom → stores (ordered along the way) → routeTo. In all
    // other modes it's: your location → stores (nearest-first).
    const handleNavigateSelected = useCallback(() => {
        if (!selectedOption) return;
        const stops = selectedOption.stores
            .filter(s => s.latitude != null && s.longitude != null)
            .map(s => ({ latitude: s.latitude as number, longitude: s.longitude as number }));
        if (stops.length === 0) return;
        const { Linking } = require('react-native');
        let url: string;
        if (routeEndpoints) {
            const ordered = orderStopsAlongRoute(routeEndpoints.from, routeEndpoints.to, stops);
            url = buildGoogleMapsRouteUrl(routeEndpoints.from, [...ordered, routeEndpoints.to]);
        } else {
            const origin = userCoords ? { latitude: userCoords.lat, longitude: userCoords.lng } : null;
            url = buildGoogleMapsRouteUrl(origin, orderStopsNearestFirst(origin, stops));
        }
        Linking.openURL(url);
    }, [selectedOption, userCoords, routeEndpoints]);

    // The in-app route line for ANY selected option. ROUTE mode: routeFrom →
    // stores (ordered along the way) → routeTo. Otherwise: starting location →
    // store(s), nearest-first — same order the Vykti handoff uses.
    const routeCoords = useMemo(() => {
        if (!selectedOption) return null;
        const stops = selectedOption.stores
            .filter(s => s.latitude != null && s.longitude != null)
            .map(s => ({ latitude: s.latitude as number, longitude: s.longitude as number }));
        if (stops.length === 0) return null;
        if (routeEndpoints) {
            const ordered = orderStopsAlongRoute(routeEndpoints.from, routeEndpoints.to, stops);
            return [routeEndpoints.from, ...ordered, routeEndpoints.to];
        }
        const origin = userCoords ? { latitude: userCoords.lat, longitude: userCoords.lng } : null;
        // Need at least two points to draw: origin + store, or two stores.
        if (!origin && stops.length < 2) return null;
        const ordered = orderStopsNearestFirst(origin, stops);
        return origin ? [origin, ...ordered] : ordered;
    }, [selectedOption, userCoords, routeEndpoints]);

    // Total journey distance for the selected option's Navigate button — the sum
    // of the ordered legs the map draws (origin → stores → [route end]). Same
    // path as routeCoords, so GPS/place (from current location) and route mode
    // (start → stores → end) are both covered. null when there's no origin.
    const journeyKm = useMemo(() => {
        if (!routeCoords || routeCoords.length < 2) return null;
        let km = 0;
        for (let i = 0; i < routeCoords.length - 1; i++) {
            km += haversineKm(routeCoords[i].latitude, routeCoords[i].longitude, routeCoords[i + 1].latitude, routeCoords[i + 1].longitude);
        }
        return km;
    }, [routeCoords]);

    const [creatingList, setCreatingList] = useState(false);

    const handleCreateShoppingList = async () => {
        // Route to split-list creation when a multi-store combo is selected
        if (selectedCombo && !selectedStore) {
            await handleCreateSplitShoppingList();
            return;
        }
        if (!selectedStore || creatingList) return;
        setCreatingList(true);
        try {
            const { getUserId } = await import('../../config/user');
            const userId = await getUserId();

            // "Padėjai sutaupyti" basis = average of the UNIQUE full-coverage
            // store totals − the store the user chose. Deduping the totals
            // (rounded to cents) stops a cluster of equally-cheap stores near
            // the user from skewing the average down; only full-coverage stores
            // count so a partial basket can't pollute it. Accrued server-side
            // onto the template's collectiveSavingsEur, once per basket.
            const round2 = (n: number) => Math.round(n * 100) / 100;
            let savingsEur = 0;
            if (selectedStore.missingItemNames.length === 0) {
                const uniqueTotals = [...new Set(
                    results
                        .filter(r => r.missingItemNames.length === 0)
                        .map(r => round2(r.total)),
                )];
                if (uniqueTotals.length > 1) {
                    const avg = uniqueTotals.reduce((s, v) => s + v, 0) / uniqueTotals.length;
                    savingsEur = Math.max(0, round2(avg - selectedStore.total));
                }
            }

            const body = {
                userId,
                storeId: selectedStore.storeId,
                basketId: Number(id),
                savingsEur,
                items: selectedStore.items.map(item => {
                    const wasSubstituted =
                        (item as any).isSubstituted || (item as any).isCrossChainAverage;
                    return {
                        productId: item.productId,
                        storeProductId: wasSubstituted ? null : (item.storeProductId || null),
                        quantity: wasSubstituted
                            ? item.quantity
                            : (item.storeProductId
                                ? (item.isWeighable ? item.quantity : item.packsNeeded || item.quantity)
                                : item.quantity),
                        price: item.totalPrice,
                    };
                }),
            };

            const res = await fetch(`${API_BASE_URL}/api/shopping-lists`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (res.status === 409) {
                const data = await res.json();
                clearSessionBasket();
                if (onListsCreated) { onListsCreated(null); return; }
                router.dismissAll();
                router.navigate('/shopping-list' as any);
                setTimeout(() => {
                    router.push(`/shopping-list/${data.listId}` as any);
                }, 100);
                return;
            }
            if (!res.ok) {
                const errorText = await res.text().catch(() => '');
                throw new Error(`HTTP ${res.status}: ${errorText.slice(0, 200)}`);
            }
            const listData = await res.json();
            if (!listData?.id) throw new Error('Response missing id');

            clearSessionBasket();
            useProfileStore.getState().invalidate();
            if (onListsCreated) { onListsCreated(listData.tripId ?? null); return; }
            router.dismissAll();
            // 2.0: the trip map is the journey's home — land there (stage 3,
            // progress pills) instead of the flat lists screen.
            if (listData.tripId) {
                router.navigate(`/trip/${listData.tripId}` as any);
            } else {
                router.navigate('/shopping-list' as any);
                setTimeout(() => {
                    router.push(`/shopping-list/${listData.id}` as any);
                }, 100);
            }
        } catch (error: any) {
            Alert.alert(t('results.errorTitle'), t('results.errorCreateList'));
        } finally {
            setCreatingList(false);
        }
    };

    const handleCreateSplitShoppingList = async () => {
        if (!selectedCombo || creatingList) return;
        setCreatingList(true);
        try {
            const { getUserId } = await import('../../config/user');
            const userId = await getUserId();

            const createdLists: { storeId: number; storeName: string; storeAddress: string; chainName: string; chainLogoUrl: string | null; listId: number }[] = [];
            let splitTripId: number | null = null;

            // Lists (and their store tabs on the shopping screen) follow the
            // nearest→furthest order — the LAST tab is the furthest store.
            const orderedStores = [...selectedCombo.stores]
                .sort((a, b) => (a.distance ?? Number.MAX_VALUE) - (b.distance ?? Number.MAX_VALUE));
            for (const store of orderedStores) {
                const assignedPids = new Set(
                    Object.entries(selectedCombo.itemAssignments)
                        .filter(([, sid]) => sid === store.storeId)
                        .map(([pid]) => Number(pid)),
                );
                const storeItems = store.items
                    .filter(item => assignedPids.has(item.productId))
                    .map(item => {
                        const it = item as any;
                        const wasSubstituted = it.isSubstituted || it.isCrossChainAverage;
                        return {
                            productId: item.productId,
                            storeProductId: wasSubstituted ? null : (it.storeProductId || null),
                            quantity: wasSubstituted
                                ? it.quantity
                                : (it.storeProductId
                                    ? (it.isWeighable ? it.quantity : it.packsNeeded || it.quantity)
                                    : it.quantity),
                            price: item.totalPrice,
                        };
                    });

                const res = await fetch(`${API_BASE_URL}/api/shopping-lists`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId, storeId: store.storeId, basketId: Number(id), items: storeItems }),
                });
                if (res.status === 409) {
                    const data = await res.json();
                    createdLists.push({ storeId: store.storeId, storeName: store.storeName, storeAddress: store.storeAddress, chainName: store.chainName, chainLogoUrl: store.chainLogoUrl, listId: data.listId });
                    continue;
                }
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const listData = await res.json();
                if (listData.tripId) splitTripId = listData.tripId;
                createdLists.push({ storeId: store.storeId, storeName: store.storeName, storeAddress: store.storeAddress, chainName: store.chainName, chainLogoUrl: store.chainLogoUrl, listId: listData.id });
            }

            if (createdLists.length === 0) throw new Error('No lists created');
            await AsyncStorage.setItem(`split_lists_${id}`, JSON.stringify(createdLists));
            clearSessionBasket();
            useProfileStore.getState().invalidate();
            if (onListsCreated) { onListsCreated(splitTripId); return; }
            router.dismissAll();
            // 2.0: a split lands on the trip map — every store slot with its
            // own progress pill beats the flat split view.
            if (splitTripId) {
                router.navigate(`/trip/${splitTripId}` as any);
            } else {
                router.navigate('/shopping-list' as any);
                setTimeout(() => {
                    router.push(`/shopping-list/split/${id}` as any);
                }, 100);
            }
        } catch {
            Alert.alert(t('results.errorTitle'), t('results.errorCreateList'));
        } finally {
            setCreatingList(false);
        }
    };

    return (
        <>
            <View style={styles.container}>
                {loading && !pullRefreshing ? (
                    <Animated.View entering={FadeIn} style={styles.loadingContainer}>
                        <MaterialProgress size="large" color={colors.primary} />
                        <Text style={styles.loadingText}>{t('results.loading')}</Text>
                    </Animated.View>
                ) : mapMounted ? (
                    // Full-bleed map fills the content region; the option sheet
                    // floats over it at the bottom. The heavy MapView mount is
                    // deferred a frame past entry so the screen paints instantly.
                    <>
                        <StoreResultsMap
                            pins={pins}
                            userCoords={userCoords}
                            focusCoords={focusCoords}
                            recommendedCoords={recommendedCoords}
                            routeEndpoints={routeEndpoints}
                            onSelectStore={handlePinTap}
                            onMapPress={handleMapTap}
                            colors={colors}
                            directory={directory}
                            pricedStoreIds={pricedStoreIds}
                            pricingStoreId={pricingStoreId}
                            onLazyPrice={handleLazyPrice}
                            routeCoords={routeCoords}
                            onVisibleUnpricedChange={setVisibleUnpriced}
                            scrollDisabledSV={mapPanBlocked}
                            sheetOpenSV={sheetOpenSV}
                            gesturesEnabled={!anySheetOpen}
                            nativeGestureRef={mapNativeGestureRef}
                            bottomOverlay={selectedOption ? Math.max(bottomClearance, storeOcclusion) : Math.max(bottomClearance, embedded ? 0 : dockClearance)}
                        />
                        {/* Full-bleed map → floating back circle, top-left
                            (standalone route only — the embedding host owns
                            its own back button). */}
                        {!embedded && !pickingPreset && (
                            <View style={[styles.mapTopLeft, { top: topInset + 10 }]} pointerEvents="box-none">
                                <TouchableOpacity style={styles.mapBackShadow} onPress={() => router.back()} activeOpacity={0.8}>
                                    <LiquidGlass style={styles.mapBackBtn} fallback="solid">
                                        <Ionicons name="chevron-back" size={iconSize.lg} color={colors.primary} />
                                    </LiquidGlass>
                                </TouchableOpacity>
                            </View>
                        )}
                        {/* Top-centre store-count toggle. Instant client re-rank
                            of how the basket is split across 1/2/3 shops. */}
                        {!pickingPreset && (
                            <View style={[styles.mapTopCenter, { top: topInset + 10 }]} pointerEvents="box-none">
                                <StoreCountToggle value={maxStores} onChange={setStoreCount} />
                            </View>
                        )}
                    </>
                ) : (
                    <View style={styles.loadingContainer}>
                        <MaterialProgress size="large" color={colors.primary} />
                    </View>
                )}
            {/* Box-none overlay above the map: the sheet's own views are the
                touch targets; empty area falls through to the map (the canonical
                gorhom-over-react-native-maps routing — no scrollEnabled toggles,
                no gesture arbitration against the GL surface). */}
            <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
            {/* While the dock is expanded, a transparent scrim over the map
                (below the dock) makes the sheet reliably interactive and
                collapses the sheet on any map tap/drag. */}
            {dockExpanded && !embedded && !selectedOption && !pickingPreset && (
                <View
                    style={styles.dockScrim}
                    onStartShouldSetResponder={() => true}
                    onResponderGrant={() => dockRef.current?.collapse()}
                />
            )}

            {/* Tap a pin → the store-options dock (same glass scaffold as the main
                dock; replaces it while a store is selected). It lives INSIDE this
                box-none overlay so its option taps route like the main dock's —
                otherwise the taps leak to the map's native onPress and deselect
                the store. Bar = store info; sheet = Navigate/List + the options. */}
            {!loading && mapMounted && !pickingPreset && selectedOption && (
                <StoreOptionsDock
                    options={selectedOptions}
                    selectedKey={selectedOption.key}
                    onSelect={handleSelectOption}
                    onNavigate={handleNavigateSelected}
                    onCreateList={handleCreateShoppingList}
                    creatingList={creatingList}
                    journeyKm={journeyKm}
                    itemCount={basketItemCount}
                    colors={colors}
                    dragActiveSV={mapPanBlocked}
                    onInteract={noteSheetPress}
                    onStageChange={setStoreSheetStage}
                    blockGestureRef={mapNativeGestureRef}
                    onCollapsedClearance={setDockClearance}
                    onOcclusionChange={setStoreOcclusion}
                />
            )}

            {/* The glass dock — collapsed = price-summary bar; expanded = one
                scroll of Basket/Invite + Calculation settings + Location &
                Route. Hidden while a store option is selected (the create-list
                sheet takes over). */}
            {!loading && mapMounted && !embedded && !selectedOption && !pickingPreset && (
                <DockedGlassSheet
                    ref={dockRef}
                    colors={colors}
                    barAtTop
                    progressSV={sheetProgress}
                    dragActiveSV={mapPanBlocked}
                    blockScrollRef={mapNativeGestureRef}
                    onCollapsedClearance={setDockClearance}
                    barRowHeight={dockBarH}
                    barRow={
                        <View
                            style={styles.dockBar}
                            onLayout={e => { const h = Math.round(e.nativeEvent.layout.height); if (h > 0) setDockBarH(h); }}
                        >
                            <Animated.Text style={[styles.summaryText, titleStyle]} numberOfLines={1}>
                                {cheapestTotal != null
                                    ? t('results.mapSummary', { price: formatEuro(cheapestTotal), count: pricedCount })
                                    : t('results.mapSummaryEmpty')}
                            </Animated.Text>
                            {recalcing && <MaterialProgress size="small" color={colors.primary} />}
                            {visibleUnpriced.length > 0 && (
                                <TouchableOpacity
                                    style={styles.morePricesGhost}
                                    onPress={handleBatchPrice}
                                    disabled={batchPricing}
                                    activeOpacity={0.6}
                                    hitSlop={8}
                                >
                                    {batchPricing
                                        ? <MaterialProgress size="small" color={colors.primary} />
                                        : <>
                                            <Ionicons name="add" size={17} color={colors.primary} />
                                            <Text style={styles.morePricesGhostText}>{t('results.morePrices')}</Text>
                                          </>}
                                </TouchableOpacity>
                            )}
                        </View>
                    }
                    sheet={{
                        maxStage: 2,
                        onStageChange: (st) => { setDockExpanded(st > 0); },
                        content: (
                            <View style={styles.dockContent}>
                                <View style={styles.bigBtnRow}>
                                    <DockActionCard
                                        colors={colors}
                                        icon="cart-outline"
                                        title={t('tripMap.basketBtn')}
                                        subtitle={t('tripMap.basketBtnSub')}
                                        onPress={() => router.push(`/basket/${id}` as any)}
                                        badge={basketItemCount > 0
                                            ? <View style={styles.cartCount}><Text style={styles.cartCountText}>{basketItemCount}</Text></View>
                                            : undefined}
                                    />
                                    <DockActionCard
                                        colors={colors}
                                        icon="person-add"
                                        title={t('basketDetail.inviteTitle')}
                                        subtitle={t('basketDetail.inviteSub')}
                                        onPress={() => void openInvite()}
                                    />
                                </View>

                                {/* Location & Route — GPS / Place / Route selection inline. */}
                                <DockSection colors={colors} icon="navigate-outline" title={t('tripMap.locationRoute')}>
                                    <LocationSettingsPanel
                                        compact
                                        refreshKey={settingsRefreshKey}
                                        onOpenPresetMap={openPresetPicker}
                                        onLocationCommit={recalcForLocationChange}
                                    />
                                </DockSection>

                                {/* Settings — saver mode. */}
                                <DockSection colors={colors} icon="settings-outline" title={t('tripMap.settings')}>
                                    <View style={styles.settingRow}>
                                        <Ionicons name="pricetags-outline" size={20} color={colors.primary} />
                                        <View style={{ flex: 1 }}>
                                            <Text style={styles.settingText}>{t('tripMap.saverMode')}</Text>
                                            <Text style={styles.settingSub}>{saverMode ? t('tripMap.saverOn') : t('tripMap.saverOff')}</Text>
                                        </View>
                                        <Switch
                                            value={saverMode}
                                            onValueChange={(v) => { setSaverMode(v); void AsyncStorage.setItem('saverMode', v ? '1' : '0'); }}
                                            trackColor={{ false: colors.border, true: colors.primary }}
                                            thumbColor={colors.onPrimary}
                                        />
                                    </View>
                                </DockSection>
                            </View>
                        ),
                    }}
                />
            )}
            </View>
            </View>

            <Modal visible={inviteOpen} transparent animationType="fade" onRequestClose={() => setInviteOpen(false)}>
                <TouchableOpacity style={styles.qrBackdrop} activeOpacity={1} onPress={() => setInviteOpen(false)}>
                    <View style={styles.qrCard} onStartShouldSetResponder={() => true}>
                        <Text style={styles.optText}>{t('trips.tripQrTitle')}</Text>
                        {inviteUrl
                            ? <BrandedQR value={inviteUrl} size={200} />
                            : <MaterialProgress size="large" color={colors.primary} />}
                    </View>
                </TouchableOpacity>
            </Modal>
            <LocationPromptModal
                visible={locationPromptVisible}
                onResolved={async (coords) => {
                    setLocationPromptVisible(false);
                    await runRecalcWithCoords(coords);
                }}
                onCancel={() => setLocationPromptVisible(false)}
            />

            {/* "Define a location" — full-screen inline point picker over the
                store map. Back cancels + restores the dock (Location page). */}
            {pickingPreset && (
                <View style={styles.pickerOverlay}>
                    <PresetPointPicker
                        presetKey={pickingPreset.key}
                        label={pickingPreset.label}
                        existing={pickingPreset.existing}
                        onDone={() => closePresetPicker(true)}
                        onCancel={() => closePresetPicker(false)}
                    />
                </View>
            )}
        </>
    );
}


const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    pickerOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: c.pageBackground, zIndex: 30, elevation: 30 },
    dockScrim: { ...StyleSheet.absoluteFillObject, zIndex: 15, elevation: 15 },
    // Floating map header (map view is full-bleed): back circle + toggle, left.
    mapTopLeft: { position: 'absolute', left: spacing.md, alignItems: 'flex-start', gap: spacing.sm, zIndex: 20 },
    // Glass surfaces clip to their rounded shape (overflow hidden), so the
    // drop shadow lives on an outer wrapper — a clipped view can't cast one.
    mapBackShadow: {
        borderRadius: radius.pill,
        ...elevation.level2,
    },
    mapBackBtn: {
        width: 42, height: 42, borderRadius: radius.pill, overflow: 'hidden',
        backgroundColor: c.cardBackground,
        alignItems: 'center', justifyContent: 'center',
        borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    },
    // Top-centre store-count segmented toggle (1·2·3).
    mapTopCenter: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 20 },
    optText: { ...typography.bodyStrong, color: c.textPrimary },
    qrBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
    qrCard: { backgroundColor: c.cardBackground, borderRadius: radius.xl, padding: spacing.xl, alignItems: 'center', gap: spacing.lg },
    loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg, backgroundColor: c.pageBackground },
    loadingText: { ...typography.body, color: c.textSecondary },

    // ── Glass dock ─────────────────────────────────────────────────────────
    dockBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 40, paddingHorizontal: 16 },
    summaryText: { flex: 1, fontSize: 15, fontWeight: '700', color: c.textPrimary },
    morePricesGhost: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
    morePricesGhostText: { fontSize: 14, fontWeight: '700', color: c.primary },
    dockContent: { paddingHorizontal: 16, paddingTop: 22, gap: 14 },
    bigBtnRow: { flexDirection: 'row', gap: 14 },
    // Item-count pip overlaid on the Basket action card's cart icon.
    cartCount: {
        position: 'absolute', top: -6, right: -10, minWidth: 18, height: 18, borderRadius: 9,
        paddingHorizontal: 4, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center',
    },
    cartCountText: { color: c.onPrimary, fontSize: 10, fontWeight: '800' },
    settingRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
    settingText: { fontSize: 15, fontWeight: '600', color: c.textPrimary },
    settingSub: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
});
