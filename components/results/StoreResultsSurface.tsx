import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    Alert,
 Switch, Modal, BackHandler } from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import CalcLoadingModal from '../CalcLoadingModal';
import { devLog } from '../../utils/devLog';
import { calculateBasket, resolveOrigin } from '../../utils/basketCalc';
import { bootstrapStoreResults } from '../../utils/storeResultsBootstrap';
import { buildJourneyCoords, sumJourneyKm, journeyKmForStores } from '../../utils/journey';
import { StoreCountToggle } from '../map/StoreCountToggle';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect, useNavigation } from 'expo-router';
import React, { useMemo, useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Animated, { FadeIn, useSharedValue, useAnimatedStyle } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { API_BASE_URL } from '../../config/api';
import { useTheme, spacing, radius, elevation, typography, iconSize, type AppTheme } from '../../constants/theme';
import { useBasketState } from '../../state/basketState';
import { useProfileStore } from '../../state/profileStore';
import { loadCachedCoords, loadLastKnownCoords, tryGpsCoords, persistCoords, type UserCoords } from '../../utils/location';
import LocationPromptModal from '../LocationPromptModal';
import { scoreAllCombinations, type ScoredCombo } from '../../utils/splitBasketScore';
import { type StoreResult, fetchStorePrices } from '../../utils/basketPricing';
import { getStoreDirectory } from '../../utils/storeDirectory';
import { type StoreLite } from '../../utils/candidatePool';
import { orderStopsNearestFirst, orderStopsAlongRoute, buildGoogleMapsRouteUrl } from '../../utils/multiStopRoute';
import { getLocationSettings, saveLocationSettings } from '../../utils/locationStorage';
import StoreResultsMap, { type MapPin } from '../results/StoreResultsMap';
import StoreOptionsDock from '../results/StoreOptionsDock';
import { LiquidGlass } from '../LiquidGlass';
import { buildSplitOptions, bestSplitOption, TRIP_RADIUS_KM, type SheetOption } from '../../utils/splitOptions';
import { fetchTrips, createTripInviteUrl, fetchTripMembers, sendAddressedTripInvite, removeTripMember, type TripMemberInfo } from '../../utils/tripsApi';
import { InvitePane } from './InvitePane';
import { formatEuro } from '../../utils/formatCurrency';
import { DockedGlassSheet, type DockedSheetControls } from '../DockedGlassSheet';
import { DockActionRow } from '../dock/DockActionRow';
import { DockSection } from '../dock/DockSection';
import { useDockTitleStyle } from '../dock/useDockTitleStyle';
import LocationSettingsPanel from '../LocationSettingsPanel';
import { PresetPickChrome } from '../PresetPickChrome';
import { MapBackButton } from '../map/MapBackButton';
import type { PresetKey, LocationPreset } from '../../utils/locationStorage';
import type MapView from 'react-native-maps';

// StoreResult / ItemResult now live in utils/basketPricing (shared with the
// lazy /store-prices fetch) — imported above.

/** Hard cap on the single-store list — near a city centre the calc can return
 *  hundreds of stores; we only ever show the top 10 ranked options. */
/** Absolute backstop: show a map even if the entry never settles. */
const MAP_MOUNT_FALLBACK_MS = 8000;
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
    // Last known position, read straight from the coords cache on mount. It is
    // only ever the map's FALLBACK camera — used when the entry resolved nothing
    // to frame — so the map opens on your city instead of a hardcoded Vilnius.
    const [lastKnownCenter, setLastKnownCenter] = useState<{ lat: number; lng: number } | null>(null);
    useEffect(() => {
        void loadLastKnownCoords()
            .then(c => { if (c) setLastKnownCenter({ lat: c.lat, lng: c.lng }); })
            .catch(() => {});
    }, []);
    // Route mode (location settings) → the two trip endpoints, so the map draws
    // routeFrom → stores → routeTo instead of a single-origin line.
    const [routeEndpoints, setRouteEndpoints] = useState<{
        from: { latitude: number; longitude: number };
        to: { latitude: number; longitude: number };
    } | null>(null);
    // Place mode (a saved preset chosen as origin) → a pin marking the starting
    // area on the map. Null in GPS mode (the blue dot shows it) and route mode
    // (the from/to markers do).
    const [originPin, setOriginPin] = useState<{ latitude: number; longitude: number } | null>(null);
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
    // Mirror of saverMode read synchronously by the request builders (a toggle
    // recalc runs before setState commits, so the ref carries the new value).
    const saverModeRef = useRef(false);
    useEffect(() => { saverModeRef.current = saverMode; }, [saverMode]);
    const [inviteUrl, setInviteUrl] = useState<string | null>(null);
    // Invite = an IN-SHEET pane (dock content swap), not a modal.
    const [invitePane, setInvitePane] = useState(false);
    const [tripId, setTripId] = useState<number | null>(null);
    const [members, setMembers] = useState<TripMemberInfo[]>([]);
    // Quiet reprice triggered by a location change inside the dock (place picked
    // / route completed). Unlike loadResults it does NOT flip global `loading`
    // (the dock stays open) — just a small spinner in the summary bar. The epoch
    // ref discards a superseded run if the user changes location again mid-fetch.
    const [recalcing, setRecalcing] = useState(false);
    const recalcEpochRef = useRef(0);
    useEffect(() => { void AsyncStorage.getItem('saverMode').then(v => setSaverMode(v === '1')); }, []);
    // ── Glass dock (same component as every new screen). Collapsed = the
    // price-summary bar; expanded = one scroll: Basket/Invite actions,
    // Calculation settings, Location & Route. ──────────────────────────────
    const dockRef = useRef<DockedSheetControls>(null);
    // The store map's MapView — shared with the preset point-pick so it reads/
    // drives THIS map's camera instead of mounting a second map.
    const resultsMapRef = useRef<MapView>(null);
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
    // Map-vs-sheet: the map's frame is INSET to the sheet's occlusion (its top
    // edge measured from the screen bottom), reported per detent by whichever
    // dock is showing. The map then lives ONLY in the visible area above the
    // sheet — no map under it, so a sheet drag is never stolen, the map is always
    // pannable where it shows, and NO freeze is needed (Google-Maps model).
    // Collapsed → inset to the bar; medium → to ~half; full → fully covered.
    const [sheetOcclusion, setSheetOcclusion] = useState(150);
    // Title grows 15→20 when the sheet opens (like the catalog list sheet).
    const titleStyle = useDockTitleStyle(sheetProgress);
    // V1 price-hero: the big price grows slightly as the sheet opens (the
    // dock-title idiom, scaled for the larger base size).
    const priceGrowStyle = useAnimatedStyle(() => ({
        fontSize: 23 + 4 * sheetProgress.value,
    }));
    const [settingsRefreshKey, setSettingsRefreshKey] = useState(0);
    // "Define a location" — an inline point-picker overlay that takes over the
    // whole screen (strips the store chrome + dock, shows a centre pin +
    // search). Back cancels and restores the map + dock to where it was.
    const [pickingPreset, setPickingPreset] = useState<{ key: PresetKey; label: string; existing: LocationPreset | null; seq: number } | null>(null);
    // Bumped every open → keys PresetPickChrome so each open is a fresh mount
    // (no state/coords bleed from the previously-edited preset).
    const pickSeq = useRef(0);
    // The pin's target from an INTENTIONAL move during a preset pick (tap / POI /
    // real drag) → PresetPickChrome reverse-geocodes it into the live address.
    const [pickTarget, setPickTarget] = useState<{ lat: number; lng: number } | null>(null);
    // Stable so StoreResultsMap's React.memo isn't broken by an inline prop.
    const handlePickTarget = useCallback((lat: number, lng: number) => {
        setPickTarget({ lat, lng });
    }, []);
    const openPresetPicker = useCallback((key: PresetKey, label: string, existing: LocationPreset | null) => {
        dockRef.current?.collapse();
        setPickTarget(null);   // don't inherit a location from a previous pick
        pickSeq.current += 1;
        setPickingPreset({ key, label, existing, seq: pickSeq.current });
    }, []);
    const closePresetPicker = useCallback((saved: boolean) => {
        setPickingPreset(null);
        if (saved) setSettingsRefreshKey(k => k + 1);
        requestAnimationFrame(() => dockRef.current?.snapTo(1));
    }, []);
    // Basket item count for the "Basket" dock button.
    // The basket's items are read ONCE per basket and reused: the dock's cart
    // badge needs the count, combo scoring needs which items are critical. Two
    // effects used to fetch this same (heavy) endpoint independently, and the
    // combo one re-fetched it on every results / lazy-price / 1·2·3 change.
    const [basketItemCount, setBasketItemCount] = useState(0);
    const criticalIdsRef = useRef<Set<number>>(new Set());
    const [itemsRev, setItemsRev] = useState(0);
    useEffect(() => {
        let alive = true;
        fetch(`${API_BASE_URL}/api/baskets/${id}/items`)
            .then(r => (r.ok ? r.json() : []))
            .then((rows: any[]) => {
                if (!alive || !Array.isArray(rows)) return;
                setBasketItemCount(rows.length);
                criticalIdsRef.current = new Set(
                    rows.filter(it => it.isCritical).map(it => Number(it.productId)));
                setItemsRev(v => v + 1);   // combos re-score with the real flags
            })
            .catch(() => {});
        return () => { alive = false; };
    }, [id]);
    // Horizontal page slide (Actions ↔ Location & Route): the pages/row are
    // sized in PERCENTAGES and translated in percent too, so they track the
    // sheet's growing width on the UI thread with no JS measurement — the
    // side gaps stay constant at every drag position (matches the catalog
    // sheets, whose content tracks the edges via the built-in peek inset).
    // Resolve this basket's trip + member roster once — powers the Pakviesti
    // card's stacked initials AND the invite pane.
    const refreshMembers = useCallback(async (tid: number) => {
        try { setMembers(await fetchTripMembers(tid)); } catch { /* roster is cosmetic */ }
    }, []);
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const trips = await fetchTrips();
                const trip = trips.find(tr => tr.basket?.id === Number(id));
                if (!alive || !trip) return;
                setTripId(trip.id);
                void refreshMembers(trip.id);
            } catch { /* not a trip basket — invite hidden anyway */ }
        })();
        return () => { alive = false; };
    }, [id, refreshMembers]);

    const openInvite = useCallback(async () => {
        if (tripId == null) return;
        setInvitePane(true);
        dockRef.current?.snapTo(2);
        if (!inviteUrl) {
            // Codes are get-or-create (stable per trip) — hydrate instantly from
            // disk, then refresh in the background so a revoked/expired token
            // still corrects itself.
            const cacheKey = `trip_invite_url:${tripId}`;
            try {
                const cached = await AsyncStorage.getItem(cacheKey);
                if (cached) setInviteUrl(cached);
            } catch { /* cache miss */ }
            try {
                const fresh = await createTripInviteUrl(tripId);
                setInviteUrl(fresh);
                void AsyncStorage.setItem(cacheKey, fresh);
            } catch { /* cached (or spinner) stands */ }
        }
    }, [tripId, inviteUrl]);

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
        // Pure client-side scoring — no fetch. The critical-item flags come from
        // the one items read above, so re-pricing or flipping 1·2·3 re-scores
        // instantly instead of waiting on the network each time.
        const scored = maxStores <= 1 ? [] : scoreAllCombinations(pool, criticalIdsRef.current, maxStores);
        setCombos(scored);
    }, [results, lazyResults, maxStores, itemsRev]);


    // Defer the heavy MapView mount past the entry interaction so the screen
    // paints instantly — but NOT until `loading` clears. Google's GL init +
    // tile fetch is seconds of work, and gating it on the calc ran the two in
    // SERIES: entering with no cached results meant waiting for the whole
    // calculation and only THEN starting the map. The CalcLoadingModal covers
    // the screen throughout, so the map can initialise behind it and be ready
    // the moment the modal lifts.
    // The map mounts when (a) the entry interaction is over AND (b) there is
    // something real to frame — the origin or at least one pin. Its camera is
    // set ONCE from that data (initialRegion), which is what removes the old
    // "opens on Vilnius, then flies to you, then zooms out to the pins" trip:
    // there is now a single, correct first frame and no entry animation at all.
    // The fallback timer covers the no-data case (denied GPS, empty basket) so a
    // map still appears rather than an endless spinner.
    const hasFrameData = !!userCoords || !!routeEndpoints || results.length > 0;
    useEffect(() => {
        if (mapMounted) return;
        // Mount when there's something to frame, OR when the entry has finished
        // and there simply isn't any (denied GPS / empty basket). A blind timer
        // was wrong: a slow first fix mounted the map mid-resolution, so it
        // framed the only thing it had — the Vilnius fallback — and the data
        // arrived to a map that had already committed to a camera.
        if (!hasFrameData && loading) return;
        // requestIdleCallback, not InteractionManager (deprecated in RN 0.86).
        // Same intent — mount the heavy native MapView once the entry animation
        // has stopped competing for the JS thread — and the `timeout` option
        // makes it self-limiting, so a never-idle thread still mounts.
        const task = requestIdleCallback(() => setMapMounted(true), { timeout: MAP_MOUNT_FALLBACK_MS });
        const safety = setTimeout(() => setMapMounted(true), MAP_MOUNT_FALLBACK_MS);
        return () => { cancelIdleCallback(task); clearTimeout(safety); };
    }, [mapMounted, hasFrameData, loading]);
    useEffect(() => { devLog('map.mount', { mapMounted, hasFrameData, loading }); }, [mapMounted, hasFrameData, loading]);

    /** Basket id whose empty cache we already auto-calculated this mount — stops
     *  a failed calc from relaunching on every screen re-focus. */
    const autoCalcRef = useRef<string | null>(null);

    /** Location permission refused (or GPS unavailable with nothing cached):
     *  GPS mode can't produce an origin, so move THIS shopping to Place mode,
     *  raise the settings sheet and leave the user on the place picker — they
     *  enter an address manually instead of staring at a map centred on nowhere.
     *  Only rewrites the mode when we're still in 'current' (never clobbers a
     *  deliberate place/route choice). */
    const switchToPlaceForDeniedGps = useCallback(async () => {
        try {
            const s = await getLocationSettings(id);
            if (s.mode !== 'current') return;
            await saveLocationSettings({ mode: 'specific' }, id);
            setSettingsRefreshKey(k => k + 1);   // panel re-reads → renders Place
            requestAnimationFrame(() => dockRef.current?.snapTo(2));
        } catch { /* non-fatal — the map still renders, just uncentred */ }
    }, [id]);

    /**
     * ENTRY. One pass: settings → origin → cached results (or ONE calculation
     * from that same origin) — see utils/storeResultsBootstrap for why this is a
     * single sequence rather than the four interleaved ones it replaced.
     *
     * `loading` stays true for the WHOLE call, so the user sees one loading
     * state, not a modal that closes and immediately reopens for the calc.
     */
    const loadResults = async () => {
        setLoading(true);
        setSelectedStoreId(null);
        setSelectedOptionKey(null);
        setCombos([]);
        setLazyResults([]);           // stale once the basket/results change

        // ONE attempt per basket per mount: a successful calc writes the cache
        // (so the next focus is a plain read) and a failed one must not relaunch
        // on every re-focus.
        const allowCalc = autoCalcRef.current !== id;
        if (allowCalc) autoCalcRef.current = id;

        const startedAt = Date.now();
        let snap: Awaited<ReturnType<typeof bootstrapStoreResults>> | null = null;
        try {
            snap = await bootstrapStoreResults(id, { saver: saverModeRef.current, allowCalc });
            setMaxStores(snap.maxStores);
            setResults(snap.results);
            setRouteEndpoints(snap.endpoints);
            setOriginPin(snap.originPin);
            setUserCoords(snap.endpoints ? null : snap.origin);
        } catch (e) {
            devLog('map.bootstrap.error', { id, error: String(e) });
        } finally {
            // ALWAYS: anything thrown above used to strand `loading` at true,
            // which is a loading tint over the map that never lifts.
            setLoading(false);
        }
        devLog('map.bootstrap', {
            id, ms: Date.now() - startedAt, allowCalc,
            origin: snap?.origin ?? null, results: snap?.results?.length ?? -1,
            calculated: snap?.calculated ?? false, gpsDenied: snap?.gpsDenied ?? null,
        });

        // LOCATION DENIED → we can't search around the user, so hand them the
        // manual way out instead of a map centred on nothing: flip this shopping
        // to Place mode, raise the settings sheet and let them enter an address.
        if (snap?.gpsDenied) await switchToPlaceForDeniedGps();
    };

    const runRecalcWithCoords = useCallback(async (coords: UserCoords, isPull = false) => {
        if (!isPull) setLoading(true);
        setSelectedStoreId(null);
        try {
            const { results: fresh, origin, settings } = await calculateBasket(id, {
                coords, saver: saverModeRef.current,
            });
            await persistCoords(coords);
            setUserCoords({ lat: origin.lat, lng: origin.lng });
            setOriginPin(settings.mode === 'specific' ? { latitude: origin.lat, longitude: origin.lng } : null);
            setResults(fresh);
            setSelectedOptionKey(null);
            setLazyResults([]);        // re-priced basket → old lazy prices are stale
        } catch {
            Alert.alert(t('results.errorTitle'), t('results.errorRecalc'));
        } finally {
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
            // Same resolution as entry — mode-aware, one GPS read at most.
            const origin = await resolveOrigin(id);
            if (!origin.coords && !origin.endpoints) return;

            const calc = await calculateBasket(id, {
                coords: origin.coords,
                endpoints: origin.endpoints,
                saver: saverModeRef.current,
                settings: origin.settings,
            });
            // A newer location change started while we were fetching → drop this
            // stale result rather than clobbering the fresher one.
            if (epoch !== recalcEpochRef.current) return;

            // Only a real device fix is "where the user is" — a preset/route
            // origin must never overwrite the cached GPS coords.
            if (origin.settings.mode === 'current' && origin.gpsFix) await persistCoords(origin.gpsFix);

            setRouteEndpoints(origin.endpoints);
            setUserCoords(origin.endpoints ? null : { lat: calc.origin.lat, lng: calc.origin.lng });
            setOriginPin(origin.settings.mode === 'specific'
                ? { latitude: calc.origin.lat, longitude: calc.origin.lng }
                : null);
            setResults(calc.results);
            setLazyResults([]);        // re-priced basket → old lazy prices are stale
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

        // Per-store cheapest split (drives each pill's price + partner badge).
        for (const c of combos) {
            if (c.stores.length <= 1 || c.extraDistanceKm > TRIP_RADIUS_KM) continue;
            for (const sid of c.storeIds) {
                const cur = priceByStore.get(sid);
                if (cur == null || c.splitTotal < cur) {
                    priceByStore.set(sid, c.splitTotal);
                    comboByStore.set(sid, c);
                }
            }
        }

        // Global best = the single-store baseline, unless an in-radius split beats
        // it. The split comes from `bestSplitOption`, i.e. through the SAME
        // buildSplitOptions collapse the tap-sheet uses — so the ringed stores are
        // by construction the ones a tap opens. Picking a winner here with its own
        // rule is what put the ring on the WRONG branch: raw `combos` order with a
        // strict `<` never replaced an equal-priced incumbent, so on a price tie
        // between two physical Maximas the ring kept whichever combo sorted first,
        // while the sheet kept the CLOSEST one (splitOptions.ts: bestByOffer).
        let best: { price: number; ids: number[]; stores: StoreResult[] } | null =
            results[0] ? { price: results[0].total, ids: [results[0].storeId], stores: [results[0]] } : null;

        const split = bestSplitOption(combos, results, lazyResults);
        if (split && (!best || split.total < best.price)) {
            best = { price: split.total, ids: split.storeIds, stores: split.stores };
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

    // Coords the map frames when a store is selected: the option's store(s) PLUS
    // the trip origin (GPS / route start), so the WHOLE trip is visible — origin,
    // route line and store(s) — instead of zooming tight onto the store alone.
    // null = fit all (nothing selected).
    const focusCoords = useMemo(() => {
        if (!selectedOption) return null;
        const cs = selectedOption.stores
            .filter(s => s.latitude != null && s.longitude != null)
            .map(s => ({ latitude: s.latitude as number, longitude: s.longitude as number }));
        if (!cs.length) return null;
        const origin = routeEndpoints
            ? { latitude: routeEndpoints.from.latitude, longitude: routeEndpoints.from.longitude }
            : userCoords
                ? { latitude: userCoords.lat, longitude: userCoords.lng }
                : null;
        return origin ? [origin, ...cs] : cs;
    }, [selectedOption, routeEndpoints, userCoords]);

    const handlePinTap = useCallback((storeId: number) => {
        setSelectedStoreId(storeId);
        setSelectedOptionKey(null); // default to the best option for this store
    }, []);
    const handleSelectOption = useCallback((key: string) => setSelectedOptionKey(key), []);
    const closeSheet = useCallback(() => { setSelectedStoreId(null); setSelectedOptionKey(null); }, []);
    // Hardware back peels ONE layer: invite pane → store selection → (default
    // navigation). Registered only while a layer is open so normal back is
    // untouched otherwise.
    useEffect(() => {
        if (!invitePane && !selectedStoreId) return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            if (invitePane) { setInvitePane(false); return true; }
            if (selectedStoreId) { closeSheet(); return true; }
            return false;
        });
        return () => sub.remove();
    }, [invitePane, selectedStoreId, closeSheet]);
    // Touches on the sheet never reach the map (its panel consumes them), so
    // these fire only for genuine map interactions. The timestamp backstop stays
    // for the rare leaked onPress on the floating bar.
    const sheetPressRef = useRef(0);
    const noteSheetPress = useCallback(() => { sheetPressRef.current = Date.now(); }, []);
    // Map TAP (press, no drag) — collapse an expanded main dock, else deselect a
    // store. NOT on touch-start: a map DRAG must pan the map, never collapse the
    // sheet (mirrors the store case, where a drag pans and a tap deselects).
    const handleMapTap = useCallback(() => {
        if (Date.now() - sheetPressRef.current < 400) return;
        if (dockExpanded) { dockRef.current?.collapse(); return; }
        closeSheet();
    }, [dockExpanded, closeSheet]);

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
        try { await saveLocationSettings({ storeCount: n }, id); } catch {}
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
            const res = await fetchStorePrices(Number(id), [storeId], coords, saverModeRef.current);
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
            const res = await fetchStorePrices(Number(id), visibleUnpriced, coords, saverModeRef.current);
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
    // Ordered travel coords for ANY option's stores — ROUTE mode: from → stores
    // (ordered along the way) → to; GPS/place: origin → stores (nearest-first).
    // Shared by the selected-option map line AND the per-option journey distances,
    // so "how far" everywhere means the real through-journey, not a radial leg.
    // Pure logic + unit tests live in utils/journey.ts.
    const journeyCtx = useMemo(
        () => ({ origin: userCoords, routeEndpoints }),
        [userCoords, routeEndpoints],
    );

    const routeCoords = useMemo(
        () => (selectedOption ? buildJourneyCoords(selectedOption.stores, journeyCtx) : null),
        [selectedOption, journeyCtx],
    );

    // Total journey distance for the selected option's Navigate button — GPS/place
    // ends at the last store; route ends at the destination. null when no origin.
    const journeyKm = useMemo(() => sumJourneyKm(routeCoords), [routeCoords]);

    // Same journey, computed PER option, so the sheet bar and the single-store
    // option card show the actual travel distance (start → store [→ end]) instead
    // of the raw radial `store.distance`. Multi-store cards keep their +extra chip.
    const journeyByOption = useMemo(() => {
        const m = new Map<string, number | null>();
        for (const o of selectedOptions) m.set(o.key, journeyKmForStores(o.stores, journeyCtx));
        return m;
    }, [selectedOptions, journeyCtx]);

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

            // Replace any existing lists for this basket (a previous store pick)
            // so re-selecting stores doesn't accumulate stale tabs/progress.
            await fetch(`${API_BASE_URL}/api/baskets/${Number(id)}/shopping-lists`, { method: 'DELETE' }).catch(() => {});

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

            // Drop any stale split cache from a previous multi-store pick so the
            // list screen doesn't rebuild old store tabs.
            await AsyncStorage.removeItem(`split_lists_${id}`).catch(() => {});
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

            // Replace any existing lists for this basket (a previous combo pick)
            // so re-selecting stores doesn't accumulate stale tabs/progress.
            await fetch(`${API_BASE_URL}/api/baskets/${Number(id)}/shopping-lists`, { method: 'DELETE' }).catch(() => {});

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
                {!mapMounted ? (
                    // NOT a second screen: just the page background under the
                    // CalcLoadingModal, which owns the whole entry (spinner +
                    // rotating messages) until the map is ready to draw its one
                    // and only frame. A spinner here would be a second loading
                    // UI for the same wait.
                    <View style={styles.loadingContainer} />
                ) : (
                    // Full-bleed map fills the content region; the option sheet
                    // floats over it at the bottom. The heavy MapView mount is
                    // deferred a frame past entry so the screen paints instantly.
                    <>
                        <StoreResultsMap
                            mapRef={resultsMapRef}
                            pickMode={!!pickingPreset}
                            onPickTarget={handlePickTarget}
                            pins={pins}
                            userCoords={userCoords}
                            fallbackCenter={lastKnownCenter}
                            focusCoords={focusCoords}
                            recommendedCoords={recommendedCoords}
                            routeEndpoints={routeEndpoints}
                            originPin={originPin}
                            onSelectStore={handlePinTap}
                            onMapPress={handleMapTap}
                            colors={colors}
                            directory={directory}
                            pricedStoreIds={pricedStoreIds}
                            pricingStoreId={pricingStoreId}
                            onLazyPrice={handleLazyPrice}
                            routeCoords={routeCoords}
                            onVisibleUnpricedChange={setVisibleUnpriced}
                            // Settled sheet occlusion → camera-only (mapPadding /
                            // iOS fit padding). The map itself stays full-bleed.
                            // During a pick the dock is gone → no occlusion, so the
                            // camera centre == screen centre == the pin.
                            bottomOverlay={embedded || pickingPreset ? 0 : sheetOcclusion}
                        />
                        {/* Full-bleed map → floating back circle, top-left
                            (standalone route only — the embedding host owns
                            its own back button). */}
                        {!embedded && !pickingPreset && (
                            <View style={[styles.mapTopLeft, { top: topInset + 10 }]} pointerEvents="box-none">
                                <MapBackButton onPress={() => router.back()} />
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
                )}
            {/* Box-none overlay above the map: the sheet's own views are the
                touch targets; empty area falls through to the map (the canonical
                gorhom-over-react-native-maps routing — no scrollEnabled toggles,
                no gesture arbitration against the GL surface). */}
            <View style={StyleSheet.absoluteFill} pointerEvents="box-none">

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
                    journeyByOption={journeyByOption}
                    itemCount={basketItemCount}
                    colors={colors}
                    onInteract={noteSheetPress}
                    onDismiss={closeSheet}
                    onCollapsedClearance={setDockClearance}
                    onOcclusion={setSheetOcclusion}
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
                    mapMode
                    progressSV={sheetProgress}
                    onCollapsedClearance={setDockClearance}
                    onOcclusion={setSheetOcclusion}
                    barRowHeight={dockBarH}
                    barRow={
                        <View
                            style={styles.dockBar}
                            onLayout={e => { const h = Math.round(e.nativeEvent.layout.height); if (h > 0) setDockBarH(h); }}
                        >
                            {/* The invite pane's "‹ Pakviesti" row is NOT here
                                any more — a pane brings its own bar row via the
                                sheet's pane contract (SheetPaneSpec.barRow),
                                which also un-guards the spinner/more-prices
                                pips below: this row simply never renders while
                                the pane is open. */}
                            {cheapestTotal != null ? (
                                <View style={styles.summaryHero}>
                                    <Animated.Text style={[styles.summaryPrice, priceGrowStyle]} numberOfLines={1}>
                                        {formatEuro(cheapestTotal)}
                                    </Animated.Text>
                                    <View style={styles.summaryCaps}>
                                        <Text style={styles.summaryCapTop} numberOfLines={1}>
                                            {t('results.mapCheapestCaption')}
                                        </Text>
                                        <Text style={styles.summaryCapBottom} numberOfLines={1}>
                                            {t('results.mapComparedStores', { count: pricedCount })}
                                        </Text>
                                    </View>
                                </View>
                            ) : (
                                <Animated.Text style={[styles.summaryText, titleStyle]} numberOfLines={1}>
                                    {t('results.mapSummaryEmpty')}
                                </Animated.Text>
                            )}
                            {recalcing && <MaterialProgress size="small" color={colors.primary} />}
                            {visibleUnpriced.length > 0 && (
                                <TouchableOpacity
                                    style={styles.morePricesRound}
                                    accessibilityLabel={t('results.morePrices')}
                                    onPress={handleBatchPrice}
                                    disabled={batchPricing}
                                    activeOpacity={0.6}
                                    hitSlop={8}
                                >
                                    {batchPricing
                                        ? <MaterialProgress size="small" color={colors.primary} />
                                        : <Ionicons name="add" size={20} color={colors.primary} />}
                                </TouchableOpacity>
                            )}
                        </View>
                    }
                    sheet={{
                        maxStage: 2,
                        onStageChange: (st) => { setDockExpanded(st > 0); },
                        // Invite = the sheet's own pane contract: the bar row
                        // swaps to "‹ Pakviesti", the body page-slides, and the
                        // sheet clears the pane (onDismiss) on every collapse —
                        // this surface no longer branches its bar row or resets
                        // pane state by hand.
                        pane: invitePane && tripId != null ? {
                            key: 'invite',
                            barRow: (
                                <View style={styles.dockBar}>
                                    <View style={styles.summaryHero}>
                                        <TouchableOpacity
                                            onPress={() => setInvitePane(false)}
                                            hitSlop={10}
                                            accessibilityLabel={t('common.back')}
                                        >
                                            <Ionicons name="chevron-back" size={26} color={colors.primary} />
                                        </TouchableOpacity>
                                        <Ionicons name="person-add" size={17} color={colors.primary} />
                                        <Animated.Text style={[styles.summaryText, titleStyle]} numberOfLines={1}>
                                            {t('basketDetail.inviteTitle')}
                                        </Animated.Text>
                                    </View>
                                </View>
                            ),
                            content: (
                                <View style={styles.dockContent}>
                                    <InvitePane
                                        inviteUrl={inviteUrl}
                                        members={members}
                                        colors={colors}
                                        onSendInvite={(target) => sendAddressedTripInvite(tripId, target)}
                                        onRemoveMember={(userId) => removeTripMember(tripId, userId)}
                                        onInvitesSent={() => void refreshMembers(tripId)}
                                    />
                                </View>
                            ),
                            onDismiss: () => setInvitePane(false),
                        } : null,
                        content: (
                            <View style={styles.dockContent}>
                                <DockActionRow
                                    colors={colors}
                                    gap={14}
                                    actions={[
                                        {
                                            icon: 'cart-outline',
                                            title: t('tripMap.basketBtn'),
                                            subtitle: t('tripMap.basketBtnSub'),
                                            // REPLACE (not push): swap the map for the
                                            // basket so the back stack stays [Shopping,
                                            // <map|basket>] — Back always returns to
                                            // Shopping, never a stale stack of maps.
                                            onPress: () => router.replace(`/basket/${id}` as any),
                                            badge: basketItemCount > 0
                                                ? <View style={styles.cartCount}><Text style={styles.cartCountText}>{basketItemCount}</Text></View>
                                                : undefined,
                                        },
                                        {
                                            icon: 'person-add',
                                            title: t('basketDetail.inviteTitle'),
                                            subtitle: t('basketDetail.inviteSub'),
                                            onPress: () => void openInvite(),
                                            badge: members.length > 1 ? (
                                                <View style={styles.memberStack}>
                                                    {members.slice(0, 3).map((m, i) => (
                                                        <View key={m.userId} style={[styles.memberDot, i > 0 && styles.memberDotOverlap]}>
                                                            <Text style={styles.memberDotText}>
                                                                {m.label.replace(/^@/, '').charAt(0).toUpperCase()}
                                                            </Text>
                                                        </View>
                                                    ))}
                                                    {members.length > 3 && (
                                                        <View style={[styles.memberDot, styles.memberDotOverlap, styles.memberDotMore]}>
                                                            <Text style={styles.memberDotText}>+{members.length - 3}</Text>
                                                        </View>
                                                    )}
                                                </View>
                                            ) : undefined,
                                        },
                                    ]}
                                />

                                {/* Location & Route — GPS / Place / Route selection inline. */}
                                <DockSection colors={colors} icon="navigate-outline" title={t('tripMap.locationRoute')}>
                                    <LocationSettingsPanel
                                        compact
                                        scope={id}
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
                                            onValueChange={(v) => {
                                                setSaverMode(v);
                                                saverModeRef.current = v; // sync before the recalc reads it
                                                void AsyncStorage.setItem('saverMode', v ? '1' : '0');
                                                // Collapse the dock so the loading modal + repriced
                                                // results are the focus, not the settings sheet.
                                                dockRef.current?.collapse();
                                                // Reprice: saver widens the pool → different results.
                                                setLazyResults([]);
                                                void recalcForLocationChange();
                                            }}
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

            {/* Calc loading modal — spinner + rotating messages while the initial
                load OR any recalc (saver toggle / location change) runs. It lifts
                when the data lands; the map/pills then reveal underneath. */}
            {/* ONE loading state for the whole entry: cache read → origin →
                calculation → the map's first frame. It lifts when the map is
                mounted with real data underneath it, so the reveal is the map
                already framed on your area — never a re-navigation. */}
            <CalcLoadingModal visible={((loading || !mapMounted) && !pullRefreshing) || recalcing} />

            <LocationPromptModal
                visible={locationPromptVisible}
                onResolved={async (coords) => {
                    setLocationPromptVisible(false);
                    await runRecalcWithCoords(coords);
                }}
                onCancel={() => setLocationPromptVisible(false)}
            />

            {/* "Define a location" — centre-pin pick ON the existing store map
                (no second map): the map runs in pickMode (markers hidden, still
                pans), this transparent box-none layer adds the pin + glass chrome,
                and the dock morphs into the confirm bar. Back cancels + restores
                the dock (Location page). */}
            {pickingPreset && (
                <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
                    {/* Key by the open sequence → every open remounts (fresh name/
                        address state + re-run entry animation), never reusing the
                        previously-edited preset's instance. */}
                    <PresetPickChrome
                        key={pickingPreset.seq}
                        mapRef={resultsMapRef}
                        presetKey={pickingPreset.key}
                        label={pickingPreset.label}
                        existing={pickingPreset.existing}
                        pickTarget={pickTarget}
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
    // Floating map header (map view is full-bleed): back circle + toggle, left.
    mapTopLeft: { position: 'absolute', left: spacing.md, alignItems: 'flex-start', gap: spacing.sm, zIndex: 20 },
    // Top-centre store-count segmented toggle (1·2·3).
    mapTopCenter: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 20 },
    optText: { ...typography.bodyStrong, color: c.textPrimary },
    qrBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
    qrCard: { backgroundColor: c.cardBackground, borderRadius: radius.xl, padding: spacing.xl, alignItems: 'center', gap: spacing.lg },
    loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg, backgroundColor: c.pageBackground },
    loadingText: { ...typography.body, color: c.textSecondary },

    // ── Glass dock ─────────────────────────────────────────────────────────
    // NO horizontal padding — the sheet lays the bar row out at the shared
    // PEEK inset; content (SheetContent) uses the same, so they align.
    dockBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 40 },
    summaryText: { flex: 1, fontSize: 15, fontWeight: '700', color: c.textPrimary },
    // V1 "price hero" collapsed bar: big price + quiet two-line caption.
    summaryHero: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
    summaryPrice: {
        fontSize: 23, fontWeight: '800', letterSpacing: -0.4,
        color: c.textPrimary, fontVariant: ['tabular-nums'],
    },
    summaryCaps: { flexShrink: 1 },
    summaryCapTop: { fontSize: 11, lineHeight: 14, color: c.textSecondary },
    summaryCapBottom: { fontSize: 11, lineHeight: 14, fontWeight: '600', color: c.textPrimary },
    morePricesRound: {
        width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
        backgroundColor: c.primaryMuted,
    },
    // Inset + halo clearance come from the sheet's SheetContent wrapper.
    dockContent: { gap: 14 },
    // Item-count pip overlaid on the Basket action card's cart icon.
    cartCount: {
        position: 'absolute', top: -6, right: -10, minWidth: 18, height: 18, borderRadius: 9,
        paddingHorizontal: 4, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center',
    },
    cartCountText: { color: c.onPrimary, fontSize: 10, fontWeight: '800' },
    // Stacked member initials on the Pakviesti card (like map pill logo stacks).
    memberStack: { position: 'absolute', top: -8, right: -12, flexDirection: 'row' },
    memberDot: {
        width: 20, height: 20, borderRadius: 10, backgroundColor: c.primary,
        borderWidth: 1.5, borderColor: c.cardBackground,
        alignItems: 'center', justifyContent: 'center',
    },
    memberDotOverlap: { marginLeft: -7 },
    memberDotMore: { backgroundColor: c.textSecondary },
    memberDotText: { color: c.onPrimary, fontSize: 9.5, fontWeight: '800' },
    settingRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
    settingText: { fontSize: 15, fontWeight: '600', color: c.textPrimary },
    settingSub: { fontSize: 12, color: c.textSecondary, marginTop: 2 },
});
