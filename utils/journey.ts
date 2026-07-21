import { haversineKm } from './locationStorage';
import { orderStopsNearestFirst, orderStopsAlongRoute } from './multiStopRoute';

export type JourneyPoint = { latitude: number; longitude: number };

/** Just enough of a store to place it on the map. */
export type StoreLike = { latitude: number | null; longitude: number | null };

/**
 * The two location modes the results map runs in:
 *  · GPS / PLACE — a single `origin` endpoint (current location or a chosen place).
 *  · ROUTE       — `routeEndpoints` from→to (shop on the way between two places).
 * Exactly one is non-null in practice; route wins if both are given.
 */
export interface JourneyContext {
    origin: { lat: number; lng: number } | null;
    routeEndpoints: { from: JourneyPoint; to: JourneyPoint } | null;
}

/**
 * Ordered travel coordinates for a set of stores:
 *  · ROUTE:      from → stores (ordered along the way) → to.
 *  · GPS/PLACE:  origin → stores (nearest-first). Ends at the LAST store.
 * Returns null when there aren't two points to connect (no origin + one store).
 */
export function buildJourneyCoords(stores: StoreLike[], ctx: JourneyContext): JourneyPoint[] | null {
    const stops = stores
        .filter(s => s.latitude != null && s.longitude != null)
        .map(s => ({ latitude: s.latitude as number, longitude: s.longitude as number }));
    if (stops.length === 0) return null;
    if (ctx.routeEndpoints) {
        const ordered = orderStopsAlongRoute(ctx.routeEndpoints.from, ctx.routeEndpoints.to, stops);
        return [ctx.routeEndpoints.from, ...ordered, ctx.routeEndpoints.to];
    }
    const origin = ctx.origin ? { latitude: ctx.origin.lat, longitude: ctx.origin.lng } : null;
    if (!origin && stops.length < 2) return null;
    const ordered = orderStopsNearestFirst(origin, stops);
    return origin ? [origin, ...ordered] : ordered;
}

/** Sum the ordered legs of a journey (origin → stores → [route end]). */
export function sumJourneyKm(coords: JourneyPoint[] | null): number | null {
    if (!coords || coords.length < 2) return null;
    let km = 0;
    for (let i = 0; i < coords.length - 1; i++) {
        km += haversineKm(coords[i].latitude, coords[i].longitude, coords[i + 1].latitude, coords[i + 1].longitude);
    }
    return km;
}

/**
 * Whole-journey distance for a set of stores under the current location mode —
 * GPS/place: origin → stores → last store; route: from → stores → to. This is the
 * "how far" the sheet bar and single-store option card show (not a radial leg).
 */
export function journeyKmForStores(stores: StoreLike[], ctx: JourneyContext): number | null {
    return sumJourneyKm(buildJourneyCoords(stores, ctx));
}
