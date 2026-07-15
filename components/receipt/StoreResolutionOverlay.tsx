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
import { clusterByGrid, type Cluster, type GridRegion } from '../../utils/mapClustering';
import { chainBadgeImage } from '../../utils/chainLogoAssets';
import { geocodeAddress } from '../../utils/nominatim';
import { tryGpsCoords, VILNIUS_FALLBACK } from '../../utils/location';
import { getStoreResolutionRequest, completeStoreResolution } from '../../utils/storeResolution';
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

/**
 * Recoverable `store_unrecognized` fallback, as an in-flow MODAL overlay (was the
 * separate `/receipt/store-resolution` route). The chain is known (logo shown, fixed)
 * but the store wasn't matched. The user searches/zooms the map and taps one of the
 * chain's stores; Confirm (or close/dismiss) hands the result back to the awaiting receipt
 * pipeline via the storeResolution handoff (`completeStoreResolution`, which is idempotent).
 *
 * EVERY store shows an address pill (logo + street + number). Pills are baked off-screen and
 * mounted in bake-COMPLETION order, so the on-map marker list only ever GROWS AT THE END. That
 * append-only shape is what keeps it crash-free on a build WITHOUT the react-native-maps patch:
 * the AIRMap insertReactSubview crash fires on a mid-list insert into a churning set, and a
 * mount-at-the-end never produces one; mounting each marker already holding its pill also avoids
 * the badge→pill in-place swap ("rectangle"). Search only moves the camera. No clustering (dense
 * areas overlap) — that needs the committed patch, which lands on the next build.
 */
