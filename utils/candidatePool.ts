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

const BUS_RADIUS_KM = 3;            // hard search radius around the bus-mode center
const CAR_DETOUR_RATIO = 1.25;      // max (dist_A_store + dist_store_B) / dist_A_B
const CENTROID_MIN_VISITS = 8;      // minimum visits before centroid shift activates
const STORES_LITE_TTL_MS = 15 * 60 * 1000; // 15 min in-memory cache

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
 * Bus-mode candidate pool. The search center is:
 *   - midpoint(endpoint, centroid) if centroid shift applies
 *   - endpoint itself otherwise
 * All stores within BUS_RADIUS_KM of the center are candidates.
 */
function busCandidates(
    endpoint: { lat: number; lng: number },
    centroid: { lat: number; lng: number } | null,
    stores: StoreLite[],
): { candidates: StoreLite[]; center: { lat: number; lng: number } } {
    const center = centroid
        ? { lat: (endpoint.lat + centroid.lat) / 2, lng: (endpoint.lng + centroid.lng) / 2 }
        : endpoint;
    const candidates = stores.filter(s =>
        haversineKm(center.lat, center.lng, s.latitude, s.longitude) <= BUS_RADIUS_KM,
    );
    return { candidates, center };
}

/**
 * Car-mode candidate pool (detour ratio corridor). A store S is a candidate if
 * dist(A, S) + dist(S, B) ≤ CAR_DETOUR_RATIO × dist(A, B).
 *
 * When there's only one endpoint (specific mode), uses BUS_RADIUS_KM as the
 * fallback radius instead of the ratio formula.
 */
function carCandidates(
    from: { lat: number; lng: number },
    to: { lat: number; lng: number } | null,
    stores: StoreLite[],
): StoreLite[] {
    if (!to) {
        // Single-endpoint car mode — just radius around the point
        return stores.filter(s =>
            haversineKm(from.lat, from.lng, s.latitude, s.longitude) <= BUS_RADIUS_KM,
        );
    }
    const directKm = haversineKm(from.lat, from.lng, to.lat, to.lng);
    if (directKm < 0.5) {
        // Endpoints are almost the same — fall back to radius around midpoint
        const mid = { lat: (from.lat + to.lat) / 2, lng: (from.lng + to.lng) / 2 };
        return stores.filter(s =>
            haversineKm(mid.lat, mid.lng, s.latitude, s.longitude) <= BUS_RADIUS_KM,
        );
    }
    const threshold = CAR_DETOUR_RATIO * directKm;
    return stores.filter(s =>
        haversineKm(from.lat, from.lng, s.latitude, s.longitude) +
        haversineKm(s.latitude, s.longitude, to.lat, to.lng) <= threshold,
    );
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

        // ── 'current' mode — use GPS / cached coords as the single endpoint ──
        if (mode === 'current') {
            const gps = resolvedCoords ?? await tryGpsCoords() ?? await loadCachedCoords();
            if (!gps) return { storeIds: [], searchCenter: null };

            const pt = { lat: gps.lat, lng: gps.lng };
            if (transport === 'car') {
                const candidates = carCandidates(pt, null, allStores);
                return { storeIds: candidates.map(s => s.id), searchCenter: pt };
            }
            // Bus
            const centroid = null; // no preset → no centroid shift for current-location mode
            const { candidates, center } = busCandidates(pt, centroid, allStores);
            return { storeIds: candidates.map(s => s.id), searchCenter: center };
        }

        // ── 'specific' mode — single preset endpoint ──
        if (mode === 'specific') {
            const preset = specificPreset ? presets[specificPreset] : null;
            if (!preset) return { storeIds: [], searchCenter: null };

            const pt = { lat: preset.lat, lng: preset.lng };
            if (transport === 'car') {
                const candidates = carCandidates(pt, null, allStores);
                return { storeIds: candidates.map(s => s.id), searchCenter: pt };
            }
            // Bus with potential centroid shift
            const centroid = computeCentroid(preset, allStores, visitMap);
            const { candidates, center } = busCandidates(pt, centroid, allStores);
            return { storeIds: candidates.map(s => s.id), searchCenter: center };
        }

        // ── 'route' mode — corridor between two presets ──
        if (mode === 'route') {
            const fromPreset = routeFrom ? presets[routeFrom] : null;
            const toPreset = routeTo ? presets[routeTo] : null;

            // At minimum we need the from-point
            if (!fromPreset) return { storeIds: [], searchCenter: null };

            const from = { lat: fromPreset.lat, lng: fromPreset.lng };
            const to = toPreset ? { lat: toPreset.lat, lng: toPreset.lng } : null;

            if (transport === 'car') {
                const candidates = carCandidates(from, to, allStores);
                return { storeIds: candidates.map(s => s.id), searchCenter: null };
            }

            // Bus route: union of candidates near each endpoint's bus center
            const fromCentroid = computeCentroid(fromPreset, allStores, visitMap);
            const { candidates: fromCandidates } = busCandidates(from, fromCentroid, allStores);

            if (!toPreset) {
                return { storeIds: fromCandidates.map(s => s.id), searchCenter: null };
            }

            const toCentroid = computeCentroid(toPreset, allStores, visitMap);
            const { candidates: toCandidates } = busCandidates(to!, toCentroid, allStores);

            const unionIds = new Set([
                ...fromCandidates.map(s => s.id),
                ...toCandidates.map(s => s.id),
            ]);
            return { storeIds: [...unionIds], searchCenter: null };
        }

        return { storeIds: [], searchCenter: null };
    } catch {
        return { storeIds: [], searchCenter: null };
    }
}
