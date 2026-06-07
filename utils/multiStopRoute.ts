import { haversineKm } from './locationStorage';

/**
 * Multi-stop routing helpers for the "Vykti" action on a split combo: order the
 * stores into a sensible visiting sequence and hand off to Google Maps as a
 * single driving route (you → store A → store B …).
 */
export interface RouteStop {
    latitude: number;
    longitude: number;
}

export interface LatLngOrigin {
    latitude: number;
    longitude: number;
}

/**
 * Greedy nearest-neighbour ordering from `origin` (the user). For the 2–3 stops
 * a split combo ever has this is the optimal tour; we don't need a full TSP.
 * Falls back to the first stop as the start point when we have no user location.
 */
export function orderStopsNearestFirst<T extends RouteStop>(
    origin: LatLngOrigin | null,
    stops: T[],
): T[] {
    if (stops.length <= 1) return [...stops];
    const remaining = [...stops];
    const ordered: T[] = [];
    let cur: RouteStop = origin ?? remaining[0];
    while (remaining.length) {
        let bestIdx = 0;
        let bestD = Infinity;
        for (let i = 0; i < remaining.length; i++) {
            const d = haversineKm(cur.latitude, cur.longitude, remaining[i].latitude, remaining[i].longitude);
            if (d < bestD) { bestD = d; bestIdx = i; }
        }
        const [next] = remaining.splice(bestIdx, 1);
        ordered.push(next);
        cur = next;
    }
    return ordered;
}

/**
 * Order stops by their progress along the `from`→`to` direction (projection
 * onto the route vector), so a trip from A to B passes them start→end: the stop
 * nearest the start first, the one nearest the destination last. Used by route
 * mode (shop along the way between two locations). Treats lat/lng as planar —
 * fine at city scale.
 */
export function orderStopsAlongRoute<T extends RouteStop>(
    from: RouteStop,
    to: RouteStop,
    stops: T[],
): T[] {
    if (stops.length <= 1) return [...stops];
    const dx = to.longitude - from.longitude;
    const dy = to.latitude - from.latitude;
    const proj = (s: RouteStop) =>
        (s.longitude - from.longitude) * dx + (s.latitude - from.latitude) * dy;
    return [...stops].sort((a, b) => proj(a) - proj(b));
}

/**
 * Build a Google Maps directions URL for an ordered multi-stop driving route.
 * Uses lat,lng coordinates (not addresses) so the handoff is exact. The last
 * stop is the destination; everything before it becomes `waypoints` in order.
 * Coordinates and the `|` waypoint separator are left unencoded — that's the
 * format Google's Maps URL API documents and parses.
 */
export function buildGoogleMapsRouteUrl(
    origin: LatLngOrigin | null,
    orderedStops: RouteStop[],
): string {
    const fmt = (p: RouteStop) => `${p.latitude},${p.longitude}`;
    let url = 'https://www.google.com/maps/dir/?api=1&travelmode=driving';
    if (origin) url += `&origin=${fmt(origin)}`;
    const dest = orderedStops[orderedStops.length - 1];
    url += `&destination=${fmt(dest)}`;
    const waypoints = orderedStops.slice(0, -1);
    if (waypoints.length) url += `&waypoints=${waypoints.map(fmt).join('|')}`;
    return url;
}
