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
 * EVERY store shows an address pill (logo + street + number). Pills are baked off-screen and
 * mounted in bake-COMPLETION order, so the on-map marker list only ever GROWS AT THE END. That
 * append-only shape is what keeps it crash-free on a build WITHOUT the react-native-maps patch:
 * the AIRMap insertReactSubview crash fires on a mid-list insert into a churning set, and a
 * mount-at-the-end never produces one; mounting each marker already holding its pill also avoids
 * the badge→pill in-place swap ("rectangle"). Search only moves the camera. No clustering (dense
 * areas overlap) — that needs the committed patch, which lands on the next build.
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
                console.log(`[STOREMAP] fetched ${parsed.length} geo stores for chainId=${req.chainId} (raw=${Array.isArray(data) ? data.length : 'n/a'})`);
                setStores(parsed);
            } catch (e) { console.log('[STOREMAP] store fetch FAILED', e); /* leave empty — the map still works for search */ }
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

    // The marker set is fixed (all stores, mounted once) so region changes are irrelevant to
    // it; onRegionChangeComplete is a no-op. Nothing here ever adds or removes a marker.
    const handleRegionChange = useCallback((_r: Region) => { /* fixed set — see the block comment above */ }, []);

    const onSearch = useCallback(async () => {
        const q = searchText.trim();
        if (q.length < 3) { setSearchError(t('storeResolution.minChars')); return; }
        setSearching(true);
        setSearchError(null);
        const r = await geocodeAddress(q);
        setSearching(false);
        if (!r) { setSearchError(t('storeResolution.addressNotFound')); return; }
        console.log(`[STOREMAP] search recenter -> ${r.lat},${r.lng} (camera only; marker set unchanged)`);
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
    const storeById = useMemo(() => new Map(stores.map((s) => [s.id, s])), [stores]);

    // Bake an ADDRESS PILL (logo + street + number) for every store, plus a 'selected' variant
    // for the pick. Markers are then rendered in bake-COMPLETION order (bakedKeys) so the on-map
    // list only ever GROWS AT THE END — an append-only insert can't hit the out-of-bounds
    // AIRMap crash, and mounting each marker already holding its pill means no badge→pill
    // in-place swap (no "rectangle"). No clustering (dense areas overlap until the built patch).
    const pillSpecs = useMemo<MapPillSpec[]>(() => {
        if (!req) return [];
        const specs: MapPillSpec[] = stores.map((s) => ({
            key: `${s.id}|n`, chainId: req.chainId, lines: addrLines(s.address), variant: 'neutral',
        }));
        if (selectedStore) {
            specs.push({ key: `${selectedStore.id}|s`, chainId: req.chainId, lines: addrLines(selectedStore.address), variant: 'selected' });
        }
        return specs;
    }, [stores, selectedStore, req]);
    const { uriFor, bakedKeys, bakery } = useBakedPills(pillSpecs);

    // Log as pills bake in — stores fetched vs pills baked vs actually mounted.
    const bakedNeutralCount = bakedKeys.filter((k) => k.endsWith('|n')).length;
    useEffect(() => {
        console.log(`[STOREMAP] render — stores=${stores.length} centered=${centered} mapReady=${mapReady} pillsBaked=${bakedNeutralCount} mounted=${centered ? bakedNeutralCount : 0}`);
    }, [stores.length, centered, mapReady, bakedNeutralCount]);

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
                        {/* Address pills, rendered in BAKE-COMPLETION order (append-only) so the
                            marker list only grows at the end — no mid-list insert (crash) and no
                            in-place image swap (rectangle). Each mounts once already holding its
                            baked pill. The selected store's pill is drawn on top. */}
                        {bakedKeys.map((key) => {
                            if (!key.endsWith('|n')) return null;
                            const id = Number(key.slice(0, -2));
                            const s = storeById.get(id);
                            if (!s) return null;
                            return (
                                <MapPillMarker
                                    key={`s-${id}`}
                                    coordinate={{ latitude: s.latitude, longitude: s.longitude }}
                                    chainId={req.chainId}
                                    pillUri={uriFor(key)}
                                    zIndex={2}
                                    onPress={() => { console.log(`[STOREMAP] tapped store id=${id} "${s.address}"`); setSelectedId(id); }}
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
