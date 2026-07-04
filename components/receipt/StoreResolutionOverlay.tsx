import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import MapView, { type Region } from 'react-native-maps';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../constants/theme';
import { GlassIconButton } from '../GlassIconButton';
import { MapPickerScaffold } from '../map/MapPickerScaffold';
import {
    useBakedPills, useBakedClusters, MapPillMarker, MapClusterMarker,
    type MapPillSpec, type MapClusterSpec,
} from '../map/MapPill';
import { chainBadgeImage } from '../../utils/chainLogoAssets';
import { geocodeAddress } from '../../utils/nominatim';
import { tryGpsCoords, VILNIUS_FALLBACK } from '../../utils/location';
import { getStoreResolutionRequest, completeStoreResolution } from '../../utils/storeResolution';
import { clusterByGrid, type Cluster, type GridRegion } from '../../utils/mapClustering';
import { API_BASE_URL } from '../../config/api';

interface ChainStore {
    id: number;
    name: string;
    address: string;
    latitude: number;
    longitude: number;
}

const DELTA = 0.05;
const CLOSE_DELTA = 0.008;


// Pill label = STREET + NUMBER only. Store addresses are "Gatvė g. 12-3, Miestas" — drop the
// trailing city segment(s); keep everything before the last comma. (User: "only street and numbers,
// no need for city.")
const streetOnly = (address: string | null | undefined): string => {
    const a = (address ?? '').trim();
    if (!a) return '';
    const parts = a.split(',');
    return (parts.length > 1 ? parts.slice(0, -1).join(',') : a).trim();
};

// Two-row address pill: STREET on top, house-number(-flat) below. Split the
// city-less address at its trailing number token ("Lyros g. 19A-1" → ["Lyros g.",
// "19A-1"]); fall back to a single street row when there's no parseable number.
const addrLines = (address: string | null | undefined): string[] => {
    const s = streetOnly(address);
    if (!s) return ['—'];
    const m = s.match(/^(.*?)[,\s]+(\d[\w./-]*)\s*$/);
    return m && m[1].trim() ? [m[1].trim(), m[2].trim()] : [s];
};

// Cluster bake identity — re-bakes when the count (or big threshold) changes.
const clusterKey = (c: Cluster): string => `c-${c.id}-${c.count}`;

// STABLE cluster identity for the React marker key: the smallest store id in the
// bucket. Unique per render (buckets partition the stores) and survives zoom, unlike
// the grid-cell id (cell size scales with longitudeDelta, so cell keys change on any
// zoom). Keying markers by cell+count remounted every bubble on each region settle —
// and those remove+insert storms are what hit the iOS AIRMap interop crash
// (NSRangeException in insertReactSubview, crash log 2026-07-04; the native clamp
// patch in patches/react-native-maps is the belt to this suspender).
const clusterStableId = (c: Cluster): number => Math.min(...c.pointIds);

/**
 * Recoverable `store_unrecognized` fallback, as an in-flow MODAL overlay (was the
 * separate `/receipt/store-resolution` route). The chain is known (logo shown, fixed)
 * but the store wasn't matched. The user searches/zooms the map and taps one of the
 * chain's stores; Confirm (or close/dismiss) hands the result back to the awaiting receipt
 * pipeline via the storeResolution handoff (`completeStoreResolution`, which is idempotent).
 *
 * Store markers use the SAME logic as the results price map: clustered into count bubbles when
 * zoomed out, resolving into individual ADDRESS pills (street + number) as the user zooms in.
 */
