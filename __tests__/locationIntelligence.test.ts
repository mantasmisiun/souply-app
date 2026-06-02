// Mock native modules before any imports that transitively require them
jest.mock('@react-native-async-storage/async-storage', () => ({
    getItem: jest.fn(() => Promise.resolve(null)),
    setItem: jest.fn(() => Promise.resolve()),
    removeItem: jest.fn(() => Promise.resolve()),
    multiGet: jest.fn(() => Promise.resolve([])),
    multiSet: jest.fn(() => Promise.resolve()),
    mergeItem: jest.fn(() => Promise.resolve()),
    clear: jest.fn(() => Promise.resolve()),
    getAllKeys: jest.fn(() => Promise.resolve([])),
}));

import { haversineKm } from '../utils/locationStorage';
import { scoreAllCombinations, type StoreResult } from '../utils/splitBasketScore';

// ---------------------------------------------------------------------------
// haversineKm — used by candidate pool centroid/detour logic
// ---------------------------------------------------------------------------

describe('haversineKm', () => {
    it('returns 0 for identical points', () => {
        expect(haversineKm(54.6872, 25.2797, 54.6872, 25.2797)).toBe(0);
    });

    it('Vilnius → Kaunas is ~100 km', () => {
        const km = haversineKm(54.6872, 25.2797, 54.9, 23.9);
        expect(km).toBeGreaterThan(90);
        expect(km).toBeLessThan(115);
    });

    it('is symmetric', () => {
        const a = haversineKm(54.6, 25.2, 54.7, 25.3);
        const b = haversineKm(54.7, 25.3, 54.6, 25.2);
        expect(Math.abs(a - b)).toBeLessThan(0.001);
    });
});

// ---------------------------------------------------------------------------
// Detour ratio calculation (inline — mirrors candidatePool logic)
// ---------------------------------------------------------------------------

describe('detour ratio corridor', () => {
    const detourRatio = (
        storeLat: number, storeLng: number,
        fromLat: number, fromLng: number,
        toLat: number, toLng: number,
    ) => {
        const direct = haversineKm(fromLat, fromLng, toLat, toLng);
        return (haversineKm(fromLat, fromLng, storeLat, storeLng) +
                haversineKm(storeLat, storeLng, toLat, toLng)) / direct;
    };

    it('midpoint store is always inside corridor (ratio ≈ 1.0)', () => {
        // Store exactly on the straight line between home and work
        const ratio = detourRatio(54.70, 25.30, 54.68, 25.28, 54.72, 25.32);
        expect(ratio).toBeLessThanOrEqual(1.01);
    });

    it('rejects a far-off-route store (ratio > 1.25)', () => {
        // Store far off the corridor
        const ratio = detourRatio(55.0, 25.28, 54.68, 25.28, 54.72, 25.32);
        expect(ratio).toBeGreaterThan(1.25);
    });

    it('accepts a slightly off-route store (ratio ≤ 1.25)', () => {
        // Store slightly off but within 25% overhead
        const ratio = detourRatio(54.70, 25.27, 54.68, 25.28, 54.72, 25.32);
        expect(ratio).toBeLessThanOrEqual(1.25);
    });
});

// ---------------------------------------------------------------------------
// scoreAllCombinations
// ---------------------------------------------------------------------------

function makeStore(id: number, total: number, distance: number, items: { pid: number; price: number | null }[]): StoreResult {
    return {
        storeId: id,
        storeName: `Store ${id}`,
        chainName: `Chain${id}`,
        chainId: id,
        chainLogoUrl: null,
        storeAddress: `Address ${id}`,
        distance,
        total,
        isApproximated: false,
        missingItemNames: [],
        items: items.map(it => ({
            productId: it.pid,
            totalPrice: it.price,
            isMissing: it.price === null,
        })),
    };
}

