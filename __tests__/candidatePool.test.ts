import { nearestPool } from '../utils/candidatePool';

// Stores laid out due-north of a fixed centre so distance ≈ the `km` argument
// (1° latitude ≈ 111.32 km), which makes distance order == insertion order and
// the 10 km ceiling deterministic.
const CENTER = { lat: 54.7, lng: 25.3 };
const KM_PER_DEG_LAT = 111.32;
let nextId = 1;
function store(chainId: number, km: number) {
    return {
        id: nextId++,
        chainId,
        name: 's',
        address: '',
        latitude: CENTER.lat + km / KM_PER_DEG_LAT,
        longitude: CENTER.lng,
        chainName: `chain${chainId}`,
        logoUrl: null,
    };
}
const chainCounts = (pool: { chainId: number }[]) => {
    const m = new Map<number, number>();
    for (const s of pool) m.set(s.chainId, (m.get(s.chainId) ?? 0) + 1);
    return m;
};

describe('nearestPool', () => {
    beforeEach(() => { nextId = 1; });

    it('excludes stores beyond the 10 km ceiling', () => {
        const near = store(1, 2);
        const far = store(1, 22);
        const ids = nearestPool(CENTER, [near, far]).map(s => s.id);
        expect(ids).toContain(near.id);
        expect(ids).not.toContain(far.id);
    });

    it('caps one chain at 3 branches and keeps the nearest three', () => {
        const iki = Array.from({ length: 6 }, (_, i) => store(3, 0.2 * (i + 1)));
        const pool = nearestPool(CENTER, iki);
        expect(pool.length).toBe(3);
        expect(pool.map(s => s.id).sort((a, b) => a - b)).toEqual(iki.slice(0, 3).map(s => s.id));
    });

    it('keeps a genuine small/medium/large trio when they are nearest (Šiauliai IKIs)', () => {
        const iki = [store(3, 0.3), store(3, 0.6), store(3, 1.0)];
        const others = [store(1, 1.5), store(2, 2.0)];
        const cc = chainCounts(nearestPool(CENTER, [...iki, ...others]));
        expect(cc.get(3)).toBe(3);
        expect(cc.get(1)).toBe(1);
        expect(cc.get(2)).toBe(1);
    });

    it('bounds dense duplication: 5 Rimi + 5 IKI → at most 3 each (Vilnius)', () => {
        const rimi = Array.from({ length: 5 }, (_, i) => store(1, 0.2 * (i + 1)));
        const iki = Array.from({ length: 5 }, (_, i) => store(3, 0.25 * (i + 1)));
        const maxima = [store(2, 0.1)];
        const cc = chainCounts(nearestPool(CENTER, [...rimi, ...iki, ...maxima]));
        expect(cc.get(1)).toBeLessThanOrEqual(3);
        expect(cc.get(3)).toBeLessThanOrEqual(3);
        expect(cc.get(2)).toBe(1);
    });

    it('guarantees the nearest branch of every in-range chain (combo diversity)', () => {
        const dense = [
            ...Array.from({ length: 6 }, (_, i) => store(1, 0.2 * (i + 1))),
            ...Array.from({ length: 6 }, (_, i) => store(2, 0.22 * (i + 1))),
        ];
        const farChain = store(3, 8); // in range, but past the dense near cluster
        const pool = nearestPool(CENTER, [...dense, farChain]);
        expect(pool.map(s => s.id)).toContain(farChain.id);
        const cc = chainCounts(pool);
        expect(cc.get(1)).toBeLessThanOrEqual(3);
        expect(cc.get(2)).toBeLessThanOrEqual(3);
        expect(cc.get(3)).toBe(1);
    });

    it('drops a chain with no branch inside the ceiling (not viable — no fan-out)', () => {
        const near = store(1, 2);
        const outOfRange = store(9, 15);
        expect(nearestPool(CENTER, [near, outOfRange]).map(s => s.chainId)).not.toContain(9);
    });

    it('represents every chain when each has a single nearby branch', () => {
        const stores = Array.from({ length: 8 }, (_, i) => store(i + 1, 0.3 * (i + 1)));
        expect(nearestPool(CENTER, stores).length).toBe(8);
    });
});
