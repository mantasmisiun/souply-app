import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MapView, { type Region } from 'react-native-maps';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, type AppTheme } from '../../constants/theme';
import { ScreenHeading } from '../ScreenHeading';
import { GlassIconButton } from '../GlassIconButton';
import { MapPickerScaffold } from '../map/MapPickerScaffold';
import {
    useBakedPills, useBakedClusters, MapPillMarker, MapClusterMarker,
    type MapPillSpec, type MapClusterSpec,
} from '../map/MapPill';
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
    const insets = useSafeAreaInsets();
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
            }
        })();
        return () => { cancelled = true; };
    }, [req]);

    // Dismissed without confirming → cancel the handoff so the pipeline doesn't hang.
    // completeStoreResolution is idempotent, so this is a safe backstop after Confirm too.
    useEffect(() => () => { completeStoreResolution(null); }, []);

    // Reveal the map + start baking once it's painted. Fallback timer in case onMapReady
    // never fires on some device, so content can't be stuck behind the cover.
    const handleMapReady = useCallback(() => setMapReady(true), []);
    useEffect(() => {
        const t = setTimeout(() => setMapReady(true), 2500);
        return () => clearTimeout(t);
    }, []);

    // A single animateToRegion emits onRegionChangeComplete several times on Android; ignore
    // near-identical regions so one settle triggers at most one re-cluster + re-bake (kills the
    // zoom/typing jank). The epsilon is far below the cluster→singles threshold (0.045).
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

    if (!req) return null;

    return (
        <View style={styles.root}>
            {/* Back chevron (left) + the same ScreenHeading title band as every other screen.
                The nav row reserves the status-bar inset (bar-less modal). The chevron dismisses
                the overlay — same handoff the old close (X) used. */}
            <View style={[styles.navBar, { paddingTop: insets.top + 4 }]}>
                <GlassIconButton icon="chevron-back" onPress={() => completeStoreResolution(null)} size={24} />
            </View>
            <ScreenHeading title={t('storeResolution.title')} />
            <MapPickerScaffold
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
                    <>
                        {clusters.map((c) => (
                            <MapClusterMarker
                                key={clusterKey(c)}
                                coordinate={{ latitude: c.latitude, longitude: c.longitude }}
                                pillUri={clusterUriFor(clusterKey(c))}
                                zIndex={1}
                                onPress={() => onClusterPress(c)}
                            />
                        ))}
                        {singles.map((s) => (
                            <MapPillMarker
                                key={`s-${s.id}|n`}
                                coordinate={{ latitude: s.latitude, longitude: s.longitude }}
                                chainId={req.chainId}
                                pillUri={uriFor(`${s.id}|n`)}
                                zIndex={2}
                                onPress={() => setSelectedId(s.id)}
                            />
                        ))}
                        {selectedStore && (
                            <MapPillMarker
                                key={`sel-${selectedStore.id}|s`}
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

const makeStyles = (c: AppTheme) =>
    StyleSheet.create({
        root: { flex: 1, backgroundColor: c.pageBackground },
        // Nav row holding the back chevron (left). Same cardBackground as the ScreenHeading
        // band below it (and every other screen's header), so the chevron sits on the lighter
        // header surface instead of the dark page background. paddingTop (inset) applied inline.
        navBar: { flexDirection: 'row', paddingHorizontal: spacing.sm, paddingBottom: spacing.xs, backgroundColor: c.cardBackground },
    });
