import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE_URL } from '../config/api';
import { buildCandidatePool } from './candidatePool';
import { getLocationSettings, getPresets, type LocationSettings } from './locationStorage';
import { loadCachedCoords, persistCoords, tryGpsCoords, type UserCoords } from './location';
import { type StoreResult } from './basketPricing';

/**
 * ONE pricing path for the store-results map.
 *
 * Entering the map, changing location, toggling saver and pull-to-refresh each
 * used to carry their own copy of "resolve settings → resolve coords → build a
 * candidate pool → POST /calculate → write both cache keys", which is how the
 * entry sequence ended up reading the location settings three times and asking
 * for a GPS fix three times before it drew anything.
 *
 * Split in two so each step is reusable on its own:
 *   · resolveOrigin  — where are we searching from? (mode-aware, one GPS call)
 *   · calculateBasket — price it from a resolved origin and persist the results
 */

export const resultsCacheKey = (basketId: string | number) => `basket_results_${basketId}`;
export const calcMetaCacheKey = (basketId: string | number) => `basket_calc_meta_${basketId}`;

/**
 * ONE-SHOT in-memory handoff of the freshest calc results.
 *
 * The results blob is 250–600 KB for a big basket; serialising + awaiting the
 * AsyncStorage write used to hold the loading modal open after the server had
 * already answered. The write is now fire-and-forget — but the map-entry
 * bootstrap re-reads the same key immediately after a calc, which would race
 * the async write. So `calculateBasket` parks the results here and
 * `takeFreshResults` hands them over ONCE (then falls back to disk).
 *
 * The parked entry SELF-DRAINS when the disk write settles: external
 * invalidators remove the disk key directly (basket/[id], browse, discounts,
 * basketSession), and a memory copy that outlived the write would resurrect
 * results they just invalidated. Draining on flush keeps the handoff alive
 * exactly for the duration of the race it exists to cover.
 */
const freshResults = new Map<string, StoreResult[]>();
export const takeFreshResults = (basketId: string | number): StoreResult[] | null => {
    const key = String(basketId);
    const hit = freshResults.get(key);
    if (!hit) return null;
    freshResults.delete(key);
    return hit;
};

export interface LatLng { lat: number; lng: number }
export interface RouteEndpoints {
    from: { latitude: number; longitude: number };
    to: { latitude: number; longitude: number };
}

export interface ResolvedOrigin {
    /** Search centre — null only when nothing could be resolved. */
    coords: LatLng | null;
    /** Route mode's two endpoints (the map draws the corridor). */
    endpoints: RouteEndpoints | null;
    /** The device fix, when that's where `coords` came from — a preset/route
     *  origin must never be cached as "where the user is". */
    gpsFix: UserCoords | null;
    /** GPS mode with no permission and nothing cached — the caller offers the
     *  manual way out (Place mode) instead of a map centred on nowhere. */
    gpsDenied: boolean;
    settings: LocationSettings;
}

/**
 * Where do we search from, for this shopping's location mode?
 *
 *   current  → cached fix (≤30 min, still "where you are") else a live GPS read
 *   specific → the chosen preset's coordinates
 *   route    → both endpoint presets; the corridor's start is the origin
 *
 * `settings` and `presets` can be passed in when the caller already read them,
 * so a bootstrap doesn't re-read what it just fetched.
 */
export async function resolveOrigin(
    scope: string | number | null,
    pre?: { settings?: LocationSettings; presets?: Awaited<ReturnType<typeof getPresets>> },
): Promise<ResolvedOrigin> {
    const settings = pre?.settings ?? await getLocationSettings(scope);
    let coords: LatLng | null = null;
    let endpoints: RouteEndpoints | null = null;
    let gpsFix: UserCoords | null = null;
    let gpsDenied = false;

    if (settings.mode === 'route' && settings.routeFrom && settings.routeTo) {
        const presets = pre?.presets ?? await getPresets();
        const from = presets[settings.routeFrom];
        const to = presets[settings.routeTo];
        if (from && to) {
            endpoints = {
                from: { latitude: from.lat, longitude: from.lng },
                to: { latitude: to.lat, longitude: to.lng },
            };
            coords = { lat: from.lat, lng: from.lng };
        }
    } else if (settings.mode === 'specific' && settings.specificPreset) {
        const presets = pre?.presets ?? await getPresets();
        const p = presets[settings.specificPreset];
        if (p) coords = { lat: p.lat, lng: p.lng };
    }

    if (!coords && !endpoints) {
        // Cached fix FIRST: it's a real position with a 30-minute TTL, and it
        // saves the entry from waiting on a hardware fix.
        const gps = await loadCachedCoords() ?? await tryGpsCoords().catch(() => null);
        if (gps) { coords = { lat: gps.lat, lng: gps.lng }; gpsFix = gps; }
        else if (settings.mode === 'current') gpsDenied = true;
    }

    return { coords, endpoints, gpsFix, gpsDenied, settings };
}

