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
import { type GridRegion } from '../../utils/mapClustering';
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
    // Separator optional: "GEDIMINO PR.28" (no space after the abbreviation
    // dot) must still split into street + number lines.
    const m = s.match(/^(.*?)[,\s]*(\d[\w./-]*)\s*$/);
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

    // Mount the native MapView only AFTER the host Modal's slide animation —
    // GL init on the shared main thread made the sheet stutter on entry.
    const [mountMap, setMountMap] = useState(false);
    const mountMapRef = useRef(false);
    useEffect(() => {
        const t = setTimeout(() => { mountMapRef.current = true; setMountMap(true); }, 420);
        return () => clearTimeout(t);
    }, []);

    const [initialRegion, setInitialRegion] = useState<Region>({
        latitude: VILNIUS_FALLBACK.lat,
        longitude: VILNIUS_FALLBACK.lng,
        latitudeDelta: DELTA,
        longitudeDelta: DELTA,
    });
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
                const target = { latitude: c.lat, longitude: c.lng, latitudeDelta: delta, longitudeDelta: delta };
                // Seed the region state DIRECTLY: iOS does not reliably fire
                // onRegionChangeComplete for this pre-paint animation, and a
                // stale (Vilnius) region made the first bakes prioritise the
                // wrong area — "no pills until I drag a tiny bit".
                setRegion(target);
                if (mountMapRef.current) {
                    mapRef.current?.animateToRegion(target, 600);
                } else {
                    // Map not mounted yet (deferred past the Modal slide) — mount
                    // it directly at the target so there's no animation at all.
                    setInitialRegion(target);
                }
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
    // Mid-drag region feed (throttled): without it the marker set is computed
    // for the LAST SETTLED viewport only, so stores in the area being looked
    // at appear only after the drag stops ("I need to drag around to make
    // stores appear"). 400 ms keeps recomputes cheap.
    const dragTickRef = useRef(0);
    const handleRegionDrag = useCallback((r: Region) => {
        const now = Date.now();
        if (now - dragTickRef.current < 400) return;
        dragTickRef.current = now;
        handleRegionChange(r);
    }, [handleRegionChange]);

    const onSearch = useCallback(async () => {
        const q = searchText.trim();
        if (q.length < 3) { setSearchError(t('storeResolution.minChars')); return; }
        setSearching(true);
        setSearchError(null);
        const r = await geocodeAddress(q);
        setSearching(false);
        if (!r) { setSearchError(t('storeResolution.addressNotFound')); return; }
        const target = { latitude: r.lat, longitude: r.lng, latitudeDelta: CLOSE_DELTA, longitudeDelta: CLOSE_DELTA };
        mapRef.current?.animateToRegion(target, 600);
        setRegion(target);
    }, [searchText, t]);

    const onConfirm = useCallback(() => {
        const s = stores.find((x) => x.id === selectedId);
        console.log(`[SRO] confirm sel=${selectedId} found=${!!s}`);
        if (!s) return;
        completeStoreResolution({ storeId: s.id, storeName: s.name, storeAddress: s.address });
    }, [stores, selectedId]);

    const selectedStore = useMemo(() => stores.find((s) => s.id === selectedId) ?? null, [stores, selectedId]);

    // MOUNT EVERYTHING, ONCE (back to this file's original crash-free design):
    // region-driven clustering re-mounted markers in remove+insert batches on
    // every zoom-level crossing, and each batch risks the AIRMap interop
    // silently DROPPING an annotation view (the clamp patch stops the crash,
    // not the loss) — a dropped marker's key never changes, so it stays
    // invisible at every zoom (the Kuršėnai report). One chain has ≤240
    // stores — every pill mounts exactly once, append-only in bake-completion
    // order, and the marker set NEVER changes afterwards. Zero churn.
    const allStores = useMemo(
        () => stores.filter((s) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude)),
        [stores],
    );
    const storeById = useMemo(() => new Map(allStores.map((s) => [s.id, s])), [allStores]);

    // FIXED two-tier bubbles (country + district) computed ONCE from the static
    // store list — never from the zoom level, so nothing ever remounts. The
    // current zoom picks a BAND, and the band only flips marker OPACITY:
    //   delta > 0.6   → tier-A bubbles (country view)
    //   delta > 0.05  → tier-B bubbles (district view)
    //   else          → the address pills
    // Cells with a single store show that store's pill in the bubble bands too.
    const TIERS = { A: 0.35, B: 0.055 } as const;
    interface TierBubble { key: string; latitude: number; longitude: number; count: number;
        latMin: number; latMax: number; lngMin: number; lngMax: number }
    const tiers = useMemo(() => {
        const build = (cell: number, tier: string) => {
            const buckets = new Map<string, ChainStore[]>();
            for (const s of allStores) {
                const key = `${tier}:${Math.floor(s.latitude / cell)}:${Math.floor(s.longitude / cell)}`;
                const arr = buckets.get(key);
                if (arr) arr.push(s); else buckets.set(key, [s]);
            }
            // MERGE PASS: a plain grid splits neighbours that straddle a cell
            // boundary ("two logos side by side that never combined") — union
            // any groups whose centroids are closer than ~a cell, greedily and
            // deterministically (sorted keys), until stable.
            type Group = { key: string; members: ChainStore[]; lat: number; lng: number };
            const centroid = (members: ChainStore[]) => {
                let la = 0, ln = 0;
                for (const s of members) { la += s.latitude; ln += s.longitude; }
                return { lat: la / members.length, lng: ln / members.length };
            };
            const span = (members: ChainStore[]) => {
                let latMin = Infinity, latMax = -Infinity, lngMin = Infinity, lngMax = -Infinity;
                for (const s of members) {
                    latMin = Math.min(latMin, s.latitude); latMax = Math.max(latMax, s.latitude);
                    lngMin = Math.min(lngMin, s.longitude); lngMax = Math.max(lngMax, s.longitude);
                }
                return { lat: latMax - latMin, lng: lngMax - lngMin };
            };
            let groups: Group[] = [...buckets.entries()]
                .sort(([a], [b]) => (a < b ? -1 : 1))
                .map(([key, members]) => ({ key, members, ...centroid(members) }));
            const NEAR = cell * 0.95;
            // BBOX-CAPPED merging: only combine boundary-straddling neighbours —
            // the merged group must still fit ~one cell. Uncapped iteration
            // chain-merged whole regions into a single circle.
            const MAX_SPAN = cell * 1.4;
            for (let merged = true; merged;) {
                merged = false;
                outer: for (let i = 0; i < groups.length; i++) {
                    for (let j = i + 1; j < groups.length; j++) {
                        const a = groups[i], b = groups[j];
                        if (Math.abs(a.lat - b.lat) >= NEAR || Math.abs(a.lng - b.lng) >= NEAR) continue;
                        const members = [...a.members, ...b.members];
                        const sp = span(members);
                        if (sp.lat > MAX_SPAN || sp.lng > MAX_SPAN) continue;
                        groups[i] = { key: a.key < b.key ? a.key : b.key, members, ...centroid(members) };
                        groups.splice(j, 1);
                        merged = true;
                        break outer;
                    }
                }
            }
            // EVERY group renders as a count circle in this band — lone stores
            // included ("1" in a circle), matching the bubble style.
            const bubbles: TierBubble[] = groups.map((g) => {
                let latMin = Infinity, latMax = -Infinity, lngMin = Infinity, lngMax = -Infinity;
                for (const s of g.members) {
                    latMin = Math.min(latMin, s.latitude); latMax = Math.max(latMax, s.latitude);
                    lngMin = Math.min(lngMin, s.longitude); lngMax = Math.max(lngMax, s.longitude);
                }
                return { key: g.key, latitude: g.lat, longitude: g.lng, count: g.members.length,
                    latMin, latMax, lngMin, lngMax };
            });
            return { bubbles };
        };
        return { A: build(TIERS.A, 'A'), B: build(TIERS.B, 'B') };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [allStores]);
    // HYSTERESIS on the zoom bands: the map opens at delta 0.05 and iOS
    // adjusts/jitters the reported delta with the screen aspect — a hard
    // threshold at 0.05 flapped EVERY pill's visibility while panning. A band
    // switches only when the delta crosses its boundary with ~20% margin.
    const bandRef = useRef<'A' | 'B' | 'pills'>('pills');
    const band = (() => {
        const d = region.longitudeDelta;
        const prev = bandRef.current;
        let next = prev;
        if (prev !== 'A' && d > (prev === 'B' ? 0.7 : 0.6)) next = 'A';
        else if (prev === 'A' && d < 0.5) next = 'B';
        if (prev === 'pills' && d > 0.085) next = 'B';
        else if (prev === 'B' && d < 0.065) next = 'pills';
        if (next !== prev) console.log(`[SRO] band ${prev} -> ${next} d=${d.toFixed(4)}`);
        bandRef.current = next;
        return next;
    })();
    // Every bubble tap must land ONE MEANINGFUL LEVEL deeper — pills when the
    // group is compact (a tier-B view would just show the same circle again),
    // split circles otherwise. Both clamps keep the target inside the next
    // band's hysteresis window, so a tap can never zoom and change nothing.
    const bubbleSeedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (bubbleSeedTimer.current) clearTimeout(bubbleSeedTimer.current); }, []);
    const zoomToBubble = (b: TierBubble, tier: 'A' | 'B') => {
        const pad = 1.6;
        const fitLat = (b.latMax - b.latMin) * pad;
        const fitLng = (b.lngMax - b.lngMin) * pad;
        const compact = (b.latMax - b.latMin) <= TIERS.B && (b.lngMax - b.lngMin) <= TIERS.B;
        const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
        const toPills = tier === 'B' || compact;
        const target = {
            latitude: (b.latMin + b.latMax) / 2,
            longitude: (b.lngMin + b.lngMax) / 2,
            latitudeDelta: toPills ? clamp(fitLat, 0.015, 0.045) : clamp(fitLat, 0.08, 0.45),
            longitudeDelta: toPills ? clamp(fitLng, 0.015, 0.045) : clamp(fitLng, 0.08, 0.45),
        };
        mapRef.current?.animateToRegion(target, 350);
        // Seed the region AFTER the animation lands: iOS often skips the settle
        // event for programmatic animations (same quirk as the opening centering),
        // which froze the band — the next tap then "did nothing". Seeding
        // immediately is also wrong (the band flipped 350 ms early = pill flash).
        if (bubbleSeedTimer.current) clearTimeout(bubbleSeedTimer.current);
        bubbleSeedTimer.current = setTimeout(() => setRegion(target), 380);
    };

    // Bake priority = distance to the current map centre (nearest first), so
    // the pills the user is LOOKING AT appear within the first bake window.
    // Re-sorting on camera settle only re-prioritises the remaining bakes —
    // completed bakes (and mounted markers) are untouched.
    const pillSpecs = useMemo<MapPillSpec[]>(() => {
        if (!req) return [];
        const specs: MapPillSpec[] = [...allStores]
            .sort((a, b) =>
                ((a.latitude - region.latitude) ** 2 + (a.longitude - region.longitude) ** 2) -
                ((b.latitude - region.latitude) ** 2 + (b.longitude - region.longitude) ** 2))
            .map((s) => ({ key: `${s.id}|n`, chainId: req.chainId, lines: addrLines(s.address), variant: 'neutral' as const }));
        if (selectedStore) {
            // Selected bake goes FIRST so the pink swap lands ASAP after a tap.
            specs.unshift({ key: `${selectedStore.id}|s`, chainId: req.chainId, lines: addrLines(selectedStore.address), variant: 'selected' });
        }
        return specs;
    }, [allStores, selectedStore, req, region.latitude, region.longitude]);
    const { sizeFor, bakery, bakedKeys } = useBakedPills(pillSpecs);

    // Neutral pills in BAKE-COMPLETION order — the on-map marker list only ever
    // APPENDS (no mid-list insert, the AIRMap crash/drop surface).
    const mountedPills = useMemo(() => {
        const out: { store: ChainStore; bake: { uri: string; w: number; h: number } }[] = [];
        for (const key of bakedKeys) {
            if (!key.endsWith('|n')) continue;
            const store = storeById.get(Number(key.slice(0, -2)));
            const bake = sizeFor(key);
            if (store && bake) out.push({ store, bake });
        }
        console.log(`[SRO] mounted=${out.length}/${allStores.length} sel=${selectedId ?? '-'}`);
        return out;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bakedKeys, storeById, sizeFor]);

    const clusterSpecs = useMemo<MapClusterSpec[]>(
        () => [...tiers.A.bubbles, ...tiers.B.bubbles].map((b) => ({ key: b.key, count: b.count, big: b.count >= 20 })),
        [tiers],
    );
    const { uriFor: clusterUriFor, bakery: clusterBakery } = useBakedClusters(clusterSpecs);

    // Android-only re-track key (harmless on iOS): bumped on camera settle.
    const mapRefreshKey = `${region.latitude.toFixed(4)},${region.longitude.toFixed(4)},${region.latitudeDelta.toFixed(4)}`;

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
                mountMap={mountMap}
                onMapReady={handleMapReady}
                mapReady={mapReady}
                onRegionChangeComplete={handleRegionChange}
                onRegionChange={handleRegionDrag}
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
                        {/* Append-only neutral pills (bake-completion order). Keys are
                            STABLE FOREVER — the set only grows, never reorders, never
                            remounts. All selection styling happens on the standalone
                            marker below, so these never churn. */}
                        {mountedPills.map(({ store, bake }) => (
                            <MapPillMarker
                                key={`s-${store.id}`}
                                coordinate={{ latitude: store.latitude, longitude: store.longitude }}
                                chainId={req.chainId}
                                pillUri={bake.uri}
                                pillSize={bake}
                                refreshKey={mapRefreshKey}
                                zIndex={2}
                                hidden={band !== 'pills'}
                                onPress={() => {
                                    console.log(`[SRO] tap store=${store.id} prevSel=${selectedId}`);
                                    setSelectedId(store.id);
                                }}
                            />
                        ))}
                        {/* Count bubbles — BOTH fixed tiers permanently mounted; the zoom
                            band flips opacity only. Tapping zooms into the cell one band
                            deeper (pills for tier B, tier B for tier A). */}
                        {(['A', 'B'] as const).map((tier) =>
                            tiers[tier].bubbles.map((b) => (
                                <MapClusterMarker
                                    key={b.key}
                                    coordinate={{ latitude: b.latitude, longitude: b.longitude }}
                                    pillUri={clusterUriFor(b.key)}
                                    fallback={chainBadgeImage(req.chainId) ?? undefined}
                                    refreshKey={mapRefreshKey}
                                    zIndex={3}
                                    hidden={band !== tier}
                                    onPress={() => {
                                        console.log(`[SRO] tap bubble=${b.key} n=${b.count}`);
                                        zoomToBubble(b, tier);
                                    }}
                                />
                            )))}

                        {/* Selected pill: ONE standalone marker, keyed by store id — a
                            selection change is the ONLY marker swap on this map, and the
                            fresh marker is the newest native annotation, so Apple Maps
                            draws it on top AND hit-tests it first (zIndex alone is lost
                            to annotation recycling). Falls back to the neutral bake so
                            it appears instantly; swaps to pink in place when ready. */}
                        {selectedStore && (() => {
                            const bake = sizeFor(`${selectedStore.id}|s`) ?? sizeFor(`${selectedStore.id}|n`);
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
                                    onPress={() => console.log(`[SRO] tap standalone sel=${selectedStore.id}`)}
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
