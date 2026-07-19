import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Image, Platform, StyleSheet, TouchableOpacity, Dimensions } from 'react-native';
import MapView, { Marker, Polyline, type Region } from 'react-native-maps';
import Animated, { useSharedValue, useAnimatedProps, type SharedValue } from 'react-native-reanimated';
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Asset } from 'expo-asset';
import { Ionicons } from '@expo/vector-icons';
import { spacing, radius, elevation, iconSize, useResolvedScheme, type AppTheme } from '../../constants/theme';
import { chainBrandColorById } from '../../utils/chainBrandName';
import { chainPinImage, chainBadgeImage } from '../../utils/chainLogoAssets';
import { useBakedPills, useBakedClusters, MapPillMarker, MapClusterMarker, type MapPillSpec, type MapPillVariant, type MapClusterSpec } from '../map/MapPill';
import { MapPillOverlay, MapDirectoryOverlay, projectPillRect, clusterBubbleSize, type OverlayPillSpec, type OverlayClusterSpec, type OverlaySingleSpec, type OverlayGhostSpec } from '../map/MapPillOverlay';
import { DARK_MAP_STYLE } from '../../constants/darkMapStyle';
import { formatEuro } from '../../utils/formatCurrency';
import { type StoreLite } from '../../utils/candidatePool';
import { clusterByGrid, bucketingKey, type Cluster, type GridRegion } from '../../utils/mapClustering';
import { LiquidGlass } from '../LiquidGlass';
const AnimatedMapView = Animated.createAnimatedComponent(MapView);

export type MapPin = {
    storeId: number;
    chainId: number;
    chainName: string;
    miniLogoUrl: string | null;
    latitude: number;
    longitude: number;
    euro: number | null;
    active: boolean;
    recommended: boolean;
    /** COMBO context: when this pin's shown price comes from a split option,
     *  the partner stores' chains (1 for a 2-store combo, 2 for 3-store). The
     *  pill renders them as badges stacked behind the pin's own logo. Empty
     *  when the price is a single-store total OR the pin is the active member
     *  of the selected combo (partners hide on selection). */
    partnerChainIds: number[];
};

type LatLng = { latitude: number; longitude: number };

const SCREEN_H = Dimensions.get('window').height;

// The un-priced directory layer re-buckets on every pan/zoom. On iOS that
// marker mount/unmount CHURN used to feed the Fabric interop a nil subview →
// `-[AIRMap insertReactSubview:]: object cannot be nil` → SIGABRT — so on iOS
// the directory now renders in the PROJECTED OVERLAY (plain RN views, no
// native markers, no crash surface, no rebuild needed). Android keeps the
// native markers (its crashes were fixed app-side). The committed nil-guard
// patch additionally hardens native inserts on the next iOS build.

type Props = {
    pins: MapPin[];
    userCoords: { lat: number; lng: number } | null;
    focusCoords: LatLng[] | null;
    /** The recommended (cheapest, pink) option's store coordinates — the map
     *  frames these on load / when nothing is selected, instead of fitting every
     *  pin. MULTIPLE entries (a recommended 2-store split) are FIT together —
     *  centering on just the first store left the combo partner off-viewport
     *  (the "maxima pin not visible on open" bug). */
    recommendedCoords?: LatLng[] | null;
    /** Route mode: the two trip endpoints (start/end) — drawn as markers and
     *  used as the route line's ends instead of the user dot. */
    routeEndpoints?: { from: LatLng; to: LatLng } | null;
    onSelectStore: (storeId: number) => void;
    colors: AppTheme;
    /** Every store in Lithuania (un-priced) — the background directory layer.
     *  Clustered when zoomed out, individual muted logos when zoomed in. */
    directory?: StoreLite[];
    /** Store ids that already carry a price pill → excluded from the directory
     *  layer so we never double-render the same store. */
    pricedStoreIds?: Set<number>;
    /** Store currently being lazily priced (tap → fetch) — shown dimmed. */
    pricingStoreId?: number | null;
    /** Tap an un-priced directory store → lazily price it. */
    onLazyPrice?: (storeId: number) => void;
    /** Ordered route (user → stops) drawn for a selected split combo. */
    routeCoords?: LatLng[] | null;
    /** Tap empty map (not a marker) → dismiss the options sheet. */
    onMapPress?: () => void;
    /** Height (px) the bottom sheet currently occludes, so centering/fitting
     *  keeps content in the visible area above it. 0 = nothing covering. */
    bottomOverlay?: number;
    /** Reports the nearest un-priced stores currently in view (capped at the
     *  batch limit) so the parent can offer an "price this area" button. */
    onVisibleUnpricedChange?: (storeIds: number[]) => void;
    /** UI-thread flag: while true the map's pan is disabled (sheet is being
     *  touched) — driven by the sheet's gesture, no JS-state lag. */
    scrollDisabledSV?: SharedValue<boolean>;
    /** UI-thread flag: true while a sheet is open above the collapsed bar. The
     *  map's pan is disabled for the whole time (not just during a drag), so
     *  sheet touches can never move the map. */
    sheetOpenSV?: SharedValue<boolean>;
    /** Stable gate for the non-animated gestures (zoom): false while a sheet is
     *  open, so a pinch on the sheet can't zoom the map. */
    gesturesEnabled?: boolean;
    /** Ref to the map's own native gesture. The dock's pan
     *  `.blocksExternalGesture()`s this, so a drag that begins on the bar holds
     *  the map's native pan off on the native thread — the ONLY way to win the
     *  first bar-drag (scrollEnabled is read by the map at touch-down, too late
     *  for a JS flag flipped in onBegin). */
    nativeGestureRef?: React.MutableRefObject<GestureType | undefined>;
};

type Styles = ReturnType<typeof makeStyles>;

/**
 * One store pin = a baked circular chain BADGE + an attached PRICE pill. They're
 * TWO markers on purpose: Android won't rasterise a child <Image> inside a custom
 * marker view, so the logo has to ride the marker's native `image` prop (a
 * pre-composed logo-on-brand PNG — chainBadgeImage). The price is dynamic text,
 * so it's a separate View marker seated to the badge's right; it re-snapshots
 * briefly on any visual change then freezes. The badge is a native image, so it
 * always renders and never needs tracking.
 *
 * Colour encodes value: cheapest = pink ring, others = white ring; selected =
 * solid pink pill. The badge marker sits one z above its pill so it stays on top.
 */
// A priced pin → its baked-pill spec (logo + price). The key is the visual identity
// (storeId|price|variant) so the image re-bakes only when the price or cheapest/selected
// state changes. Unpriced pins have no pill → the marker falls back to the bare badge.
const pinVariant = (pin: MapPin): MapPillVariant =>
    pin.active ? 'selected' : pin.recommended ? 'cheapest' : 'neutral';
