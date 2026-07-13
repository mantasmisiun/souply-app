/**
 * Zero-dependency grid clustering for the results map's all-Lithuania store
 * directory. We deliberately avoid `react-native-map-clustering` (unmaintained,
 * shaky on the new architecture) and `supercluster` (extra native-free dep but
 * still a build bump) — for a few thousand near-static points a viewport-grid
 * pass is sub-millisecond and ships over OTA with no rebuild.
 *
 * The grid is WORLD-ANCHORED and LEVEL-QUANTIZED (the tile-system approach):
 * cell size derives from floor(log2(longitudeDelta)), so it is CONSTANT within
 * a zoom level and the bucketing cannot change while zooming inside one. A
 * continuously-scaled cell (the old `delta / COLS`) made the grid boundaries
 * SWEEP across the stores during a pinch — nearby stores flapped between one
 * cell and two, so bubbles dissolved into logos and re-formed repeatedly
 * (nauseating). Now membership changes only at discrete level crossings
 * (~once per zoom doubling) — one clean split/merge per crossing.
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
// Zoomed in past this longitude span (≈ a few neighbourhoods) we stop
// clustering entirely so every store is individually tappable. Deliberately
// TIGHT: unpacking at district level (the old 0.045) scattered logos too
// early, and at those zooms the overlay's per-frame lag is more pixels — the
// logos "decoupled" during fast drags.
const SINGLES_BELOW_DELTA = 0.02;
// Render margin beyond the visible edges (fraction of a viewport per side) —
// ZOOM-DEPENDENT: at cluster zooms dots are few, so a wide margin keeps pans
// hole-free with negligible cost; at dense logo zooms (Vilnius) every mounted
// dot costs a per-frame worklet, so the margin stays tight and mid-gesture
// pan commits fill the edges instead.
const MARGIN_WIDE = 0.75;
const MARGIN_TIGHT = 0.2;
const marginFor = (longitudeDelta: number): number =>
    longitudeDelta > SINGLES_BELOW_DELTA * 8 ? MARGIN_WIDE : MARGIN_TIGHT;
// Safety cap on individual markers so a dense zoom never floods the map view.
const MAX_SINGLES = 80;

/**
 * Identity of the bucketing REGIME for a zoom: the quantized level, or the
 * singles mode. While this key is unchanged, zooming cannot alter the
 * clustering — callers use it to skip pointless mid-gesture recomputes.
 */
export function bucketingKey(longitudeDelta: number): string {
    return longitudeDelta <= SINGLES_BELOW_DELTA ? 'singles' : `L${Math.floor(Math.log2(longitudeDelta))}`;
}

/**
 * Bucket `points` into clusters + singles for the given map `region`. Only
 * points within the (margin-padded) viewport are considered; off-screen markers
 * would never paint anyway and bucketing them just wastes work.
 */
export function clusterByGrid<T extends GeoPoint>(points: T[], region: GridRegion): ClusterResult<T> {
    if (points.length === 0) return { clusters: [], singles: [] };

    const { latitude, longitude, latitudeDelta, longitudeDelta } = region;
    const margin = marginFor(longitudeDelta);
    const latPad = latitudeDelta * (0.5 + margin);
    const lngPad = longitudeDelta * (0.5 + margin);
    const latMin = latitude - latPad, latMax = latitude + latPad;
    const lngMin = longitude - lngPad, lngMax = longitude + lngPad;

    const inView = points.filter(
        p => p.latitude >= latMin && p.latitude <= latMax && p.longitude >= lngMin && p.longitude <= lngMax,
    );

    // Zoomed in far enough → no clustering, just the (capped) individual stores.
    if (longitudeDelta <= SINGLES_BELOW_DELTA) {
        return { clusters: [], singles: inView.slice(0, MAX_SINGLES) };
    }

    // LEVEL-QUANTIZED cell size: constant across a whole zoom level, so the
    // grid (and therefore every bubble's membership) is FROZEN while zooming
    // within it. Cell keys carry the level — cell indices from different
    // levels must never collide.
    const level = Math.floor(Math.log2(longitudeDelta));
    const cell = Math.pow(2, level) / COLS;
    const buckets = new Map<string, T[]>();
    for (const p of inView) {
        const key = `${level}:${Math.floor(p.latitude / cell)}:${Math.floor(p.longitude / cell)}`;
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
    if (singles.length > MAX_SINGLES) {
        // NEAREST-to-centre, not first-N: slicing in master-array order made
        // the surviving set non-spatial — each pan changed WHICH stores made
        // the cap, churning mounts far away from the pan edge. Nearest-centre
        // keeps the set stable except at the actual edges.
        singles = singles
            .map(s => ({ s, d: (s.latitude - latitude) ** 2 + (s.longitude - longitude) ** 2 }))
            .sort((a, b) => a.d - b.d)
            .slice(0, MAX_SINGLES)
            .map(x => x.s);
    }
    return { clusters, singles };
}
