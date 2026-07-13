import {
    buildSplitOptions,
    bestSplitOption,
    savingBaseline,
    comboKey,
    TRIP_RADIUS_KM,
    type SheetOption,
} from '../utils/splitOptions';
import { type StoreResult } from '../utils/basketPricing';
import { type ScoredCombo } from '../utils/splitBasketScore';

// ── mock builders ─────────────────────────────────────────────────────────
function store(storeId: number, total: number, opts: { missing?: number; chainId?: number; distance?: number } = {}): StoreResult {
    return {
        storeId,
        storeName: `Store ${storeId}`,
        chainName: `Chain ${opts.chainId ?? storeId}`,
        chainId: opts.chainId ?? storeId,
        chainLogoUrl: null,
        chainMiniLogoUrl: null,
        storeAddress: `Addr ${storeId}`,
        latitude: 54 + storeId / 100,
        longitude: 25 + storeId / 100,
        distance: opts.distance ?? 1,
        total,
        isApproximated: false,
        missingItemNames: Array.from({ length: opts.missing ?? 0 }, (_, i) => `m${i}`),
        items: [],
    };
}

function combo(storeIds: number[], splitTotal: number, opts: { extraDistanceKm?: number; isViable?: boolean; saving?: number; chainIds?: number[] } = {}): ScoredCombo {
    return {
        storeIds,
        stores: storeIds.map((id, i) => ({
            storeId: id, storeName: `Store ${id}`, chainName: `Chain ${id}`, chainId: opts.chainIds?.[i] ?? id,
            chainLogoUrl: null, storeAddress: `Addr ${id}`, latitude: 54, longitude: 25,
            distance: 1, total: splitTotal, isApproximated: false, missingItemNames: [], items: [],
        })),
        splitTotal,
        singleStoreBestTotal: 30,
        saving: opts.saving ?? 0,
        extraDistanceKm: opts.extraDistanceKm ?? 2,
        eurosPerKm: 1,
        isViable: opts.isViable ?? false,
        hasMissingCritical: false,
        itemAssignments: {},
    };
}

// Three full-coverage single stores around the user.
const results: StoreResult[] = [store(1, 30), store(2, 34), store(3, 36)];
// baseline = avg(30,34,36) = 33.333…

describe('savingBaseline', () => {
    it('averages full-coverage stores, ignoring partial ones', () => {
        const mixed = [store(1, 30), store(2, 34), store(9, 5, { missing: 6 })];
        expect(savingBaseline(mixed)).toBeCloseTo(32, 5); // (30+34)/2, the partial €5 store excluded
    });
    it('falls back to all stores when none are full-coverage', () => {
        expect(savingBaseline([store(9, 10, { missing: 2 }), store(8, 20, { missing: 1 })])).toBeCloseTo(15, 5);
    });
    it('returns null with no stores', () => {
        expect(savingBaseline([])).toBeNull();
    });
});

describe('buildSplitOptions', () => {
    it('surfaces a near split even when the old viability gate would reject it', () => {
        const combos = [combo([1, 2], 28, { extraDistanceKm: 5, isViable: false })];
        const opts = buildSplitOptions(combos, results, [], 1);
        // first = the split, last = single baseline
        expect(opts[0].combo).not.toBeNull();
        expect(opts[0].storeIds).toEqual([1, 2]);
        expect(opts[opts.length - 1].combo).toBeNull();
        expect(opts[opts.length - 1].storeIds).toEqual([1]);
    });

    it('excludes cross-city combos beyond the 10km trip radius (Šiauliai→Vilnius case)', () => {
        // store 99 is a far (Vilnius) store the user lazily priced; pairing it with
        // a Šiauliai store yields a ~190km combo that must NOT be offered.
        const far = store(99, 27, { distance: 190 });
        const combos = [combo([1, 99], 27, { extraDistanceKm: 190, isViable: false })];
        const opts = buildSplitOptions(combos, results, [far], 99);
        // only the single-store option for 99 — no cross-city split
        expect(opts).toHaveLength(1);
        expect(opts[0].combo).toBeNull();
        expect(opts[0].storeIds).toEqual([99]);
    });

    it('computes saving vs the tapped single store, floored at 0', () => {
        // Saving is measured against the tapped store's OWN total (store 1 = €30),
        // not an average baseline — so an equal-or-worse split shows €0.
        const combos = [
            combo([1, 2], 28, { extraDistanceKm: 4 }),   // 30 - 28 = 2.00
            combo([1, 3], 40, { extraDistanceKm: 4 }),   // 30 - 40 < 0 → floored to 0
        ];
        const opts = buildSplitOptions(combos, results, [], 1);
        const s12 = opts.find(o => o.key === comboKey([1, 2]))!;
        const s13 = opts.find(o => o.key === comboKey([1, 3]))!;
        expect(s12.saving).toBeCloseTo(2, 2);
        expect(s13.saving).toBe(0);
    });

    it('dedups combos with the same store set and caps at 4 splits + single', () => {
        const combos = [
            combo([1, 2], 28, { extraDistanceKm: 2 }),
            combo([2, 1], 28, { extraDistanceKm: 2 }), // same set, different order → dedup
            combo([1, 3], 29, { extraDistanceKm: 2 }),
        ];
        const opts = buildSplitOptions(combos, results, [], 1);
        const multis = opts.filter(o => o.combo);
        expect(multis).toHaveLength(2); // [1,2] and [1,3], the duplicate dropped
        expect(opts[opts.length - 1].combo).toBeNull(); // single baseline last
    });

    it('collapses same-chain same-total splits to the closest, dropping further duplicates', () => {
        const res = [store(10, 30), store(20, 34), store(21, 34)];
        // Both are Maxima(1)+Rimi(2) at €28 and include the tapped store 10; the
        // second uses a further Rimi (more extra travel) → must be dropped.
        const near = combo([10, 20], 28, { extraDistanceKm: 3, chainIds: [1, 2] });
        const far = combo([10, 21], 28, { extraDistanceKm: 8, chainIds: [1, 2] });
        const opts = buildSplitOptions([near, far], res, [], 10);
        const multis = opts.filter(o => o.combo);
        expect(multis).toHaveLength(1);
        expect(multis[0].storeIds).toEqual([10, 20]); // the closer variant kept
    });

    it('only returns combos that include the tapped store', () => {
        const combos = [combo([2, 3], 30, { extraDistanceKm: 2 })]; // does not include store 1
        const opts = buildSplitOptions(combos, results, [], 1);
        expect(opts.every(o => o.storeIds.includes(1))).toBe(true); // → just the single for store 1
        expect(opts).toHaveLength(1);
    });
});

describe('bestSplitOption', () => {
    it('returns the top in-radius split for auto-select', () => {
        const combos = [
            combo([1, 99], 26, { extraDistanceKm: 190 }), // out of radius, ranked first
            combo([1, 2], 28, { extraDistanceKm: 4 }),    // first in-radius multi
        ];
        const best = bestSplitOption(combos, [...results, store(99, 27, { distance: 190 })], []);
        expect(best).not.toBeNull();
        expect(best!.storeIds).toEqual([1, 2]);
    });

    it('returns null when no split is within the trip radius', () => {
        const combos = [combo([1, 99], 26, { extraDistanceKm: 190 })];
        expect(bestSplitOption(combos, results, [])).toBeNull();
    });
});

describe('TRIP_RADIUS_KM', () => {
    it('is the agreed 10km one-trip cap', () => {
        expect(TRIP_RADIUS_KM).toBe(10);
    });
});