const specForPin = (pin: MapPin): MapPillSpec | null =>
    pin.euro == null
        ? null
        : {
              // Partners are part of the visual identity → in the key, so the
              // pill re-bakes when the combo badges appear/disappear.
              key: `${pin.storeId}|${pin.euro}|${pin.active ? 's' : pin.recommended ? 'r' : 'n'}|P${pin.partnerChainIds.join('.')}`,
              chainId: pin.chainId,
              lines: [formatEuro(pin.euro)],
              variant: pinVariant(pin),
              partnerChainIds: pin.partnerChainIds,
          };


/**
 * A single un-priced directory store — just the logo (no pill). Reads as "store
 * here, tap to see its basket price". Dimmed while its price is being fetched.
 *
 * Platform split: Android uses the native `image` prop (child images don't
 * rasterise there). iOS renders a slightly LARGER child image inside a padded
 * tap area — the native-asset size is too small to spot/tap comfortably, and
 * iOS renders child images fine. The brief tracksViewChanges window lets the
 * (preloaded) image snapshot once, then freezes for performance.
 */
function DirectoryPin({ store, styles, pricing, onPress }: {
    store: StoreLite; styles: Styles; pricing: boolean; onPress: (id: number) => void;
}) {
    const logo = chainPinImage(store.chainId, false);
    const tap = () => onPress(store.id);

    // CHILDLESS native image marker on BOTH platforms. iOS previously wrapped a
    // larger logo in a child <View> for tappability, but child-View <Marker>s
    // churn through the AIRMapMarker interop on every zoom re-cluster and
    // destabilise the whole map's marker rendering — the confirmed cause of the
    // priced pills vanishing (A/B: hiding this layer stopped it). A native
    // `image` marker never inserts a child subview. Static (require'd) assets
    // decode synchronously, so tracksViewChanges can stay false. The no-logo
    // fallback is the only remaining child-View — rare, negligible churn.
    if (logo != null) {
        return (
            <Marker
                coordinate={{ latitude: store.latitude, longitude: store.longitude }}
                anchor={{ x: 0.5, y: 0.5 }}
                image={logo}
                opacity={pricing ? 0.45 : Platform.OS === 'ios' ? 1 : 0.92}
                tracksViewChanges={false}
                zIndex={1}
                onPress={tap}
            />
        );
    }
    return (
        <Marker
            coordinate={{ latitude: store.latitude, longitude: store.longitude }}
            anchor={{ x: 0.5, y: 0.5 }}
            opacity={pricing ? 0.45 : 1}
            tracksViewChanges={false}
            zIndex={1}
            onPress={tap}
        >
            <View style={[styles.fallbackChip, { backgroundColor: chainBrandColorById(store.chainId) }]}>
                <Text style={styles.fallbackText}>{(store.chainName[0] ?? '?').toUpperCase()}</Text>
            </View>
        </Marker>
    );
}

/** Preload the chain logo assets once so the native marker images paint instantly. */
let _logosPreloaded = false;
function preloadLogos() {
    if (_logosPreloaded) return;
    _logosPreloaded = true;
    const mods = [1, 2, 3, 4, 5]
        .flatMap(id => [chainPinImage(id, false), chainPinImage(id, true)])
        .filter((m): m is number => m != null);
    Asset.loadAsync(mods).catch(() => { _logosPreloaded = false; });
}