describe('scoreAllCombinations', () => {
    it('returns empty array for empty stores', () => {
        expect(scoreAllCombinations([], new Set(), 1)).toEqual([]);
    });

    it('single-store combo with storeCount=1 has saving = 0', () => {
        const stores = [makeStore(1, 10, 0.5, [{ pid: 1, price: 10 }])];
        const combos = scoreAllCombinations(stores, new Set(), 1);
        expect(combos.length).toBe(1);
        expect(combos[0].storeIds).toEqual([1]);
        expect(combos[0].saving).toBe(0); // only one store, no comparison
    });

    it('split combo saves when store A is cheaper for item 1 and store B for item 2', () => {
        const stores = [
            makeStore(1, 12, 0.5, [{ pid: 1, price: 3 }, { pid: 2, price: 9 }]),
            makeStore(2, 10, 1.0, [{ pid: 1, price: 7 }, { pid: 2, price: 3 }]),
        ];
        const combos = scoreAllCombinations(stores, new Set(), 2);

        // Find the 2-store combo
        const twoStore = combos.find(c => c.storeIds.length === 2);
        expect(twoStore).toBeDefined();
        // splitTotal = 3 (item 1 from store 1) + 3 (item 2 from store 2) = 6
        expect(twoStore!.splitTotal).toBe(6);
        // Best single = 10 (store 2)
        expect(twoStore!.singleStoreBestTotal).toBe(10);
        expect(twoStore!.saving).toBe(4);
    });

    it('marks hasMissingCritical when critical item absent from all stores in combo', () => {
        const stores = [
            makeStore(1, 5, 0.5, [{ pid: 1, price: 5 }, { pid: 2, price: null }]),
        ];
        const criticalIds = new Set([2]);
        const combos = scoreAllCombinations(stores, criticalIds, 1);
        expect(combos[0].hasMissingCritical).toBe(true);
    });

    it('hasMissingCritical is false when critical item is available in at least one combo store', () => {
        const stores = [
            makeStore(1, 10, 0.5, [{ pid: 1, price: 8 }, { pid: 2, price: null }]),
            makeStore(2, 10, 1.0, [{ pid: 1, price: null }, { pid: 2, price: 4 }]),
        ];
        const criticalIds = new Set([2]);
        const combos = scoreAllCombinations(stores, criticalIds, 2);
        const twoStore = combos.find(c => c.storeIds.length === 2);
        expect(twoStore!.hasMissingCritical).toBe(false);
    });

    it('marks isViable when saving >= 1.50 and extraDistanceKm meets threshold', () => {
        // saving = 4, both stores at 0 extra km from each other (same location) → eurosPerKm = Infinity → viable
        const stores = [
            makeStore(1, 12, 0.5, [{ pid: 1, price: 3 }, { pid: 2, price: 9 }]),
            makeStore(2, 10, 0.5, [{ pid: 1, price: 7 }, { pid: 2, price: 3 }]),
        ];
        const combos = scoreAllCombinations(stores, new Set(), 2);
        const twoStore = combos.find(c => c.storeIds.length === 2);
        expect(twoStore!.saving).toBeGreaterThanOrEqual(1.5);
        expect(twoStore!.isViable).toBe(true);
    });

    it('marks isViable as false when saving < 1.50', () => {
        const stores = [
            makeStore(1, 10.5, 0.5, [{ pid: 1, price: 5 }, { pid: 2, price: 5.5 }]),
            makeStore(2, 10, 1.0, [{ pid: 1, price: 5.2 }, { pid: 2, price: 4.7 }]),
        ];
        const combos = scoreAllCombinations(stores, new Set(), 2);
        const twoStore = combos.find(c => c.storeIds.length === 2);
        // split = 5 + 4.7 = 9.7, best single = 10, saving = 0.3 < 1.50
        expect(twoStore!.saving).toBeLessThan(1.5);
        expect(twoStore!.isViable).toBe(false);
    });

    it('sorts viable combos before non-viable ones', () => {
        const stores = [
            makeStore(1, 20, 0.5, [{ pid: 1, price: 5 }, { pid: 2, price: 15 }]),
            makeStore(2, 12, 0.5, [{ pid: 1, price: 3 }, { pid: 2, price: 9 }]),
            makeStore(3, 10, 0.5, [{ pid: 1, price: 4 }, { pid: 2, price: 6 }]),
        ];
        const combos = scoreAllCombinations(stores, new Set(), 2);
        // First combo should be viable (best saving)
        const firstViableIdx = combos.findIndex(c => c.isViable && c.storeIds.length > 1);
        const firstNonViableIdx = combos.findIndex(c => !c.isViable && c.storeIds.length > 1);
        if (firstViableIdx !== -1 && firstNonViableIdx !== -1) {
            expect(firstViableIdx).toBeLessThan(firstNonViableIdx);
        }
    });

    // Each store is uniquely cheapest for exactly one of three products, so
    // every multi-store split is non-degenerate (no store is "visited for
    // nothing"). This exercises the full combination generator — a basket
    // where only one store ever wins prunes all splits away by design.
    const splitFriendlyStores = () => [
        makeStore(1, 11, 0.5, [{ pid: 1, price: 1 }, { pid: 2, price: 5 }, { pid: 3, price: 5 }]),
        makeStore(2, 11, 0.5, [{ pid: 1, price: 5 }, { pid: 2, price: 1 }, { pid: 3, price: 5 }]),
        makeStore(3, 11, 0.5, [{ pid: 1, price: 5 }, { pid: 2, price: 5 }, { pid: 3, price: 1 }]),
    ];

    it('generates C(3,2) = 3 two-store combos from 3 stores', () => {
        const combos = scoreAllCombinations(splitFriendlyStores(), new Set(), 2);
        const twoStoreCombos = combos.filter(c => c.storeIds.length === 2);
        expect(twoStoreCombos.length).toBe(3);
    });

    it('generates C(3,2) + C(3,3) = 4 multi-store combos for storeCount=3', () => {
        const combos = scoreAllCombinations(splitFriendlyStores(), new Set(), 3);
        const multiStore = combos.filter(c => c.storeIds.length > 1);
        expect(multiStore.length).toBe(4); // C(3,2)=3 + C(3,3)=1
    });
});
