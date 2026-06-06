/**
 * Zero-dependency grid clustering for the results map's all-Lithuania store
 * directory. We deliberately avoid `react-native-map-clustering` (unmaintained,
 * shaky on the new architecture) and `supercluster` (extra native-free dep but
 * still a build bump) — for a few thousand near-static points a viewport-grid
 * pass is sub-millisecond and ships over OTA with no rebuild.
 *
 * The grid cell scales with the current zoom (longitudeDelta), so the same
 * algorithm yields a handful of big bubbles when zoomed out to the whole
 * country and resolves into individual stores as the user zooms into a city.
 */
export interface GridRegion {
    latitude: number;
    longitude: number;
    latitudeDelta: number;
    longitudeDelta: number;
}

export interface GeoPoint {
    id: number;
    latitude: number;
    longitude: number;
}

export interface Cluster {
    id: string;
    latitude: number;
    longitude: number;
    count: number;
    pointIds: number[];
}

export interface ClusterResult<T extends GeoPoint> {
    clusters: Cluster[];
    singles: T[];
}

// ~7 cells across the viewport width — a comfortable bubble density.
const COLS = 7;
// Zoomed in past this longitude span (≈ city-district level) we stop clustering
// entirely so every store is individually tappable, even neighbours in one plaza.
const SINGLES_BELOW_DELTA = 0.045;
// Render a margin beyond the visible edges so a small pan doesn't reveal blanks.
const VIEWPORT_MARGIN = 0.25;
// Safety cap on individual markers so a dense zoom never floods the map view.
const MAX_SINGLES = 160;

/**
 * Bucket `points` into clusters + singles for the given map `region`. Only
 * points within the (margin-padded) viewport are considered; off-screen markers
 * would never paint anyway and bucketing them just wastes work.
 */
export function clusterByGrid<T extends GeoPoint>(points: T[], region: GridRegion): ClusterResult<T> {
    if (points.length === 0) return { clusters: [], singles: [] };

    const { latitude, longitude, latitudeDelta, longitudeDelta } = region;
    const latPad = latitudeDelta * (0.5 + VIEWPORT_MARGIN);
    const lngPad = longitudeDelta * (0.5 + VIEWPORT_MARGIN);
    const latMin = latitude - latPad, latMax = latitude + latPad;
    const lngMin = longitude - lngPad, lngMax = longitude + lngPad;

    const inView = points.filter(
        p => p.latitude >= latMin && p.latitude <= latMax && p.longitude >= lngMin && p.longitude <= lngMax,
    );

    // Zoomed in far enough → no clustering, just the (capped) individual stores.
    if (longitudeDelta <= SINGLES_BELOW_DELTA) {
        return { clusters: [], singles: inView.slice(0, MAX_SINGLES) };
    }

    const cell = longitudeDelta / COLS;
    const buckets = new Map<string, T[]>();
    for (const p of inView) {
        const key = `${Math.floor(p.latitude / cell)}:${Math.floor(p.longitude / cell)}`;
        const arr = buckets.get(key);
        if (arr) arr.push(p);
        else buckets.set(key, [p]);
    }

    const clusters: Cluster[] = [];
    let singles: T[] = [];
    for (const [key, arr] of buckets) {
        if (arr.length === 1) {
            singles.push(arr[0]);
            continue;
        }
        let sLat = 0, sLng = 0;
        for (const p of arr) { sLat += p.latitude; sLng += p.longitude; }
        clusters.push({
            id: key,
            latitude: sLat / arr.length,
            longitude: sLng / arr.length,
            count: arr.length,
            pointIds: arr.map(p => p.id),
        });
    }
    if (singles.length > MAX_SINGLES) singles = singles.slice(0, MAX_SINGLES);
    return { clusters, singles };
}