// ── iOS DIRECTORY LAYER (isolated re-render domain) ─────────────────────────
// Owns its OWN region state (the parent registers a setter and feeds it from
// the map's region callbacks), so a live zoom-recluster commit re-renders ONLY
// this small subtree — clusterByGrid + ~dozens of dots — never the whole map
// component. Re-rendering StoreResultsMap several times a second during a
// pinch (clustering + ghost setState + purge-timer renders) was the zoom
// stutter: the JS thread starved and the region stream fell behind.
// Also computes the split/merge choreography in ONE render-derived pass:
// flight origins from the previous bucketing, exit ghosts derived (no setState,
// no purge timers — ghosts end invisible and are replaced next re-bucket).
type DirHitData = { clusters: Cluster[]; singles: OverlaySingleSpec[] };
const DirectoryLayer = React.memo(function DirectoryLayer({
    directoryPts, initialRegion, registerRegionSetter, liveRegion, mapW, mapH,
    cardBackground, primary, pricingStoreId, onVisibleUnpricedChange, hitRef,
}: {
    directoryPts: (StoreLite & { latitude: number; longitude: number })[];
    initialRegion: GridRegion;
    registerRegionSetter: (fn: (r: GridRegion, live: boolean) => void) => void;
    liveRegion: SharedValue<Region>;
    mapW: SharedValue<number>;
    mapH: SharedValue<number>;
    cardBackground: string;
    primary: string;
    pricingStoreId?: number | null;
    onVisibleUnpricedChange?: (storeIds: number[]) => void;
    hitRef: React.MutableRefObject<DirHitData>;
}) {
    // `live` = this commit happened mid-gesture → persisting dots SNAP to
    // their new targets (stay coupled to the pinch); a settle commit glides.
    // snapRef mirrors it WITHOUT being a prop: passing `snap` as a boolean
    // broke every dot's memo twice per gesture (live→settle flips re-rendered
    // ~90 dots). LIVE commits render inside startTransition: concurrent React
    // slices the fiber work so queued region events keep feeding liveRegion
    // between units — the commit can't starve the tracking pipeline.
    const [regionState, setRegionState] = useState<{ region: GridRegion; live: boolean }>({ region: initialRegion, live: false });
    const region = regionState.region;
    const snapRef = useRef(false);
    useEffect(() => {
        registerRegionSetter((r, live) => {
            snapRef.current = live;
            if (live) startTransition(() => setRegionState({ region: r, live }));
            else setRegionState({ region: r, live });
        });
    }, [registerRegionSetter]);

    const { clusters, singles } = useMemo(
        () => clusterByGrid(directoryPts, region),
        [directoryPts, region],
    );

    // Choreography — one render-derived pass. KEY INHERITANCE is the
    // anti-flash core: grid-cell ids change with every zoom delta, so keying
    // bubbles by cell id remounted EVERY cluster on EVERY live re-bucket
    // (constant fade-in/flight = strobing during a pinch). Instead, each next
    // cluster claims the STABLE KEY of the prev cluster contributing most of
    // its members — the mounted bubble persists and GLIDES to its new
    // centroid/count. Only genuine splits (non-dominant children) mount fresh
    // with a flight, and only genuinely absorbed dots exit as ghosts.
    const prevRef = useRef<{ clusters: Cluster[]; singles: typeof directoryPts }>({ clusters: [], singles: [] });
    const stableKeysRef = useRef(new Map<string, string>()); // prev cell id → stable render key
    // stable key → the position the bubble is RENDERED at. During LIVE commits
    // a persisting bubble HOLDS this position — centroids are a step function
    // of zoom, and updating targets mid-gesture (glide OR snap) is exactly the
    // repeated decouple/couple the pinch showed. Held bubbles are ordinary
    // glued dots whose target never moves; the SETTLE commit glides them to
    // their true centroids.
    const posByKeyRef = useRef(new Map<string, { lat: number; lng: number }>());
    const live = regionState.live;
    // ADAPTIVE choreography: a FAST zoom crosses several levels back-to-back —
    // running flights/ghosts for every crossing piles 320ms animations on top
    // of each other (the staged, stuttery cascade). If the previous re-bucket
    // was <400ms ago, transitions are INSTANT (just the mount fade); the full
    // split/merge choreography plays only for deliberate, spaced-out crossings.
    const lastBucketAtRef = useRef(0);
    const prevRegimeRef = useRef('');
    const { overlayClusters, overlaySingles, ghosts } = useMemo(() => {
        const now = Date.now();
        const animate = now - lastBucketAtRef.current >= 400;
        lastBucketAtRef.current = now;
        // FAST-PAN bypass: a live commit that didn't change the bucketing
        // regime is a pure pan — the world-anchored level-quantized grid
        // cannot split or merge within a level, so persisting cells keep the
        // SAME cell id and the dominant-matching + ghost passes are pointless
        // work on the hot path. Stable keys come from a direct id lookup; new
        // edge cells mount plainly (no flights — nothing split).
        const regime = bucketingKey(region.longitudeDelta);
        const fastPan = live && regime === prevRegimeRef.current;
        prevRegimeRef.current = regime;
        const prev = prevRef.current;
        const prevStableKeys = stableKeysRef.current;
        const heldPos = new Map(posByKeyRef.current); // pre-pass snapshot (flight/ghost anchors)
        const prevClusterByStore = new Map<number, Cluster>();
        if (!fastPan) for (const pc of prev.clusters) for (const pid of pc.pointIds) prevClusterByStore.set(pid, pc);
        // Rendered position of a PREV cluster (held bubble pos, else centroid).
        const prevRenderedPos = (pc: Cluster) => {
            const k = prevStableKeys.get(pc.id);
            return (k && heldPos.get(k)) || { lat: pc.latitude, lng: pc.longitude };
        };

        const claimed = new Set<string>();
        const inheritedPrevIds = new Set<string>();
        const newStableKeys = new Map<string, string>();
        const newPos = new Map<string, { lat: number; lng: number }>();
        const renderedPosByCellId = new Map<string, { lat: number; lng: number }>();
        const oc: OverlayClusterSpec[] = [];
        if (fastPan) {
            for (const c of clusters) {
                const prevStable = prevStableKeys.get(c.id);
                let key: string;
                let lat = c.latitude;
                let lng = c.longitude;
                if (prevStable && !claimed.has(prevStable)) {
                    key = prevStable;           // same cell survived → same bubble
                    inheritedPrevIds.add(c.id);
                    // Mid-gesture: HOLD the rendered position (no target step).
                    const held = heldPos.get(key);
                    if (held) { lat = held.lat; lng = held.lng; }
                } else {
                    key = claimed.has(c.id) ? `${c.id}~` : c.id;
                }
                claimed.add(key);
                newStableKeys.set(c.id, key);
                newPos.set(key, { lat, lng });
                renderedPosByCellId.set(c.id, { lat, lng });
                oc.push({ id: key, latitude: lat, longitude: lng, count: c.count });
            }
        } else {
        // Dominant predecessor per next cluster.
        const doms = clusters.map(c => {
            let best: Cluster | null = null;
            let bestN = 0;
            const counts = new Map<string, number>();
            for (const pid of c.pointIds) {
                const pc = prevClusterByStore.get(pid);
                if (pc) {
                    const n = (counts.get(pc.id) ?? 0) + 1;
                    counts.set(pc.id, n);
                    if (n > bestN) { bestN = n; best = pc; }
                }
            }
            return { c, best, bestN };
        });
        // Claim stable keys, biggest overlap first (a split's dominant child
        // keeps the bubble; siblings fly out of it as new mounts).
        for (const { c, best } of [...doms].sort((a, b) => b.bestN - a.bestN)) {
            const prevStable = best ? prevStableKeys.get(best.id) : undefined;
            let key: string;
            let fromLat: number | undefined;
            let fromLng: number | undefined;
            let lat = c.latitude;
            let lng = c.longitude;
            if (prevStable && !claimed.has(prevStable)) {
                key = prevStable;               // persist → no remount
                inheritedPrevIds.add(best!.id);
                if (live) {
                    // Mid-gesture: HOLD the rendered position (no target step).
                    const held = heldPos.get(key);
                    if (held) { lat = held.lat; lng = held.lng; }
                }
            } else {
                key = claimed.has(c.id) ? `${c.id}~` : c.id;
                if (best && animate) {
                    // Fresh mount → fly out of the parent's RENDERED position.
                    const p = prevRenderedPos(best);
                    fromLat = p.lat; fromLng = p.lng;
                }
            }
            claimed.add(key);
            newStableKeys.set(c.id, key);
            newPos.set(key, { lat, lng });
            renderedPosByCellId.set(c.id, { lat, lng });
            oc.push({ id: key, latitude: lat, longitude: lng, count: c.count, fromLat, fromLng });
        }
        }
        const os: OverlaySingleSpec[] = singles.map(s => {
            const pc = prevClusterByStore.get(s.id);
            const from = animate && pc ? prevRenderedPos(pc) : undefined;
            return {
                id: s.id, latitude: s.latitude, longitude: s.longitude,
                logo: chainPinImage(s.chainId, false),
                fallbackColor: chainBrandColorById(s.chainId),
                fallbackLetter: (s.chainName[0] ?? '?').toUpperCase(),
                pricing: pricingStoreId === s.id,
                fromLat: from?.lat, fromLng: from?.lng,
            };
        });

        const nextClusterByStore = new Map<number, Cluster>();
        for (const c of clusters) for (const pid of c.pointIds) nextClusterByStore.set(pid, c);
        const nextSingleIds = new Set(singles.map(s => s.id));
        // Ghosts fly INTO the absorber's RENDERED position (held or centroid).
        // Skipped entirely on rapid re-buckets (see `animate`).
        const ghostTarget = (nc: Cluster) => renderedPosByCellId.get(nc.id) ?? { lat: nc.latitude, lng: nc.longitude };
        const gs: OverlayGhostSpec[] = [];
        if (animate && !fastPan) {
        for (const ps of prev.singles) {
            if (nextSingleIds.has(ps.id)) continue;
            const nc = nextClusterByStore.get(ps.id);
            if (!nc) continue;
            const to = ghostTarget(nc);
            gs.push({
                key: `gs-${ps.id}-${nc.id}`, kind: 'single',
                logo: chainPinImage(ps.chainId, false),
                fallbackColor: chainBrandColorById(ps.chainId),
                fallbackLetter: (ps.chainName[0] ?? '?').toUpperCase(),
                fromLat: ps.latitude, fromLng: ps.longitude,
                toLat: to.lat, toLng: to.lng,
            });
            if (gs.length >= 24) break;
        }
        for (const pc of prev.clusters) {
            if (gs.length >= 24) break;
            // A prev cluster whose bubble PERSISTED (key inherited) isn't gone
            // — it's the same mounted bubble. Ghost only the absorbed ones.
            if (inheritedPrevIds.has(pc.id)) continue;
            let best: Cluster | null = null;
            let bestN = 0;
            const counts = new Map<string, number>();
            for (const pid of pc.pointIds) {
                const nc = nextClusterByStore.get(pid);
                if (nc) {
                    const n = (counts.get(nc.id) ?? 0) + 1;
                    counts.set(nc.id, n);
                    if (n > bestN) { bestN = n; best = nc; }
                }
            }
            if (best) {
                const from = prevRenderedPos(pc);
                const to = ghostTarget(best);
                gs.push({
                    key: `gc-${pc.id}-${best.id}`, kind: 'cluster', count: pc.count,
                    fromLat: from.lat, fromLng: from.lng,
                    toLat: to.lat, toLng: to.lng,
                });
            }
        }
        }
        // UNION-not-swap retention: on LIVE commits, dots that merely slid out
        // of the (tight-margin) render window stay MOUNTED at their rendered
        // position instead of unmounting — the mount/unmount burst at every
        // pan commit was the stall, and panning back would remount them all
        // over again. Absorbed/split members are excluded (the choreography
        // owns those). The SETTLE commit skips retention, so everything truly
        // gone unmounts once, off-screen, invisibly.
        const retainedClusters: Cluster[] = [];
        const retainedSingles: typeof singles = [];
        if (live) {
            let budget = 40;
            for (const ps of prev.singles) {
                if (budget <= 0) break;
                if (nextSingleIds.has(ps.id) || nextClusterByStore.has(ps.id)) continue;
                retainedSingles.push(ps);
                os.push({
                    id: ps.id, latitude: ps.latitude, longitude: ps.longitude,
                    logo: chainPinImage(ps.chainId, false),
                    fallbackColor: chainBrandColorById(ps.chainId),
                    fallbackLetter: (ps.chainName[0] ?? '?').toUpperCase(),
                    pricing: pricingStoreId === ps.id,
                });
                budget--;
            }
            for (const pc of prev.clusters) {
                if (budget <= 0) break;
                if (inheritedPrevIds.has(pc.id)) continue;
                // Only FULLY departed clusters — any member still bucketed
                // means a real split/merge the choreography already handled.
                if (pc.pointIds.some(pid => nextClusterByStore.has(pid) || nextSingleIds.has(pid))) continue;
                const key = prevStableKeys.get(pc.id) ?? pc.id;
                if (claimed.has(key)) continue;
                claimed.add(key);
                newStableKeys.set(pc.id, key);
                const pos = heldPos.get(key) ?? { lat: pc.latitude, lng: pc.longitude };
                newPos.set(key, pos);
                retainedClusters.push(pc);
                oc.push({ id: key, latitude: pos.lat, longitude: pos.lng, count: pc.count });
                budget--;
            }
        }
        prevRef.current = {
            clusters: retainedClusters.length ? [...clusters, ...retainedClusters] : clusters,
            singles: retainedSingles.length ? [...singles, ...retainedSingles] : singles,
        };
        stableKeysRef.current = newStableKeys;
        posByKeyRef.current = newPos;
        return { overlayClusters: oc, overlaySingles: os, ghosts: gs };
    }, [clusters, singles, pricingStoreId, live, region.longitudeDelta]);

    hitRef.current = { clusters, singles: overlaySingles };

    // Report the nearest un-priced stores in view (for "price this area").
    const lastUnpricedRef = useRef('');
    useEffect(() => {
        if (!onVisibleUnpricedChange) return;
        // Settle commits only: mid-gesture the set is churning anyway, and the
        // callback re-renders the PARENT screen — a per-pan-commit parent
        // render is exactly the jank this layer exists to isolate.
        if (live) return;
        const cx = region.latitude, cy = region.longitude;
        const nearest = [...singles]
            .sort((a, b) =>
                ((a.latitude - cx) ** 2 + (a.longitude - cy) ** 2) -
                ((b.latitude - cx) ** 2 + (b.longitude - cy) ** 2))
            .slice(0, 10)
            .map(s => s.id);
        const key = nearest.join(',');
        if (key !== lastUnpricedRef.current) {
            lastUnpricedRef.current = key;
            onVisibleUnpricedChange(nearest);
        }
    }, [singles, region, live, onVisibleUnpricedChange]);

    return (
        <MapDirectoryOverlay
            clusters={overlayClusters}
            singles={overlaySingles}
            ghosts={ghosts}
            snapRef={snapRef}
            region={liveRegion}
            mapW={mapW}
            mapH={mapH}
            cardBackground={cardBackground}
            primary={primary}
        />
    );
});

