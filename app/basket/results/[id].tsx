import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    Alert,
    InteractionManager,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, useFocusEffect, useNavigation, Stack } from 'expo-router';
import React, { useMemo, useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Animated, { FadeIn, useSharedValue, withTiming, useAnimatedStyle } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { API_BASE_URL } from '../../../config/api';
import { useTheme, spacing, radius, elevation, typography, iconSize, type AppTheme } from '../../../constants/theme';
import { useBasketState } from '../../../state/basketState';
import { useProfileStore } from '../../../state/profileStore';
import { loadCachedCoords, tryGpsCoords, persistCoords, type UserCoords } from '../../../utils/location';
import LocationPromptModal from '../../../components/LocationPromptModal';
import { scoreAllCombinations, type ScoredCombo } from '../../../utils/splitBasketScore';
import { type StoreResult, fetchStorePrices } from '../../../utils/basketPricing';
import { getStoreDirectory } from '../../../utils/storeDirectory';
import { type StoreLite } from '../../../utils/candidatePool';
import { orderStopsNearestFirst, orderStopsAlongRoute, buildGoogleMapsRouteUrl } from '../../../utils/multiStopRoute';
import { getPresets, getLocationSettings, saveLocationSettings } from '../../../utils/locationStorage';
import StoreResultsMap, { type MapPin } from '../../../components/results/StoreResultsMap';
import ResultsBottomSheet from '../../../components/results/ResultsBottomSheet';
import { LiquidGlass } from '../../../components/LiquidGlass';
import { buildSplitOptions, TRIP_RADIUS_KM, type SheetOption } from '../../../utils/splitOptions';

// StoreResult / ItemResult now live in utils/basketPricing (shared with the
// lazy /store-prices fetch) — imported above.

/** Hard cap on the single-store list — near a city centre the calc can return
 *  hundreds of stores; we only ever show the top 10 ranked options. */
const MAX_SINGLE_STORES = 10;

/** Width (dp) of one digit segment in the 1·2·3 store-count toggle — also the
 *  sliding indicator's width. Fixed so the pill stays compact, not full-width. */
const STORE_COUNT_SEG = 34;


export default function BasketResultsScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const { clearSessionBasket } = useBasketState();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { bottom: bottomInset, top: topInset } = useSafeAreaInsets();
    const { id } = useLocalSearchParams();
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
    // Current bottom-sheet height (px) — passed to the map so it frames the
    // selected stores in the area above the sheet.
    const [sheetHeight, setSheetHeight] = useState(0);

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
            const res = await fetch(`${API_BASE_URL}/api/baskets/${id}/calculate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ lat: coords.lat, lng: coords.lng }),
            });
            const newResults = await res.json();
            await AsyncStorage.setItem(`basket_results_${id}`, JSON.stringify(newResults));
            await persistCoords(coords);
            setUserCoords({ lat: coords.lat, lng: coords.lng });
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
    const { pinPriceByStore, recommendedStoreIds, recommendedStores } = useMemo(() => {
        const richById = new Map<number, StoreResult>();
        for (const r of results) richById.set(r.storeId, r);
        for (const r of lazyResults) if (!richById.has(r.storeId)) richById.set(r.storeId, r);

        const priceByStore = new Map<number, number>();
        for (const [, r] of richById) priceByStore.set(r.storeId, r.total);

        // Global best starts as the recommended single store; a cheaper in-radius
        // split takes over.
        let best: { price: number; ids: number[]; stores: StoreResult[] } | null =
            results[0] ? { price: results[0].total, ids: [results[0].storeId], stores: [results[0]] } : null;

        for (const c of combos) {
            if (c.stores.length <= 1 || c.extraDistanceKm > TRIP_RADIUS_KM) continue;
            for (const sid of c.storeIds) {
                const cur = priceByStore.get(sid);
                if (cur == null || c.splitTotal < cur) priceByStore.set(sid, c.splitTotal);
            }
            if (!best || c.splitTotal < best.price) {
                const stores = c.storeIds.map(id => richById.get(id)).filter((s): s is StoreResult => !!s);
                if (stores.length === c.storeIds.length) best = { price: c.splitTotal, ids: c.storeIds, stores };
            }
        }
        return {
            pinPriceByStore: priceByStore,
            recommendedStoreIds: new Set(best?.ids ?? []),
            recommendedStores: best?.stores ?? [],
        };
    }, [results, lazyResults, combos]);

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
            .map(s => ({
                storeId: s.storeId, chainId: s.chainId, chainName: s.chainName,
                miniLogoUrl: s.chainMiniLogoUrl ?? s.chainLogoUrl ?? null,
                latitude: s.latitude as number, longitude: s.longitude as number,
                euro: pinPriceByStore.get(s.storeId) ?? s.total, // cheapest option for this store
                active: activeIds.has(s.storeId),
                recommended: recommendedStoreIds.has(s.storeId), // all stores of the best option
            })),
        [pinStores, activeIds, pinPriceByStore, recommendedStoreIds]);

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
    const closeSheet = useCallback(() => { setSelectedStoreId(null); setSelectedOptionKey(null); }, []);

    // Live store-count toggle (1/2/3) on the map. Pure CLIENT re-rank — combos
    // are scored from the already-priced stores, so no server recalc/spinner.
    // Closes the open sheet (so a now-gone combo option can't go stale) and
    // lets the map reframe to the new recommendation; persists to the calc meta
    // so the choice survives re-entering these results.
    const setStoreCount = useCallback(async (n: 1 | 2 | 3) => {
        if (n === maxStores) return;
        try { Haptics.selectionAsync(); } catch {}
        setMaxStores(n);
        closeSheet();
        // Persist to the GLOBAL location setting so the basket's settings button
        // reflects it on back, and it stays in sync everywhere. Store-count no
        // longer affects pricing, so this never forces a recalc.
        try { await saveLocationSettings({ storeCount: n }); } catch {}
    }, [maxStores, closeSheet]);

    // Sliding capsule for the 1/2/3 store-count toggle — the selection animates
    // between segments instead of hard-cutting. `segW` is one segment's width
    // (measured), `idx` the active segment (0-based).
    const storeCountIdx = useSharedValue(maxStores - 1);
    useEffect(() => { storeCountIdx.value = maxStores - 1; }, [maxStores, storeCountIdx]);
    const storeCountIndicatorStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: withTiming(storeCountIdx.value * STORE_COUNT_SEG, { duration: 220 }) }],
    }));

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
            const { getUserId } = await import('../../../config/user');
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
                router.dismissAll();
                router.navigate('/(tabs)/shoppingList' as any);
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
            router.dismissAll();
            router.navigate('/(tabs)/shoppingList' as any);
            setTimeout(() => {
                router.push(`/shopping-list/${listData.id}` as any);
            }, 100);
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
            const { getUserId } = await import('../../../config/user');
            const userId = await getUserId();

            const createdLists: { storeId: number; storeName: string; storeAddress: string; chainName: string; chainLogoUrl: string | null; listId: number }[] = [];

            for (const store of selectedCombo.stores) {
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
                createdLists.push({ storeId: store.storeId, storeName: store.storeName, storeAddress: store.storeAddress, chainName: store.chainName, chainLogoUrl: store.chainLogoUrl, listId: listData.id });
            }

            if (createdLists.length === 0) throw new Error('No lists created');
            await AsyncStorage.setItem(`split_lists_${id}`, JSON.stringify(createdLists));
            clearSessionBasket();
            useProfileStore.getState().invalidate();
            router.dismissAll();
            router.navigate('/(tabs)/shoppingList' as any);
            setTimeout(() => {
                router.push(`/shopping-list/split/${id}` as any);
            }, 100);
        } catch {
            Alert.alert(t('results.errorTitle'), t('results.errorCreateList'));
        } finally {
            setCreatingList(false);
        }
    };

    return (
        <>
            {/* Declarative options for the first-mount case. Mirrored by
                useLayoutEffect above so re-renders keep the button
                attached even if expo-router's initial push timing hides
                it briefly. */}
            <Stack.Screen options={{ headerShown: false }} />
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
                            onMapPress={closeSheet}
                            colors={colors}
                            directory={directory}
                            pricedStoreIds={pricedStoreIds}
                            pricingStoreId={pricingStoreId}
                            onLazyPrice={handleLazyPrice}
                            routeCoords={routeCoords}
                            onVisibleUnpricedChange={setVisibleUnpriced}
                            bottomOverlay={selectedOption ? sheetHeight : 0}
                        />
                        {/* Full-bleed map → floating back circle, top-left. */}
                        <View style={[styles.mapTopLeft, { top: topInset + 10 }]} pointerEvents="box-none">
                            <TouchableOpacity style={styles.mapBackShadow} onPress={() => router.back()} activeOpacity={0.8}>
                                <LiquidGlass style={styles.mapBackBtn} fallback="solid">
                                    <Ionicons name="chevron-back" size={iconSize.lg} color={colors.primary} />
                                </LiquidGlass>
                            </TouchableOpacity>
                        </View>
                        {/* Top-centre store-count toggle. Instant client re-rank
                            of how the basket is split across 1/2/3 shops. */}
                        <View style={[styles.mapTopCenter, { top: topInset + 10 }]} pointerEvents="box-none">
                            <View style={styles.storeCountShadow}>
                                <LiquidGlass style={styles.storeCountPill} fallback="solid">
                                    <Ionicons name="storefront-outline" size={iconSize.sm} color={colors.textSecondary} style={styles.storeCountIcon} />
                                    <View style={styles.storeCountSegments}>
                                        <Animated.View style={[styles.storeCountIndicator, storeCountIndicatorStyle]} />
                                        {([1, 2, 3] as const).map(n => {
                                            const active = maxStores === n;
                                            return (
                                                <TouchableOpacity
                                                    key={n}
                                                    style={styles.storeCountBtn}
                                                    onPress={() => setStoreCount(n)}
                                                    activeOpacity={0.8}
                                                >
                                                    <Text style={[styles.storeCountText, active && styles.storeCountTextActive]}>{n}</Text>
                                                </TouchableOpacity>
                                            );
                                        })}
                                    </View>
                                </LiquidGlass>
                            </View>
                        </View>
                    </>
                ) : (
                    <View style={styles.loadingContainer}>
                        <MaterialProgress size="large" color={colors.primary} />
                    </View>
                )}
                {/* Tap a pin → options sheet; nothing selected → a subtle hint. */}
                {!loading && mapMounted ? (
                    selectedOption ? (
                        <ResultsBottomSheet
                            options={selectedOptions}
                            selectedKey={selectedOption.key}
                            onSelect={handleSelectOption}
                            onClose={closeSheet}
                            onNavigate={handleNavigateSelected}
                            onCreateList={handleCreateShoppingList}
                            creatingList={creatingList}
                            colors={colors}
                            bottomInset={bottomInset}
                            onHeightChange={setSheetHeight}
                        />
                    ) : visibleUnpriced.length > 0 ? (
                        // Un-priced stores in view → one-tap "price this area".
                        <View style={[styles.hintWrap, { bottom: spacing.xl + bottomInset }]} pointerEvents="box-none">
                            <TouchableOpacity
                                style={styles.batchBtn}
                                onPress={handleBatchPrice}
                                disabled={batchPricing}
                                activeOpacity={0.85}
                            >
                                {batchPricing
                                    ? <MaterialProgress size="small" color={colors.onPrimary} />
                                    : <Ionicons name="pricetags-outline" size={iconSize.sm} color={colors.onPrimary} />}
                                <Text style={styles.batchBtnText}>
                                    {batchPricing ? t('results.batchCalculating') : t('results.batchMore', { count: visibleUnpriced.length })}
                                </Text>
                            </TouchableOpacity>
                        </View>
                    ) : (
                        <View style={[styles.hintWrap, { bottom: spacing.xl + bottomInset }]} pointerEvents="none">
                            <LiquidGlass style={styles.hintPill} fallback="solid" interactive={false}>
                                <Ionicons name="hand-left-outline" size={iconSize.sm} color={colors.textSecondary} />
                                <Text style={styles.hintText}>{t('results.tapStore')}</Text>
                            </LiquidGlass>
                        </View>
                    )
                ) : null}
            </View>
            <LocationPromptModal
                visible={locationPromptVisible}
                onResolved={async (coords) => {
                    setLocationPromptVisible(false);
                    await runRecalcWithCoords(coords);
                }}
                onCancel={() => setLocationPromptVisible(false)}
            />
        </>
    );
}


const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
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
    storeCountShadow: {
        borderRadius: radius.pill,
        ...elevation.level3,
    },
    storeCountPill: {
        flexDirection: 'row', alignItems: 'center', overflow: 'hidden',
        backgroundColor: c.cardBackground, borderRadius: radius.pill,
        paddingLeft: spacing.sm, paddingRight: spacing.xs, paddingVertical: spacing.xs, gap: 2,
        borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    },
    storeCountIcon: { marginRight: spacing.xs },
    storeCountSegments: { flexDirection: 'row', position: 'relative' },
    // Sliding selection capsule; sits behind the digits and animates between them.
    storeCountIndicator: { position: 'absolute', top: 0, bottom: 0, left: 0, width: STORE_COUNT_SEG, borderRadius: radius.pill, backgroundColor: c.primary },
    storeCountBtn: { width: STORE_COUNT_SEG, paddingVertical: 6, alignItems: 'center', justifyContent: 'center' },
    storeCountText: { fontSize: 15, fontWeight: '800', color: c.textSecondary },
    storeCountTextActive: { color: c.onPrimary },
    loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg, backgroundColor: c.pageBackground },
    loadingText: { ...typography.body, color: c.textSecondary },
    hintWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
    hintPill: {
        flexDirection: 'row', alignItems: 'center', gap: 6, overflow: 'hidden',
        backgroundColor: c.cardBackground, borderRadius: radius.pill,
        paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
        borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    },
    hintText: { ...typography.label, color: c.textSecondary },
    // Area-batch "price this area" button (pink pill, bottom-center).
    batchBtn: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
        backgroundColor: c.primary, borderRadius: radius.pill,
        paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
        ...elevation.level3,
    },
    batchBtnText: { ...typography.bodyStrong, fontWeight: '700', color: c.onPrimary },
});
