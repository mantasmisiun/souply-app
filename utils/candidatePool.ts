import { API_BASE_URL } from '../config/api';
import {
    getLocationSettings,
    getPresets,
    getVisitHistory,
    haversineKm,
    type LocationPreset,
    type LocationSettings,
} from './locationStorage';
import { tryGpsCoords, loadCachedCoords } from './location';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoreLite {
    id: number;
    chainId: number;
    name: string;
    address: string;
    latitude: number;
    longitude: number;
    chainName: string;
    logoUrl: string | null;
}

export interface CandidatePool {
    storeIds: number[];
    /** Resolved single search-point used for distance display; null for route mode */
    searchCenter: { lat: number; lng: number } | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BUS_RADIUS_KM = 3;            // radius used by the centroid-shift visit filter
const CAR_DETOUR_RATIO = 1.25;      // route corridor: max (d_from_store + d_store_to) / d_from_to
const CENTROID_MIN_VISITS = 8;      // minimum visits before centroid shift activates
const STORES_LITE_TTL_MS = 15 * 60 * 1000; // 15 min in-memory cache

// Nearest-pool bounds — shared by single-endpoint AND route selection.
const MAX_RADIUS_KM = 10;           // hard ceiling for single-endpoint search
const TARGET_POOL = 12;             // nearest-N target before the per-chain guarantee
const MAX_PER_CHAIN = 3;            // branches of ONE chain allowed among the nearest-N
const BUS_WALK_KM = 1;              // route/bus: stores must be walkable from an endpoint

// ---------------------------------------------------------------------------
// In-memory store list cache (avoids re-fetching on every calculation)
// ---------------------------------------------------------------------------

let _storesCache: { ts: number; data: StoreLite[] } | null = null;

async function fetchStoresLite(): Promise<StoreLite[]> {
    const now = Date.now();
    if (_storesCache && now - _storesCache.ts < STORES_LITE_TTL_MS) {
        return _storesCache.data;
    }
    const res = await fetch(`${API_BASE_URL}/api/stores/lite`);
    if (!res.ok) throw new Error(`Stores fetch failed: ${res.status}`);
    const data: StoreLite[] = await res.json();
    _storesCache = { ts: now, data };
    return data;
}

// ---------------------------------------------------------------------------
// Centroid shift (bus mode)
// ---------------------------------------------------------------------------

/**
 * Frequency-weighted centroid of stores the user has visited near a given
 * endpoint preset. Only activates once CENTROID_MIN_VISITS has been reached.
 * Returns null when insufficient data.
 */
function computeCentroid(
    endpoint: LocationPreset,
    stores: StoreLite[],
    visitMap: Map<number, number>,
): { lat: number; lng: number } | null {
    const totalVisits = [...visitMap.values()].reduce((a, b) => a + b, 0);
    if (totalVisits < CENTROID_MIN_VISITS) return null;

    let weightedLat = 0;
    let weightedLng = 0;
    let totalWeight = 0;

    for (const store of stores) {
        const visits = visitMap.get(store.id) ?? 0;
        if (visits === 0) continue;
        // Only stores within BUS_RADIUS_KM of the endpoint contribute
        if (haversineKm(endpoint.lat, endpoint.lng, store.latitude, store.longitude) > BUS_RADIUS_KM) continue;
        weightedLat += store.latitude * visits;
        weightedLng += store.longitude * visits;
        totalWeight += visits;
    }

    if (totalWeight === 0) return null;
    return { lat: weightedLat / totalWeight, lng: weightedLng / totalWeight };
}

/**
 * Generic nearest-first bounded selection. `score(store)` returns a "nearness"
 * cost (lower = nearer/better; null = excluded). Takes the nearest TARGET_POOL
 * with a per-chain instance cap, then guarantees the nearest branch of every
 * scorable chain (combo diversity). Shared by the single-endpoint and route
 * pools so the density/diversity discipline is identical for both.
 */
function selectNearest(stores: StoreLite[], score: (s: StoreLite) => number | null): StoreLite[] {
    const scored = stores
        .map(s => ({ s, v: score(s) }))
        .filter((x): x is { s: StoreLite; v: number } => x.v != null && Number.isFinite(x.v))
        .sort((a, b) => a.v - b.v);

    const chosen = new Map<number, StoreLite>();
    const perChain = new Map<number, number>();
    // Nearest-N with a per-chain instance cap.
    for (const { s } of scored) {
        if (chosen.size >= TARGET_POOL) break;
        const n = perChain.get(s.chainId) ?? 0;
        if (n >= MAX_PER_CHAIN) continue;
        chosen.set(s.id, s);
        perChain.set(s.chainId, n + 1);
    }
    // Guarantee every scorable chain's nearest branch (scored is cost-ascending,
    // so the first unseen store of a chain IS its nearest/best branch).
    for (const { s } of scored) {
        if (perChain.has(s.chainId)) continue;
        chosen.set(s.id, s);
        perChain.set(s.chainId, 1);
    }
    return [...chosen.values()];
}

/**
 * Bounded, NEAREST-FIRST candidate set for a single-endpoint search (current /
 * specific). Replaces "every store within a fixed radius", which in dense cities
 * returned dozens of same-chain branches → the map filled with duplicate combos
 * (the "10 identical Rimi+IKI pills" bug). Ranked by radial distance and capped
 * within MAX_RADIUS_KM; a chain with nothing in range is simply not viable — we
 * do NOT fan out past the ceiling to find it. Exported for unit testing.
 */
export function nearestPool(center: { lat: number; lng: number }, stores: StoreLite[]): StoreLite[] {
    return selectNearest(stores, s => {
        const d = haversineKm(center.lat, center.lng, s.latitude, s.longitude);
        return d <= MAX_RADIUS_KM ? d : null;
    });
}

/**
 * Bounded, DIRECTIONAL candidate set for a route (from → to). Ranked by DETOUR —
 * the extra travel a stop adds: d(from,S) + d(S,to) − d(from,to). Detour is ~0
 * for a store ON the way and ~2× its distance for one BEHIND you, so ranking by
 * it prefers "toward the destination" at BOTH ends automatically (near `from`,
 * stores toward `to` win; near `to`, stores toward `from` win). Then the shared
 * per-chain cap + nearest-branch guarantee apply.
 *   · 'car' → the whole corridor: any store whose via-distance stays within
 *             CAR_DETOUR_RATIO of the direct route (you can stop anywhere).
 *   · 'bus' → only stores WALKABLE (BUS_WALK_KM) from an endpoint — you shop near
 *             the stops, not mid-route — then directional by detour.
 * Exported for unit testing.
 */
export function nearestRoutePool(
    from: { lat: number; lng: number },
    to: { lat: number; lng: number },
    stores: StoreLite[],
    kind: 'car' | 'bus',
): StoreLite[] {
    const direct = haversineKm(from.lat, from.lng, to.lat, to.lng);
    return selectNearest(stores, s => {
        const dFrom = haversineKm(from.lat, from.lng, s.latitude, s.longitude);
        const dTo = haversineKm(to.lat, to.lng, s.latitude, s.longitude);
        const detour = Math.max(0, dFrom + dTo - direct);
        if (kind === 'bus') {
            // Walkable from either endpoint (get off the bus and walk to it).
            return Math.min(dFrom, dTo) <= BUS_WALK_KM ? detour : null;
        }
        // Car: inside the detour corridor (an ellipse hugging the route).
        return dFrom + dTo <= CAR_DETOUR_RATIO * direct ? detour : null;
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds the candidate store pool based on the user's saved LocationSettings.
 *
 * Returns { storeIds, searchCenter }:
 * - storeIds — filtered list to pass to the calculate endpoint
 * - searchCenter — a single lat/lng for distance display (null in route mode)
 *
 * @param resolvedCoords — already-resolved coords (skips GPS in 'current' mode)
 *
 * Falls back to an empty pool (= server uses closest stores) if presets are
 * missing or GPS fails — never throws.
 */
export async function buildCandidatePool(
    resolvedCoords?: { lat: number; lng: number },
): Promise<CandidatePool> {
    try {
        const [settings, presets, allStores, history] = await Promise.all([
            getLocationSettings(),
            getPresets(),
            fetchStoresLite(),
            getVisitHistory(),
        ]);

        // Build a quick visitCount map (storeId → totalVisits)
        const visitMap = new Map<number, number>(
            history.map(v => [v.storeId, v.visitCount]),
        );

        const { transport, mode, specificPreset, routeFrom, routeTo } = settings;

        // ── 'current' mode — GPS / cached coords as the single endpoint ──
        // Nearest-first, bounded pool (see nearestPool). Car and bus resolve to
        // the same set here — the old car/bus split was just two radius formulas.
        if (mode === 'current') {
            const gps = resolvedCoords ?? await tryGpsCoords() ?? await loadCachedCoords();
            if (!gps) return { storeIds: [], searchCenter: null };
            const pt = { lat: gps.lat, lng: gps.lng };
            return { storeIds: nearestPool(pt, allStores).map(s => s.id), searchCenter: pt };
        }

        // ── 'specific' mode — single preset endpoint ──
        if (mode === 'specific') {
            const preset = specificPreset ? presets[specificPreset] : null;
            if (!preset) return { storeIds: [], searchCenter: null };

            const pt = { lat: preset.lat, lng: preset.lng };
            // Bus may shift the centre toward frequently-visited stores; car uses
            // the preset itself. Then the nearest-pool is built around that centre.
            const centroid = transport === 'bus' ? computeCentroid(preset, allStores, visitMap) : null;
            const center = centroid
                ? { lat: (pt.lat + centroid.lat) / 2, lng: (pt.lng + centroid.lng) / 2 }
                : pt;
            return { storeIds: nearestPool(center, allStores).map(s => s.id), searchCenter: center };
        }

        // ── 'route' mode — directional pool between two presets ──
        if (mode === 'route') {
            const fromPreset = routeFrom ? presets[routeFrom] : null;
            const toPreset = routeTo ? presets[routeTo] : null;
            if (!fromPreset) return { storeIds: [], searchCenter: null };

            const from = { lat: fromPreset.lat, lng: fromPreset.lng };
            // Destination not set yet → treat `from` as a single endpoint.
            if (!toPreset) return { storeIds: nearestPool(from, allStores).map(s => s.id), searchCenter: from };

            const to = { lat: toPreset.lat, lng: toPreset.lng };
            // Endpoints coincide → no meaningful direction; pool around the midpoint.
            if (haversineKm(from.lat, from.lng, to.lat, to.lng) < 0.5) {
                const mid = { lat: (from.lat + to.lat) / 2, lng: (from.lng + to.lng) / 2 };
                return { storeIds: nearestPool(mid, allStores).map(s => s.id), searchCenter: mid };
            }

            const pool = nearestRoutePool(from, to, allStores, transport === 'car' ? 'car' : 'bus');
            return { storeIds: pool.map(s => s.id), searchCenter: null };
        }

        return { storeIds: [], searchCenter: null };
    } catch {
        return { storeIds: [], searchCenter: null };
    }
}