export interface CalcOutcome {
    results: StoreResult[];
    /** The centre the pool was actually built around (what the map frames). */
    origin: LatLng;
    settings: LocationSettings;
}

/**
 * Price a basket around a resolved origin and persist both cache keys.
 *
 * The candidate pool decides WHICH stores get priced (nearest-N for `current`,
 * around the preset for `specific`, along the corridor for `route`) — posting
 * raw coordinates with no pool is what used to silently revert a place-mode
 * basket to "closest stores around me".
 */
export async function calculateBasket(
    basketId: string | number,
    opts: { coords: LatLng | null; endpoints?: RouteEndpoints | null; saver: boolean; settings?: LocationSettings },
): Promise<CalcOutcome> {
    const [pool, settings] = await Promise.all([
        buildCandidatePool(opts.coords ?? undefined, basketId),
        opts.settings ? Promise.resolve(opts.settings) : getLocationSettings(basketId),
    ]);

    const fallback = opts.endpoints
        ? { lat: opts.endpoints.from.latitude, lng: opts.endpoints.from.longitude }
        : opts.coords;
    const origin = pool.searchCenter ?? fallback;
    if (!origin) throw new Error('no origin');

    const body: Record<string, unknown> = { lat: origin.lat, lng: origin.lng };
    if (pool.storeIds.length > 0) body.storeIds = pool.storeIds;
    if (opts.saver) body.saver = true;

    const res = await fetch(`${API_BASE_URL}/api/baskets/${basketId}/calculate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    // A failed calculate must REJECT, not parse the error envelope as results —
    // basket detail's retry banner and the recipe screen's basket fallback both
    // hang off this throw (the callers' catches already expected it).
    if (!res.ok) throw new Error(`calculate HTTP ${res.status}`);
    const results = await res.json() as StoreResult[];

    // Fire-and-forget persistence: the caller gets its results (and closes its
    // loading modal) without waiting on a multi-hundred-KB serialise + disk
    // write. The immediate re-reader (storeResultsBootstrap) is served from the
    // one-shot in-memory handoff above, so it can't race the write.
    const memKey = String(basketId);
    freshResults.set(memKey, results);
    void AsyncStorage.setItem(resultsCacheKey(basketId), JSON.stringify(results))
        .catch(() => {})
        .finally(() => {
            // Drain the handoff once the disk copy exists (or the write failed) —
            // only delete OUR entry, a newer calc may have re-parked meanwhile.
            if (freshResults.get(memKey) === results) freshResults.delete(memKey);
        });
    void AsyncStorage.setItem(calcMetaCacheKey(basketId), JSON.stringify({
        storeCount: settings.storeCount,
        searchCenter: pool.searchCenter,
        settings,
    })).catch(() => {});

    return { results, origin, settings };
}

/**
 * The full draft→compared comparison from a user position, shared by basket
 * detail's "Rasti parduotuves" and the recipe screen's one-tap "Parduotuvės":
 * price the basket (candidate pool + POST /calculate + both cache keys via
 * calculateBasket), then persist the coords that actually produced these
 * results so re-calcs default to the same viewpoint. Throws on any failure.
 * Screen-side state (status flip, draft-pointer clearing, navigation) stays
 * with each caller — that is the part that legitimately differs between them.
 */
export async function compareBasket(
    basketId: string | number,
    coords: UserCoords,
): Promise<CalcOutcome> {
    const outcome = await calculateBasket(basketId, { coords, saver: false });
    await persistCoords(coords);
    return outcome;
}