export function StoreResolutionOverlay() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const mapRef = useRef<MapView>(null);

    const req = useMemo(() => getStoreResolutionRequest(), []);
    const [stores, setStores] = useState<ChainStore[]>([]);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [searchText, setSearchText] = useState(req?.ocrAddress ?? '');
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    // Gates the white-map cover + the off-screen bake burst until the native map's first
    // paint, so map init / Modal slide / view-shot captures don't all contend at once.
    const [mapReady, setMapReady] = useState(false);
    // Gates ALL markers until the opening animateToRegion has settled. Mounting them for
    // the initial (Vilnius) region and then re-clustering for the geocoded target swapped
    // the whole marker set in one mount transaction — on iOS that remove+insert batch hits
    // the unpatched AIRMap interop index crash the moment the map opens (2nd .ips,
    // 2026-07-04; the react-native-maps patch closes it natively on the next build).
    // Until `centered`, the map shows bare tiles — the first marker mount is then a single
    // clean set computed for the FINAL viewport.
    const [centered, setCentered] = useState(false);
    const centerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const initialRegion: Region = {
        latitude: VILNIUS_FALLBACK.lat,
        longitude: VILNIUS_FALLBACK.lng,
        latitudeDelta: DELTA,
        longitudeDelta: DELTA,
    };
    // Current map viewport drives the grid clustering (handful of bubbles when zoomed out →
    // individual pills as the user zooms into a city). Seeded from the initial fit, updated when
    // the gesture settles.
    const [region, setRegion] = useState<GridRegion>(initialRegion);

    // Fetch the chain's stores + centre the map on the OCR address (else GPS/Vilnius).
    useEffect(() => {
        if (!req) { completeStoreResolution(null); return; }
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`${API_BASE_URL}/api/stores/chain/${req.chainId}`);
                const data = await res.json();
                if (cancelled) return;
                const parsed: ChainStore[] = (Array.isArray(data) ? data : [])
                    .map((s: any) => ({
                        id: s.id,
                        name: s.name,
                        address: s.address,
                        latitude: parseFloat(s.latitude),
                        longitude: parseFloat(s.longitude),
                    }))
                    .filter((s: ChainStore) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude));
                setStores(parsed);
            } catch { /* leave empty — the map still works for search */ }
        })();
        (async () => {
            let center: { lat: number; lng: number } | null = null;
            let geocoded = false;
            if (req.ocrAddress) { center = await geocodeAddress(req.ocrAddress); geocoded = !!center; }
            if (!center) center = await tryGpsCoords();
            const c = center ?? VILNIUS_FALLBACK;
            const delta = geocoded ? CLOSE_DELTA : DELTA;
            if (!cancelled) {
                mapRef.current?.animateToRegion(
                    { latitude: c.lat, longitude: c.lng, latitudeDelta: delta, longitudeDelta: delta },
                    600,
                );
                // Markers stay unmounted until this centering settles (see `centered`).
                // Seed the region to the TARGET so the first mounted marker set is
                // computed for the final viewport even if onRegionChangeComplete lags.
                setRegion({ latitude: c.lat, longitude: c.lng, latitudeDelta: delta, longitudeDelta: delta });
                centerTimer.current = setTimeout(() => setCentered(true), 750);
            }
        })();
        return () => { cancelled = true; if (centerTimer.current) clearTimeout(centerTimer.current); };
    }, [req]);

    // Dismissed without confirming → cancel the handoff so the pipeline doesn't hang.
    // completeStoreResolution is idempotent, so this is a safe backstop after Confirm too.
    useEffect(() => () => { completeStoreResolution(null); }, []);

    // Reveal the map + start baking once it's painted. Fallback timer in case onMapReady
    // never fires on some device, so content can't be stuck behind the cover.
    const handleMapReady = useCallback(() => setMapReady(true), []);
    useEffect(() => {
        const t = setTimeout(() => setMapReady(true), 2500);
        // Backstop for `centered` too: a hung geocode/GPS lookup must not leave the
        // map permanently marker-less.
        const c = setTimeout(() => setCentered(true), 4000);
        return () => { clearTimeout(t); clearTimeout(c); };
    }, []);

    // Re-cluster as the viewport settles (this is what makes bubbles collapse when you
    // zoom out and resolve into address pills when you zoom in). A single animateToRegion
    // emits several onRegionChangeComplete events; ignore near-identical regions so one
    // settle triggers at most one re-cluster + re-bake (kills the zoom/typing jank). The
    // marker churn this drives is crash-safe on iOS via the AIRMap insert-clamp patch
    // (patches/react-native-maps) — needs the native build to be present.
    const handleRegionChange = useCallback((r: Region) => {
        setRegion((prev) =>
            Math.abs(r.latitude - prev.latitude) < 1e-4 &&
            Math.abs(r.longitude - prev.longitude) < 1e-4 &&
            Math.abs(r.longitudeDelta - prev.longitudeDelta) < 1e-4
                ? prev
                : r);
    }, []);

    const onSearch = useCallback(async () => {
        const q = searchText.trim();
        if (q.length < 3) { setSearchError(t('storeResolution.minChars')); return; }
        setSearching(true);
        setSearchError(null);
        const r = await geocodeAddress(q);
        setSearching(false);
        if (!r) { setSearchError(t('storeResolution.addressNotFound')); return; }
        mapRef.current?.animateToRegion(
            { latitude: r.lat, longitude: r.lng, latitudeDelta: CLOSE_DELTA, longitudeDelta: CLOSE_DELTA },
            600,
        );
    }, [searchText, t]);

    const onConfirm = useCallback(() => {
        const s = stores.find((x) => x.id === selectedId);
        if (!s) return;
        completeStoreResolution({ storeId: s.id, storeName: s.name, storeAddress: s.address });
    }, [stores, selectedId]);

    // Tap a cluster → zoom one step into it (thirds the visible span, recentred) — same gesture as
    // the results map.
    const onClusterPress = useCallback((c: Cluster) => {
        mapRef.current?.animateToRegion({
            latitude: c.latitude,
            longitude: c.longitude,
            latitudeDelta: Math.max(region.latitudeDelta / 3, 0.006),
            longitudeDelta: Math.max(region.longitudeDelta / 3, 0.006),
        }, 350);
    }, [region.latitudeDelta, region.longitudeDelta]);

    // The selected store is kept OUT of the clustering input + always drawn as its own pill, so the
    // pick stays visible even when its neighbours collapse into a bubble at a lower zoom.
    const selectedStore = useMemo(() => stores.find((s) => s.id === selectedId) ?? null, [stores, selectedId]);
    const { clusters, singles } = useMemo(
        () => clusterByGrid(stores.filter((s) => s.id !== selectedId), region),
        [stores, selectedId, region],
    );

    // Bake the visible address pills (street + number, two rows, chain logo) off-screen
    // so the markers render a never-clipped native image — same baker as the price map.
    const pillSpecs = useMemo<MapPillSpec[]>(() => {
        if (!req) return [];
        // Bake at most PILL_BAKE_CAP address pills at once — a zoomed-in search can yield
        // up to ~160 singles (clusterByGrid stops clustering), and a captureRef per pill
        // would flood native memory and crash. Beyond the cap, MapPillMarker falls back to
        // the bare chain badge (still tappable → its pill bakes once selected).
        const PILL_BAKE_CAP = 24;
        const specs: MapPillSpec[] = singles.slice(0, PILL_BAKE_CAP).map((s) => ({
            key: `${s.id}|n`, chainId: req.chainId, lines: addrLines(s.address), variant: 'neutral',
        }));
        if (selectedStore) {
            specs.push({ key: `${selectedStore.id}|s`, chainId: req.chainId, lines: addrLines(selectedStore.address), variant: 'selected' });
        }
        return specs;
    }, [singles, selectedStore, req]);
    const { uriFor, bakery } = useBakedPills(pillSpecs);

    // Bake the count bubbles too — a child-View marker clips on Android (Fabric).
    const clusterSpecs = useMemo<MapClusterSpec[]>(
        () => clusters.map((c) => ({ key: clusterKey(c), count: c.count, big: c.count >= 25 })),
        [clusters],
    );
    const { uriFor: clusterUriFor, bakery: clusterBakery } = useBakedClusters(clusterSpecs);
    // Keep the last baked image per STABLE cluster id so a re-cluster shows the previous
    // bubble instead of a blank while the new count re-bakes; chain badge is the
    // pre-first-bake fallback. Both keep the marker mounted (image swaps in place — safe +
    // correctly sized under the AIRMapMarker CGSizeZero patch) instead of flickering null.
    const lastClusterUriRef = useRef<Map<number, string>>(new Map());
    const chainBadge = req ? chainBadgeImage(req.chainId) : null;

    if (!req) return null;

    return (
        <View style={styles.root}>
            {/* Full-bleed map with floating liquid-glass chrome: the back chevron, the
                "Pick the store" title chip and the search all float over the map at the
                top; the confirm pill floats at the bottom and appears only once a store
                is tapped. No opaque header bar — the map runs edge to edge. */}
            <MapPickerScaffold
                glassChrome
                headerLeft={
                    <GlassIconButton icon="chevron-back" glass onPress={() => completeStoreResolution(null)} size={22} />
                }
                title={t('storeResolution.title')}
                mapRef={mapRef}
                initialRegion={initialRegion}
                onMapReady={handleMapReady}
                mapReady={mapReady}
                onRegionChangeComplete={handleRegionChange}
                searchText={searchText}
                onSearchTextChange={(v) => { setSearchText(v); setSearchError(null); }}
                onSearch={onSearch}
                searching={searching}
                searchError={searchError}
                searchPlaceholder={t('storeResolution.searchPlaceholder')}
                confirmLabel={t('storeResolution.confirm')}
                confirmEnabled={selectedId != null}
                onConfirm={onConfirm}
                mapChildren={
                    !centered ? null : <>
                        {/* Markers show the chain badge immediately, then swap to the baked
                            address pill in place. Two native fixes make this both correct and
                            crash-safe (present on the build with patches/react-native-maps):
                             • AIRMapMarker CGSizeZero → the badge→pill swap decodes at natural
                               size (no "tiny pills"); and
                             • AIRMap insert-clamp → the cluster↔single churn on zoom no longer
                               aborts in insertReactSubview.
                            Cluster keys use the STABLE min-store-id (not the count) so a count
                            change swaps the image in place rather than remounting. */}
                        {clusters.map((c) => {
                            const sid = clusterStableId(c);
                            const uri = clusterUriFor(clusterKey(c));
                            if (uri) lastClusterUriRef.current.set(sid, uri);
                            return (
                                <MapClusterMarker
                                    key={`c-${sid}`}
                                    coordinate={{ latitude: c.latitude, longitude: c.longitude }}
                                    pillUri={uri ?? lastClusterUriRef.current.get(sid)}
                                    fallback={chainBadge ?? undefined}
                                    zIndex={1}
                                    onPress={() => onClusterPress(c)}
                                />
                            );
                        })}
                        {singles.map((s) => (
                            <MapPillMarker
                                key={`s-${s.id}`}
                                coordinate={{ latitude: s.latitude, longitude: s.longitude }}
                                chainId={req.chainId}
                                pillUri={uriFor(`${s.id}|n`)}
                                zIndex={2}
                                onPress={() => setSelectedId(s.id)}
                            />
                        ))}
                        {selectedStore && (
                            <MapPillMarker
                                key={`sel-${selectedStore.id}`}
                                coordinate={{ latitude: selectedStore.latitude, longitude: selectedStore.longitude }}
                                chainId={req.chainId}
                                pillUri={uriFor(`${selectedStore.id}|s`)}
                                zIndex={10}
                                onPress={() => setSelectedId(selectedStore.id)}
                            />
                        )}
                    </>
                }
            />
            {/* Off-screen bakeries — must live OUTSIDE the map (normal Views, not Markers).
                Gated on mapReady so the view-shot capture burst doesn't run during map init. */}
            {mapReady && bakery}
            {mapReady && clusterBakery}
        </View>
    );
}

const makeStyles = (_c: AppTheme) =>
    StyleSheet.create({
        // Full-bleed: the map fills the whole surface; all chrome floats over it
        // (glass back chevron + title chip + search up top, confirm pill at the bottom).
        root: { flex: 1 },
    });