function StoreResultsMap({
    pins, userCoords, focusCoords, recommendedCoords, routeEndpoints, onSelectStore, colors,
    directory, pricedStoreIds, pricingStoreId, onLazyPrice, routeCoords, onMapPress,
    onVisibleUnpricedChange, bottomOverlay = 0, scrollDisabledSV, sheetOpenSV, gesturesEnabled = true,
    nativeGestureRef,
}: Props) {
    // How much of the bottom is covered by the sheet (capped so a fully-extended
    // sheet doesn't try to cram everything into a sliver — at that point the map
    // isn't visible anyway). Read via a ref in the stable callbacks.
    const occlusion = Math.min(Math.max(bottomOverlay, 0), SCREEN_H * 0.55);
    const occlusionRef = useRef(occlusion);
    occlusionRef.current = occlusion;
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const mapRef = useRef<MapView>(null);
    const mapAnimatedProps = useAnimatedProps(() => ({
        scrollEnabled: !((scrollDisabledSV?.value ?? false) || (sheetOpenSV?.value ?? false)),
    }));
    const isDark = useResolvedScheme() === 'dark';
    const insets = useSafeAreaInsets();

    // react-native-maps fires the map's onPress right after a marker's onPress
    // (and even on marker taps on some platforms). Without this guard, tapping a
    // pin would open the sheet and then the map-press would instantly close it —
    // which read as "tapping a pin does nothing". Record the last marker tap and
    // swallow any map-press within a short window of it.
    const markerPressRef = useRef(0);
    // The map's native gesture, exposed to RNGH so the dock's pan can block it.
    const mapNativeGesture = useMemo(() => {
        const g = Gesture.Native();
        return nativeGestureRef ? g.withRef(nativeGestureRef) : g;
    }, [nativeGestureRef]);
    const markMarkerPress = useCallback(() => { markerPressRef.current = Date.now(); }, []);
    const handleStoreTap = useCallback((id: number) => { markMarkerPress(); onSelectStore(id); }, [markMarkerPress, onSelectStore]);
    const handleDirTap = useCallback((id: number) => { markMarkerPress(); onLazyPrice?.(id); }, [markMarkerPress, onLazyPrice]);
    // handleMapPress lives further down (after the overlay-pill plumbing): on
    // iOS it hit-tests the tap against the projected pills first.

    useEffect(() => { preloadLogos(); }, []);

    // Warm the scrollEnabled binding once the NATIVE map exists (onMapReady).
    // Reanimated only writes a useAnimatedProps value to a third-party native
    // component (MapView) on the first CHANGE, and a change requested before the
    // native view exists is dropped — so the initial `scrollEnabled` never
    // reaches the map, and the FIRST dock drag pans it (every drag after is fine,
    // the binding is now live). Toggling here forces that first native write.
    const warmScroll = useCallback(() => {
        if (!scrollDisabledSV) return;
        scrollDisabledSV.value = true;
        // Two frames so the first native write (scrollEnabled=false) commits
        // before we restore it — the map has just become ready and the user
        // isn't dragging yet, so the brief disable is invisible.
        requestAnimationFrame(() => requestAnimationFrame(() => { scrollDisabledSV.value = false; }));
    }, [scrollDisabledSV]);

    const anySelected = useMemo(() => pins.some(p => p.active), [pins]);

    // A contiguous zIndex rank per pin so each pin's logo + pill stack as ONE
    // unit (no logo leaking over a neighbouring pin's pill). Higher rank = on
    // top: selected first, then cheapest, then southern pins (lower latitude).
    const zRankMap = useMemo(() => {
        const order = [...pins].sort((a, b) => {
            if (a.active !== b.active) return a.active ? 1 : -1;
            if (a.recommended !== b.recommended) return a.recommended ? 1 : -1;
            return b.latitude - a.latitude;
        });
        const m = new Map<number, number>();
        order.forEach((p, i) => m.set(p.storeId, i + 1));
        return m;
    }, [pins]);

    // Render order = z order. react-native-maps ignores `zIndex` re-ordering on
    // Android (marker insertion order wins), so we render pins from lowest to
    // highest zRank → active/selected pins render LAST and always sit on top
    // (fixes a 2nd selected store hiding behind a neutral pin, and a re-selected
    // store rendering below its former combo partner).
    //
    // iOS: the list must be STABLE instead (sorted by storeId, which never changes).
    // Selecting a store / switching the 1-store↔2-store option re-ranks EVERY pin,
    // and a re-sorted array + rank-bearing keys remounts the whole marker set in one
    // batch — under the Fabric interop layer that insert/remove storm is what threw
    // AIRMap's NSRangeException (silent crash, basket map 2026-07-05). iOS honours
    // the zIndex prop, so stacking survives without reordering, and the natural-size
    // decode patch (react-native-maps+1.20.1.patch) makes in-place image swaps safe.
    const pinsByZ = useMemo(
        () => Platform.OS === 'ios'
            ? [...pins].sort((a, b) => a.storeId - b.storeId)
            : [...pins].sort((a, b) => (zRankMap.get(a.storeId) ?? 0) - (zRankMap.get(b.storeId) ?? 0)),
        [pins, zRankMap],
    );

    // Bake each priced pin's (logo + price) pill off-screen → never-clipped native marker images.
    const pillSpecs = useMemo(
        () => pinsByZ.map(specForPin).filter((s): s is MapPillSpec => s != null),
        [pinsByZ],
    );
    const { sizeFor, images, bakery } = useBakedPills(pillSpecs);
    // storeId → last successfully baked pill (uri + dp size, kept TOGETHER so the
    // iOS child-image marker never renders a uri without its bounds). Shown while
    // a variant change re-bakes, so a pin never swaps down to the bare badge —
    // that pill↔badge child churn also hammered the marker's native insert path.
    const lastPillUriRef = useRef(new Map<number, { uri: string; w: number; h: number }>());

    const allCoords = useMemo(() => {
        const c: LatLng[] = pins.map(p => ({ latitude: p.latitude, longitude: p.longitude }));
        if (routeEndpoints) { c.push(routeEndpoints.from, routeEndpoints.to); }
        else if (userCoords) c.push({ latitude: userCoords.lat, longitude: userCoords.lng });
        return c;
    }, [pins, userCoords, routeEndpoints]);
    const allCoordsRef = useRef(allCoords);
    allCoordsRef.current = allCoords;

    const initialRegion = useMemo(() => {
        const c = allCoords;
        if (c.length === 0) return { latitude: 54.6872, longitude: 25.2797, latitudeDelta: 0.1, longitudeDelta: 0.1 };
        const lats = c.map(p => p.latitude), lngs = c.map(p => p.longitude);
        const minLat = Math.min(...lats), maxLat = Math.max(...lats);
        const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
        return {
            latitude: (minLat + maxLat) / 2,
            longitude: (minLng + maxLng) / 2,
            latitudeDelta: Math.max((maxLat - minLat) * 1.6, 0.02),
            longitudeDelta: Math.max((maxLng - minLng) * 1.6, 0.02),
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Current map region drives the directory grid clustering. Seeded from the
    // initial fit; updated when the user pans/zooms (after the gesture settles).
    const [region, setRegion] = useState<GridRegion>(initialRegion);

    // iOS pill overlay plumbing: the LIVE region (onRegionChange fires
    // continuously during gestures) + the map's px size, as shared values so
    // the overlay pills reposition on the UI thread with no React re-render.
    const liveRegion = useSharedValue<Region>(initialRegion as Region);
    const mapW = useSharedValue(0);
    const mapH = useSharedValue(0);
    // iOS: besides feeding the overlay's projection, the continuous region
    // stream ALSO re-buckets the directory clusters LIVE — so splits/merges
    // happen mid-pinch, without releasing the fingers. The grid is level-
    // quantized (see mapClustering), so a mid-gesture commit can only matter
    // when the BUCKETING REGIME changes (zoom level or the singles threshold
    // crossed) — gate on exactly that. Pans and within-level zooms commit
    // NOTHING (the viewport margin covers edges; the settle finalises), so
    // gestures stay pure shared-value writes.
    const lastBucketKeyRef = useRef('');
    const lastCommitCenterRef = useRef({ lat: 0, lng: 0 });
    const lastPanCommitAtRef = useRef(0);

    // NOTE (tried & reverted): feeding `liveRegion` from a Reanimated event
    // worklet (native `onChange` intercepted in C++ before the JS thread)
    // made EVERYTHING jitter even on idle drags — the per-raw-event synchronous
    // flush applies overlay props out of phase with the display-link-aligned
    // mapper pass, and it raced the JS fallback writer. The JS-fed write below
    // is frame-batched and demonstrably glued whenever JS is responsive; the
    // fix for congestion is to keep JS idle (Skia directory layer), not to
    // change the feed.
    const onRegionLive = useCallback((r: Region) => {
        liveRegion.value = r;
        const key = bucketingKey(r.longitudeDelta);
        const c = lastCommitCenterRef.current;
        // PAN commit: the centre moved a quarter-viewport since the last
        // commit → newly revealed edges need their dots mounted mid-drag
        // (holes used to persist until settle). Cheap now: the isolated
        // DirectoryLayer + per-dot memoization mean only entering/leaving
        // dots do any work. Throttled so flings don't spam commits.
        const now = Date.now();
        const panned =
            Math.abs(r.latitude - c.lat) > r.latitudeDelta * 0.25 ||
            Math.abs(r.longitude - c.lng) > r.longitudeDelta * 0.25;
        if (key !== lastBucketKeyRef.current || (panned && now - lastPanCommitAtRef.current > 250)) {
            lastBucketKeyRef.current = key;
            lastCommitCenterRef.current = { lat: r.latitude, lng: r.longitude };
            lastPanCommitAtRef.current = now;
            // Feed the DirectoryLayer's OWN region state (registered setter) —
            // only that small subtree re-renders, never this component.
            dirRegionSetterRef.current?.(r, true);
        }
    }, [liveRegion]);
    // Baked price-pill images, produced off-screen by the shared MapPill baker.

    // Directory layer: every un-priced store, bucketed into clusters/singles for
    // the current zoom. Priced stores are excluded (they render as pills).
    const directoryPts = useMemo(() => {
        if (!directory || directory.length === 0) return [];
        return directory
            .filter(s =>
                Number.isFinite(s.latitude) && Number.isFinite(s.longitude) &&
                !(pricedStoreIds?.has(s.id)))
            .map(s => ({ ...s, id: s.id, latitude: s.latitude, longitude: s.longitude }));
    }, [directory, pricedStoreIds]);

    // ANDROID ONLY: the parent-level clustering feeds the native markers. On
    // iOS the DirectoryLayer child owns its own region + clustering, so the
    // parent never re-renders on region changes (the zoom-stutter fix).
    const { clusters, singles } = useMemo(
        () => Platform.OS === 'ios' ? { clusters: [] as Cluster[], singles: [] as typeof directoryPts } : clusterByGrid(directoryPts, region),
        [directoryPts, region],
    );

    // ANDROID ONLY: cluster count bubbles baked to images for native markers.
    // iOS renders clusters as plain overlay Views — no bake needed there.
    // Keyed by VISUAL identity (count + size), NOT the grid cell id: cell ids
    // change on every re-bucket, so id-keyed specs re-baked every bubble on
    // every zoom/pan settle (throttled 4 at a time — the "bubbles take ages
    // to appear" lag). A "7" bubble is the same PNG wherever it sits — bake
    // each distinct count once per session and reuse it.
    const clusterVisualKey = (count: number) => `n${count}${count >= 25 ? 'B' : ''}`;
    const clusterSpecs = useMemo<MapClusterSpec[]>(() => {
        if (Platform.OS === 'ios') return [];
        const seen = new Set<string>();
        const specs: MapClusterSpec[] = [];
        for (const c of clusters) {
            const key = clusterVisualKey(c.count);
            if (seen.has(key)) continue;
            seen.add(key);
            specs.push({ key, count: c.count, big: c.count >= 25 });
        }
        return specs;
    }, [clusters]);
    const { uriFor: clusterUriFor, bakery: clusterBakery } = useBakedClusters(clusterSpecs);

    // The iOS DirectoryLayer registers its region setter here — the map's
    // region callbacks feed it directly, bypassing the parent's state. The
    // `live` flag tells the layer whether the commit happened MID-GESTURE
    // (targets snap — dots stay coupled to the pinch) or at SETTLE (targets
    // glide smoothly into their final arrangement).
    const dirRegionSetterRef = useRef<((r: GridRegion, live: boolean) => void) | null>(null);
    const registerDirRegionSetter = useCallback((fn: (r: GridRegion, live: boolean) => void) => { dirRegionSetterRef.current = fn; }, []);

    const onRegionSettle = useCallback((r: GridRegion) => {
        lastBucketKeyRef.current = bucketingKey(r.longitudeDelta);
        lastCommitCenterRef.current = { lat: r.latitude, lng: r.longitude };
        if (Platform.OS === 'ios') dirRegionSetterRef.current?.(r, false);
        else setRegion(r);
    }, []);

    // ANDROID ONLY: report the nearest un-priced stores in view (iOS reports
    // from inside DirectoryLayer).
    const lastUnpricedRef = useRef('');
    useEffect(() => {
        if (Platform.OS === 'ios' || !onVisibleUnpricedChange) return;
        const cx = region.latitude, cy = region.longitude;
        const nearest = [...singles]
            .sort((a, b) =>
                ((a.latitude - cx) ** 2 + (a.longitude - cy) ** 2) -
                ((b.latitude - cx) ** 2 + (b.longitude - cy) ** 2))
            .slice(0, 10)
            .map(s => s.id);
        const key = nearest.join(',');
        if (key !== lastUnpricedRef.current) {
            lastUnpricedRef.current = key;
            onVisibleUnpricedChange(nearest);
        }
    }, [singles, region, onVisibleUnpricedChange]);

    // Tap a cluster → zoom one step into it (thirds the visible span, recentred).
    // Deltas come from the LIVE region on iOS (the parent's region state is
    // static there — the DirectoryLayer owns clustering).
    const onClusterPress = useCallback((c: Cluster) => {
        markMarkerPress();
        const cur = Platform.OS === 'ios' ? liveRegion.value : region;
        mapRef.current?.animateToRegion({
            latitude: c.latitude,
            longitude: c.longitude,
            latitudeDelta: Math.max(cur.latitudeDelta / 3, 0.01),
            longitudeDelta: Math.max(cur.longitudeDelta / 3, 0.01),
        }, 350);
    }, [region, liveRegion, markMarkerPress]);

    // Bottom edge-padding for fits = the sheet occlusion (plus a base margin so
    // content clears the very bottom when nothing's covering).
    const fitBottomPad = () => Math.max(occlusionRef.current + 24, 90);
    // Centering a single point: shift the camera south by half the occlusion so
    // the point lands in the centre of the VISIBLE area above the sheet.
    const centerOn = useCallback((lat: number, lng: number, delta: number) => {
        const off = (occlusionRef.current / 2) * (delta / SCREEN_H);
        mapRef.current?.animateToRegion(
            { latitude: lat - off, longitude: lng, latitudeDelta: delta, longitudeDelta: delta },
            350,
        );
    }, []);

    const fitAll = useCallback(() => {
        if (allCoordsRef.current.length === 0) return;
        mapRef.current?.fitToCoordinates(allCoordsRef.current, {
            edgePadding: { top: 100, right: 80, bottom: fitBottomPad(), left: 80 },
            animated: true,
        });
    }, []);

    // Default view when nothing is selected: the whole AREA (every pin). Open —
    // and any deselect — always lands on the overview, never zoomed into one
    // store; nothing about a prior tap survives, so a fresh open shows the area.
    const centerDefault = useCallback(() => { fitAll(); }, [fitAll]);

    const goToUser = useCallback(() => {
        if (!userCoords) return;
        centerOn(userCoords.lat, userCoords.lng, 0.02);
    }, [userCoords, centerOn]);

    const allKey = useMemo(() => allCoords.map(c => `${c.latitude},${c.longitude}`).join('|'), [allCoords]);
    const focusKey = useMemo(
        () => (focusCoords && focusCoords.length ? focusCoords.map(c => `${c.latitude},${c.longitude}`).join('|') : 'all'),
        [focusCoords],
    );
    useEffect(() => {
        const t = setTimeout(() => {
            if (focusCoords && focusCoords.length === 1) {
                centerOn(focusCoords[0].latitude, focusCoords[0].longitude, 0.0075);
            } else if (focusCoords && focusCoords.length > 1) {
                mapRef.current?.fitToCoordinates(focusCoords, {
                    edgePadding: { top: 110, right: 90, bottom: Math.max(occlusion + 24, 90), left: 90 },
                    animated: true,
                });
            } else {
                centerDefault();
            }
        }, 60);
        return () => clearTimeout(t);
        // `occlusion` in deps → re-frame when the sheet moves to a new stage.
    }, [focusKey, allKey, focusCoords, centerDefault, centerOn, occlusion]);

    // ── iOS overlay pills + tap routing ──────────────────────────────────────
    // MEMOIZED on `images` (stable state identity — changes only when a bake
    // lands), so the pill array keeps its identity across the frequent
    // recluster re-renders and the memoized MapPillOverlay subtree skips
    // reconciliation entirely. A ref hands the CURRENT set to handleMapPress.
    const overlayPills = useMemo<OverlayPillSpec[]>(() => Platform.OS === 'ios' ? pinsByZ.flatMap<OverlayPillSpec>(pin => {
        const spec = specForPin(pin);
        const zRank = zRankMap.get(pin.storeId) ?? 0;
        const fresh = spec ? images[spec.key] : undefined;
        // While a variant change re-bakes, keep showing the LAST baked
        // pill (uri AND size together) instead of flashing the badge.
        if (fresh) lastPillUriRef.current.set(pin.storeId, { uri: fresh.uri, w: fresh.w, h: fresh.h });
        const shown = fresh ?? lastPillUriRef.current.get(pin.storeId);
        const badge = chainBadgeImage(pin.chainId);
        const source = shown ? { uri: shown.uri } : badge;
        if (source == null) return [];
        return [{
            id: pin.storeId,
            latitude: pin.latitude,
            longitude: pin.longitude,
            source,
            sourceKey: shown ? shown.uri : 'badge',
            w: shown?.w ?? 30,
            h: shown?.h ?? 30,
            isPill: shown != null,
            dimmed: anySelected && !pin.active,
            z: zRank * 2,
            onPress: () => handleStoreTap(pin.storeId),
            debugId: `${pin.storeId}/c${pin.chainId}`,
        }];
    }) : [], [pinsByZ, zRankMap, images, anySelected, handleStoreTap]);
    const overlayPillsRef = useRef(overlayPills);
    overlayPillsRef.current = overlayPills;

    // Directory hit-test data — the iOS DirectoryLayer writes the CURRENT
    // clusters/singles here for handleMapPress (its clustering lives in the
    // child, isolated from this component's renders).
    const dirHitRef = useRef<DirHitData>({ clusters: [], singles: [] });

    // Map press: on iOS, hit-test the tap against the projected pills FIRST
    // (the overlay itself takes no touches, so pans starting on a pill move
    // the map). Topmost pill (highest z) wins; otherwise the press falls
    // through to the usual deselect behaviour.
    const handleMapPress = useCallback((e?: { nativeEvent?: { position?: { x: number; y: number } } }) => {
        if (Platform.OS === 'ios') {
            const pos = e?.nativeEvent?.position;
            const W = mapW.value;
            const H = mapH.value;
            if (pos && W > 0 && H > 0) {
                const r = liveRegion.value;
                const SLOP = 8;
                const hit = (lat: number, lng: number, w: number, h: number, isPill: boolean) => {
                    const rect = projectPillRect({ latitude: lat, longitude: lng, w, h, isPill }, r, W, H);
                    return pos.x >= rect.left - SLOP && pos.x <= rect.left + rect.w + SLOP &&
                        pos.y >= rect.top - SLOP && pos.y <= rect.top + rect.h + SLOP;
                };
                // Priority: priced pills (topmost first) → directory singles → clusters.
                const byTop = [...overlayPillsRef.current].sort((a, b) => b.z - a.z);
                for (const p of byTop) {
                    if (hit(p.latitude, p.longitude, p.w, p.h, p.isPill)) {
                        p.onPress();
                        return;
                    }
                }
                for (const s of dirHitRef.current.singles) {
                    if (hit(s.latitude, s.longitude, 36, 36, false)) {
                        handleDirTap(s.id);
                        return;
                    }
                }
                for (const c of dirHitRef.current.clusters) {
                    const { w: cw, h: chh } = clusterBubbleSize(c.count);
                    if (hit(c.latitude, c.longitude, cw, chh, false)) {
                        onClusterPress(c);
                        return;
                    }
                }
            }
        }
        if (Date.now() - markerPressRef.current < 350) return;
        onMapPress?.();
    }, [onMapPress, liveRegion, mapW, mapH, handleDirTap, onClusterPress]);

    return (
        <View style={StyleSheet.absoluteFill}>
            <GestureDetector gesture={mapNativeGesture}>
            <AnimatedMapView
                ref={mapRef}
                animatedProps={mapAnimatedProps}
                style={StyleSheet.absoluteFill}
                initialRegion={initialRegion}
                onMapReady={() => { centerDefault(); warmScroll(); }}
                onPress={handleMapPress}
                onLayout={(e) => { mapW.value = e.nativeEvent.layout.width; mapH.value = e.nativeEvent.layout.height; }}
                onRegionChange={Platform.OS === 'ios' ? onRegionLive : undefined}
                onRegionChangeComplete={onRegionSettle}
                customMapStyle={isDark ? DARK_MAP_STYLE : undefined}
                zoomEnabled={gesturesEnabled}
                rotateEnabled={false}
                pitchEnabled={false}
                toolbarEnabled={false}
                moveOnMarkerPress={false}
                showsCompass={false}
                showsMyLocationButton={false}
                showsUserLocation={true}
            >
                {/* Split-combo route line (user → stops), under the markers. */}
                {routeCoords && routeCoords.length >= 2 && (
                    <Polyline
                        coordinates={routeCoords}
                        strokeColor={colors.primary}
                        strokeWidth={4}
                        lineDashPattern={[2, 8]}
                        lineCap="round"
                    />
                )}
                {/* Directory layer (un-priced) — ANDROID native markers only;
                    iOS renders it in the projected overlay (see below). */}
                {Platform.OS !== 'ios' && clusters.map(c => (
                    <MapClusterMarker
                        key={`c-${c.id}`}
                        coordinate={{ latitude: c.latitude, longitude: c.longitude }}
                        pillUri={clusterUriFor(clusterVisualKey(c.count))}
                        zIndex={1}
                        onPress={() => onClusterPress(c)}
                    />
                ))}
                {Platform.OS !== 'ios' && singles.map(s => (
                    <DirectoryPin
                        key={`d-${s.id}`}
                        store={s}
                        styles={styles}
                        pricing={pricingStoreId === s.id}
                        onPress={handleDirTap}
                    />
                ))}
                {/* Route mode → start/end endpoint markers as NATIVE pin markers (custom-View
                    child markers don't render on Android with react-native-maps on the new arch,
                    even at 1.20.x). The user's own location is the native blue dot
                    (showsUserLocation above) — not a custom marker. */}
                {routeEndpoints && (
                    <>
                        <Marker coordinate={routeEndpoints.from} pinColor={colors.primary} zIndex={5} />
                        <Marker coordinate={routeEndpoints.to} pinColor={colors.primary} zIndex={5} />
                    </>
                )}
                {/* ANDROID ONLY: native image-prop pill markers (Google Maps renders +
                    stacks them correctly; remount keys are safe there). iOS pills render
                    in the PROJECTED OVERLAY below the map — instrumented runs proved the
                    legacy AIRMapMarker under the Fabric interop drops child-image updates
                    and ignores zPosition, so native markers can't carry the pills on iOS. */}
                {Platform.OS !== 'ios' && pinsByZ.map(pin => {
                    const spec = specForPin(pin);
                    const zRank = zRankMap.get(pin.storeId) ?? 0;
                    const fresh = spec ? sizeFor(spec.key) : undefined; // {uri,w,h} baked together
                    const uri = fresh?.uri;
                    return (
                        <MapPillMarker
                            // Remount on z-rank / baked-image change — insertion order is the
                            // only stacking control on Android, and in-place image swaps
                            // rasterise unreliably (see MapPill notes).
                            key={`${pin.storeId}-${zRank}-${spec ? spec.key : 'np'}-${uri ? 'p' : 'b'}`}
                            coordinate={{ latitude: pin.latitude, longitude: pin.longitude }}
                            chainId={pin.chainId}
                            pillUri={uri}
                            pillSize={fresh ? { w: fresh.w, h: fresh.h } : undefined}
                            dimmed={anySelected && !pin.active}
                            zIndex={zRank * 2}
                            anchorBaked={{ x: 0.16, y: 0.5 }}
                            onPress={() => handleStoreTap(pin.storeId)}
                        />
                    );
                })}
            </AnimatedMapView>
            </GestureDetector>

            {/* iOS: directory (cluster bubbles + un-priced logos) as a projected
                overlay — plain RN views, so the zoom re-bucketing churn never
                touches the native marker system (the nil-insert crash surface).
                Rendered BELOW the pills overlay; owns its own region state so
                live reclustering re-renders only its small subtree. */}
            {Platform.OS === 'ios' && (
                <DirectoryLayer
                    directoryPts={directoryPts}
                    initialRegion={initialRegion}
                    registerRegionSetter={registerDirRegionSetter}
                    liveRegion={liveRegion}
                    mapW={mapW}
                    mapH={mapH}
                    cardBackground={colors.cardBackground}
                    primary={colors.primary}
                    pricingStoreId={pricingStoreId}
                    onVisibleUnpricedChange={onVisibleUnpricedChange}
                    hitRef={dirHitRef}
                />
            )}
            {/* iOS: the pills as a PROJECTED REACT OVERLAY — plain views above the map,
                positioned by Mercator math from the live region. The layer takes NO
                touches (pans starting on a pill move the MAP); taps arrive via the
                map's onPress and are routed by the hit-test in handleMapPress. */}
            {Platform.OS === 'ios' && (
                <MapPillOverlay
                    pills={overlayPills}
                    region={liveRegion}
                    mapW={mapW}
                    mapH={mapH}
                />
            )}

            {/* OFF-SCREEN price-pill bakery (shared MapPill baker) — snapshots each priced pin's
                (logo + price) row to an image the marker can use natively. */}
            {bakery}
            {clusterBakery}

            {/* Floating controls — top-right, clear of the status bar. */}
            {/* Same liquid-glass treatment as the store-count switcher up top
                (LiquidGlass, solid fallback = the previous look on Android/old iOS). */}
            <View style={[styles.controls, { top: insets.top + spacing.md }]} pointerEvents="box-none">
                <TouchableOpacity onPress={fitAll} activeOpacity={0.8}>
                    <LiquidGlass style={styles.ctrlBtn} fallback="solid">
                        <Ionicons name="scan-outline" size={iconSize.md} color={colors.textPrimary} />
                    </LiquidGlass>
                </TouchableOpacity>
                {userCoords && (
                    <TouchableOpacity onPress={goToUser} activeOpacity={0.8}>
                        <LiquidGlass style={styles.ctrlBtn} fallback="solid">
                            <Ionicons name="locate" size={iconSize.md} color={colors.primary} />
                        </LiquidGlass>
                    </TouchableOpacity>
                )}
            </View>
        </View>
    );
}

// Memoized: the results screen re-renders on sheet drags/selection churn with
// mostly-stable map props — shallow-equal skips re-walking this whole tree.
export default React.memo(StoreResultsMap);

const makeStyles = (c: AppTheme) => StyleSheet.create({
    dim: { opacity: 0.4 },

    // iOS un-priced directory pin: bigger logo + transparent padding so it's
    // easy to see and gives a comfortable tap target.
    dirHit: { padding: 6, alignItems: 'center', justifyContent: 'center' },
    dirLogo: { width: 36, height: 36 },

    // Fallback badge for a chain with no bundled logo asset.
    fallbackChip: {
        width: 30, height: 30, borderRadius: 15,
        alignItems: 'center', justifyContent: 'center',
        borderWidth: 2, borderColor: '#FFFFFF',
    },
    fallbackText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },

    // User location — solid, white-ringed, with a visible accuracy halo
    // (Google-style) so it reads clearly on the dark map too.
    userDotRing: {
        width: 28, height: 28, borderRadius: 14,
        backgroundColor: 'rgba(26,115,232,0.30)',
        alignItems: 'center', justifyContent: 'center',
    },
    userDot: {
        width: 16, height: 16, borderRadius: 8,
        backgroundColor: '#1A73E8', borderWidth: 3, borderColor: '#FFFFFF',
        elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.3, shadowRadius: 2,
    },
    // Route-mode trip endpoints (start = success/green, end = primary/pink).
    endpointDot: {
        width: 18, height: 18, borderRadius: 9, borderWidth: 3, borderColor: '#FFFFFF',
        elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.3, shadowRadius: 2,
    },

    // Directory cluster bubble — neutral surface, pink ring + count.
    cluster: {
        minWidth: 36, height: 36, paddingHorizontal: 8, borderRadius: 18,
        backgroundColor: c.cardBackground, borderWidth: 2, borderColor: c.primary,
        alignItems: 'center', justifyContent: 'center',
        elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.25, shadowRadius: 2,
    },
    clusterBig: { minWidth: 46, height: 46, borderRadius: 23 },
    clusterText: { fontSize: 13, fontWeight: '800', color: c.primary },

    controls: { position: 'absolute', right: spacing.md, gap: spacing.sm },
    ctrlBtn: {
        width: 42, height: 42, borderRadius: radius.pill,
        backgroundColor: c.cardBackground,
        alignItems: 'center', justifyContent: 'center',
        ...elevation.level2,
        borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    },
});