export function StoreResolutionOverlay({ onCancel }: {
    /** Called after a back/cancel resolves the handoff with null — lets the
     *  host navigate away instead of stranding the user on an empty screen. */
    onCancel?: () => void;
} = {}) {
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
    // Current viewport drives the grid clustering — seeded from the initial fit,
    // updated when the camera settles. The react-native-maps insert-index clamp
    // (now in the rebuilt client) makes the mid-list marker inserts that
    // clustering produces on zoom/pan crash-safe.
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
                // Markers stay unmounted until this centering settles (see `centered`), so the
                // first (and only) mount is one clean batch — all stores, then never changed.
                centerTimer.current = setTimeout(() => setCentered(true), 750);
            }
        })();
        return () => { cancelled = true; if (centerTimer.current) clearTimeout(centerTimer.current); };
    }, [req]);

    // Auto-dismiss the search error after a few seconds so it never lingers over the UI.
    useEffect(() => {
        if (!searchError) return;
        const to = setTimeout(() => setSearchError(null), 3500);
        return () => clearTimeout(to);
    }, [searchError]);

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

    // Re-cluster when the camera settles; ignore sub-1e-4 drift so an idle map
    // (or an animation's tail) doesn't churn the marker set.
    const handleRegionChange = useCallback((r: Region) => {
        setRegion((prev) =>
            Math.abs(prev.latitude - r.latitude) < 1e-4 &&
            Math.abs(prev.longitude - r.longitude) < 1e-4 &&
            Math.abs(prev.latitudeDelta - r.latitudeDelta) < 1e-4
                ? prev
                : r);
    }, []);

    // Zoom one step into a tapped cluster (thirds the visible span, recentred).
    const onClusterPress = useCallback((c: Cluster) => {
        mapRef.current?.animateToRegion({
            latitude: c.latitude,
            longitude: c.longitude,
            latitudeDelta: Math.max(region.latitudeDelta / 3, 0.006),
            longitudeDelta: Math.max(region.longitudeDelta / 3, 0.006),
        }, 350);
    }, [region.latitudeDelta, region.longitudeDelta]);

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

    const selectedStore = useMemo(() => stores.find((s) => s.id === selectedId) ?? null, [stores, selectedId]);

    // Grid-cluster the stores for the current viewport: dense areas collapse to a
    // count bubble when zoomed out and resolve into individual address pills as the
    // user zooms in (clusterByGrid stops clustering below its city-district delta).
    const { clusters, singles } = useMemo(() => {
        const points = stores
            .filter((s) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude))
            .map((s) => ({ ...s, id: s.id, latitude: s.latitude, longitude: s.longitude }));
        return clusterByGrid(points, region);
    }, [stores, region]);

    // Bake an ADDRESS PILL (logo + street + number) for each VISIBLE single, plus a
    // 'selected' variant for the pick; and a count bubble for each cluster.
    const pillSpecs = useMemo<MapPillSpec[]>(() => {
        if (!req) return [];
        const specs: MapPillSpec[] = singles.map((s) => ({
            key: `${s.id}|n`, chainId: req.chainId, lines: addrLines(s.address), variant: 'neutral',
        }));
        if (selectedStore) {
            specs.push({ key: `${selectedStore.id}|s`, chainId: req.chainId, lines: addrLines(selectedStore.address), variant: 'selected' });
        }
        return specs;
    }, [singles, selectedStore, req]);
    const { uriFor, sizeFor, bakery } = useBakedPills(pillSpecs);

    const clusterSpecs = useMemo<MapClusterSpec[]>(
        () => clusters.map((c) => ({ key: c.id, count: c.count, big: c.count >= 20 })),
        [clusters],
    );
    // Camera-settle key: bumping it re-tracks every marker briefly so iOS
    // repaints annotation views AIRMap re-created during the zoom (they
    // otherwise stay blank — the "pill disappears until I re-cluster" report).
    const mapRefreshKey = `${region.latitude.toFixed(4)},${region.longitude.toFixed(4)},${region.latitudeDelta.toFixed(4)}`;
    const { uriFor: clusterUriFor, bakery: clusterBakery } = useBakedClusters(clusterSpecs);

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
                    <GlassIconButton
                        icon="chevron-back"
                        glass
                        onPress={() => { completeStoreResolution(null); onCancel?.(); }}
                        size={22}
                    />
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
                        {/* Count bubbles for clustered areas (stable grid-cell key → the marker
                            mounts once and swaps its baked image in place; a chain-badge fallback
                            keeps it from flashing null, the AIRMap insert crash surface). */}
                        {clusters.map((c) => (
                            <MapClusterMarker
                                key={`c-${c.id}`}
                                coordinate={{ latitude: c.latitude, longitude: c.longitude }}
                                pillUri={clusterUriFor(c.id)}
                                fallback={chainBadgeImage(req.chainId) ?? undefined}
                                refreshKey={mapRefreshKey}
                                zIndex={3}
                                onPress={() => onClusterPress(c)}
                            />
                        ))}
                        {/* Address pills for the individual (unclustered) stores. Stable storeId
                            key + the CGSizeZero decode patch → badge→pill swaps in place. */}
                        {/* SELECTION = in-place image swap on the store's OWN marker
                            (the pattern the cluster bubbles use). A separate stacked
                            "selected" marker broke both platforms: Android showed the
                            old pill until a zoom forced a redraw, and Apple Maps drew
                            the remounted normal pill OVER the selected one after a
                            zoom cycle (re-taps were no-ops — same selectedId). Falls
                            back to the normal pill until the pink bake lands. */}
                        {singles.map((s) => {
                            const isSel = s.id === selectedId;
                            const selBake = isSel ? sizeFor(`${s.id}|s`) : undefined;
                            return (
                                <MapPillMarker
                                    key={`s-${s.id}`}
                                    coordinate={{ latitude: s.latitude, longitude: s.longitude }}
                                    chainId={req.chainId}
                                    pillUri={selBake ? selBake.uri : uriFor(`${s.id}|n`)}
                                    pillSize={selBake ?? sizeFor(`${s.id}|n`)}
                                    refreshKey={mapRefreshKey}
                                    zIndex={isSel ? 10 : 2}
                                    onPress={() => setSelectedId(s.id)}
                                />
                            );
                        })}
                        {/* Keep a standalone selected pill ONLY while the selected store
                            is clustered away (zoomed out) so the pick stays visible. */}
                        {selectedStore && !singles.some((s) => s.id === selectedStore.id) && (() => {
                            const bake = sizeFor(`${selectedStore.id}|s`);
                            if (!bake) return null;
                            return (
                                <MapPillMarker
                                    key={`sel-${selectedStore.id}`}
                                    coordinate={{ latitude: selectedStore.latitude, longitude: selectedStore.longitude }}
                                    chainId={req.chainId}
                                    pillUri={bake.uri}
                                    pillSize={bake}
                                    refreshKey={mapRefreshKey}
                                    zIndex={10}
                                    onPress={() => setSelectedId(selectedStore.id)}
                                />
                            );
                        })()}
                    </>
                }
            />
            {/* Off-screen bakeries (pills + cluster bubbles) — must live OUTSIDE the map
                (normal Views, not Markers). Gated on mapReady so the view-shot capture
                burst doesn't run during map init. */}
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
