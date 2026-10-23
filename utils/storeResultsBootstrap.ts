import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocationSettings } from './locationStorage';
import { persistCoords } from './location';
import {
    calculateBasket, resolveOrigin, resultsCacheKey, takeFreshResults,
    type LatLng, type RouteEndpoints,
} from './basketCalc';
import { type StoreResult } from './basketPricing';

/**
 * THE map-entry sequence, in one place and one pass.
 *
 * What the user saw before: a white screen with a spinner, then a map dropped on
 * Vilnius behind a loading modal, then a jump to their location, then the modal
 * AGAIN, then a zoom-out as the pills finally appeared. That wasn't four steps of
 * work — it was one job done in four uncoordinated pieces:
 *
 *   · the screen read the location settings, then the calc read them again, and
 *     the candidate pool read them a third time;
 *   · the origin (GPS) was resolved by the screen, thrown away, then resolved
 *     again by the recalc — up to three fixes for one entry;
 *   · `loading` was cleared BETWEEN the cache read and the calculation, so the
 *     modal closed and reopened;
 *   · the map mounted before any of it finished, so its camera framed the only
 *     thing it had — a hardcoded Vilnius — and every later arrival moved it.
 *
 * So this resolves everything ONCE, in order, and returns a single snapshot the
 * screen renders in one go: settings → origin → cached results (or one
 * calculation from that same origin). The caller keeps its loading state up for
 * the whole call, and the map only mounts once there is something real to frame.
 */
export interface StoreResultsSnapshot {
    results: StoreResult[];
    /** Map centre + calc origin. Null when nothing could be resolved. */
    origin: LatLng | null;
    /** Route mode's corridor endpoints (map draws the leg). */
    endpoints: RouteEndpoints | null;
    /** Place mode pins its origin; GPS/route modes don't. */
    originPin: { latitude: number; longitude: number } | null;
    maxStores: 1 | 2 | 3;
    /** GPS mode, no permission, nothing cached → the caller flips to Place mode. */
    gpsDenied: boolean;
    /** True when this entry had to price the basket (no usable cache). */
    calculated: boolean;
}

export async function bootstrapStoreResults(
    basketId: string,
    opts: { saver: boolean; allowCalc: boolean },
): Promise<StoreResultsSnapshot> {
    // 1. Everything on disk, in parallel. A calc that JUST finished hands its
    //    results over in memory (one-shot) — calculateBasket's disk write is
    //    fire-and-forget now, so reading the key straight away could race it.
    const fresh = takeFreshResults(basketId);
    const [storedRaw, settings] = await Promise.all([
        fresh ? Promise.resolve(null) : AsyncStorage.getItem(resultsCacheKey(basketId)),
        getLocationSettings(basketId),
    ]);
    const maxStores: 1 | 2 | 3 = settings.storeCount === 1 ? 1 : settings.storeCount === 2 ? 2 : 3;
    let results: StoreResult[] = fresh ?? [];
    if (!fresh) {
        try { results = storedRaw ? JSON.parse(storedRaw) as StoreResult[] : []; } catch { results = []; }
    }

    // 2. Where are we searching from? ONE resolution, reused by the calc below.
    //    (The calc meta's frozen searchCenter is deliberately not used as the map
    //    centre: it has no TTL, so it could drop the map wherever you stood days
    //    ago while the panel still correctly read "GPS".)
    const origin = await resolveOrigin(basketId, { settings });
    if (origin.gpsFix) void persistCoords(origin.gpsFix);

    const snapshot: StoreResultsSnapshot = {
        results,
        origin: origin.coords,
        endpoints: origin.endpoints,
        originPin: settings.mode === 'specific' && origin.coords
            ? { latitude: origin.coords.lat, longitude: origin.coords.lng }
            : null,
        maxStores,
        gpsDenied: origin.gpsDenied,
        calculated: false,
    };

    // 3. No cached prices → price it now, from the origin we just resolved. This
    //    is why the modal can stay up exactly once: the caller never sees a gap
    //    between "loaded the cache" and "started the calc".
    const needsCalc = results.length === 0 && !origin.gpsDenied && opts.allowCalc;
    if (!needsCalc) return snapshot;

    try {
        const calc = await calculateBasket(basketId, {
            coords: origin.coords,
            endpoints: origin.endpoints,
            saver: opts.saver,
            settings,
        });
        return { ...snapshot, results: calc.results, origin: calc.origin, calculated: true };
    } catch {
        // Keep whatever we resolved — the map still opens on the right place,
        // just without prices, and the user can pull to retry.
        return snapshot;
    }
}
