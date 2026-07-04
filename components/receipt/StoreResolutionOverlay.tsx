import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import MapView, { type Region } from 'react-native-maps';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../constants/theme';
import { GlassIconButton } from '../GlassIconButton';
import { MapPickerScaffold } from '../map/MapPickerScaffold';
import {
    useBakedPills, MapPillMarker,
    type MapPillSpec,
} from '../map/MapPill';
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
 * Store markers are the N stores NEAREST the anchor (the receipt's address), drawn as
 * address pills (street + number). The set is STABLE — it re-anchors only on open/search,
 * never on pan/zoom — so dragging the map adds/removes no markers. That is deliberate: the
 * unchecked AIRMap insertReactSubview crash only fires when the marker set churns mid-gesture
 * (clustering did that on every zoom), so a stable set is crash-proof even on a build without
 * the react-native-maps patch. Search re-anchors to look elsewhere.
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
    // Anchor for the NEAREST-N store set — updated ONLY on a deliberate recenter (open,
    // search), never on pan/zoom, so the marker set is stable during gestures (see `nearest`).
    const [anchor, setAnchor] = useState<{ lat: number; lng: number }>({ lat: VILNIUS_FALLBACK.lat, lng: VILNIUS_FALLBACK.lng });

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
                // Markers stay unmounted until this centering settles (see `centered`), and
                // the nearest-N set is anchored on the target — so the first (and only) mount
                // is one clean batch of the stores nearest the receipt's address.
                setAnchor({ lat: c.lat, lng: c.lng });
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

    // Pan/zoom must NOT change the marker set (that churn is the crash). onRegionChangeComplete
    // is a deliberate no-op; the set is re-anchored only on open + search.
    const handleRegionChange = useCallback((_r: Region) => { /* frozen — see `anchor`/`nearest` */ }, []);

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
        setAnchor({ lat: r.lat, lng: r.lng }); // deliberate recenter → re-pick the nearest stores
    }, [searchText, t]);

    const onConfirm = useCallback(() => {
        const s = stores.find((x) => x.id === selectedId);
        if (!s) return;
        completeStoreResolution({ storeId: s.id, storeName: s.name, storeAddress: s.address });
    }, [stores, selectedId]);

    const selectedStore = useMemo(() => stores.find((s) => s.id === selectedId) ?? null, [stores, selectedId]);

    // NEAREST-N, not clustering. The N stores closest to the frozen `anchor`. This set only
    // changes when the anchor does (open / search) — NEVER on pan/zoom — so React adds or
    // removes ZERO map children while you drag the map. That is the whole fix: the crash is
    // an unchecked insert in AIRMap that only fires when the marker set churns during a
    // Fabric mount transaction, and clustering churned it on every zoom. A stable set can't
    // churn, so it can't crash — on ANY build, with or without the native patch. (The
    // committed patch is still the belt for the price map + deliberate recenters.)
    const NEAREST_N = 30;
    const nearest = useMemo(() => {
        if (!stores.length) return [];
        const cosLat = Math.cos((anchor.lat * Math.PI) / 180);
        const d2 = (s: ChainStore) => {
            const dLat = s.latitude - anchor.lat;
            const dLng = (s.longitude - anchor.lng) * cosLat;
            return dLat * dLat + dLng * dLng;
        };
        return [...stores].sort((a, b) => d2(a) - d2(b)).slice(0, NEAREST_N);
    }, [stores, anchor]);

    // Bake the address pills (street + number, two rows, chain logo) off-screen so each
    // marker renders a never-clipped native image.
    const pillSpecs = useMemo<MapPillSpec[]>(() => {
        if (!req) return [];
        const specs: MapPillSpec[] = nearest.map((s) => ({
            key: `${s.id}|n`, chainId: req.chainId, lines: addrLines(s.address), variant: 'neutral',
        }));
        if (selectedStore) {
            specs.push({ key: `${selectedStore.id}|s`, chainId: req.chainId, lines: addrLines(selectedStore.address), variant: 'selected' });
        }
        return specs;
    }, [nearest, selectedStore, req]);
    const { uriFor, bakery } = useBakedPills(pillSpecs);

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
                        {/* Each pill renders ONLY once its image is fully baked, with a STABLE
                            key (store id). So a marker mounts exactly once, already holding its
                            final pill — there is no badge→pill in-place image swap (which showed
                            as a "rectangle"/tiny pill on the unpatched native), and no remount.
                            The nearest set is frozen during pan/zoom, so no marker is ever added
                            or removed while dragging → the unchecked AIRMap insert never fires. */}
                        {nearest.map((s) => {
                            const uri = uriFor(`${s.id}|n`);
                            if (!uri) return null;
                            return (
                                <MapPillMarker
                                    key={`s-${s.id}`}
                                    coordinate={{ latitude: s.latitude, longitude: s.longitude }}
                                    chainId={req.chainId}
                                    pillUri={uri}
                                    zIndex={2}
                                    onPress={() => setSelectedId(s.id)}
                                />
                            );
                        })}
                        {selectedStore && (() => {
                            const uri = uriFor(`${selectedStore.id}|s`);
                            if (!uri) return null;
                            return (
                                <MapPillMarker
                                    key={`sel-${selectedStore.id}`}
                                    coordinate={{ latitude: selectedStore.latitude, longitude: selectedStore.longitude }}
                                    chainId={req.chainId}
                                    pillUri={uri}
                                    zIndex={10}
                                    onPress={() => setSelectedId(selectedStore.id)}
                                />
                            );
                        })()}
                    </>
                }
            />
            {/* Off-screen bakery — must live OUTSIDE the map (normal Views, not Markers).
                Gated on mapReady so the view-shot capture burst doesn't run during map init. */}
            {mapReady && bakery}
        </View>
    );
}

const makeStyles = (_c: AppTheme) =>
    StyleSheet.create({
        // Full-bleed: the map fills the whole surface; all chrome floats over it
        // (glass back chevron + title chip + search up top, confirm pill at the bottom).
        root: { flex: 1 },
    });
