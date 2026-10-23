import { journeyKmForStores, buildJourneyCoords, type StoreLike, type JourneyContext } from '../utils/journey';

// Stores placed due-NORTH of a fixed origin so distance ≈ the km argument
// (1° latitude ≈ 111.32 km) and nearest-first / along-route ordering are both
// simply "by km north ascending" — deterministic and hand-checkable.
const KM = 111.32;
const O = { lat: 54.7, lng: 25.3 };
const S = (km: number): StoreLike => ({ latitude: O.lat + km / KM, longitude: O.lng });

const gps: JourneyContext = { origin: O, routeEndpoints: null };
const route: JourneyContext = {
    origin: null,
    routeEndpoints: {
        from: { latitude: O.lat, longitude: O.lng },
        to: { latitude: O.lat + 5 / KM, longitude: O.lng }, // 5 km north of the start
    },
};

describe('journey — GPS / place mode (origin → stores, ends at last store)', () => {
    it('1 store: start → store', () => {
        expect(journeyKmForStores([S(2)], gps)).toBeCloseTo(2, 1);
    });
    it('2 stores: start → nearest → next (order-independent input)', () => {
        expect(journeyKmForStores([S(3), S(1)], gps)).toBeCloseTo(3, 1); // 1 + 2
    });
    it('3 stores: nearest-first chain', () => {
        expect(journeyKmForStores([S(4), S(1), S(2)], gps)).toBeCloseTo(4, 1); // 1 + 1 + 2
    });
});

describe('journey — route mode (start → stores along the way → end)', () => {
    it('1 store: start → store → end (the single-store option case)', () => {
        expect(journeyKmForStores([S(2)], route)).toBeCloseTo(5, 1); // 2 + 3
    });
    it('2 stores ordered along the route', () => {
        expect(journeyKmForStores([S(3), S(1)], route)).toBeCloseTo(5, 1); // 1 + 2 + 2
    });
    it('3 stores: start → … → end', () => {
        expect(journeyKmForStores([S(1), S(2), S(4)], route)).toBeCloseTo(5, 1); // 1 + 1 + 2 + 1
    });
    it('a store behind the start still routes start → store → end (adds a detour)', () => {
        // Store 1 km SOUTH of start (behind). from→S(-1)=1, S(-1)→to(5)=6 → 7 km.
        expect(journeyKmForStores([S(-1)], route)).toBeCloseTo(7, 1);
    });
});

describe('journey — edge cases', () => {
    it('no origin + a single store → null (nothing to connect)', () => {
        expect(journeyKmForStores([S(2)], { origin: null, routeEndpoints: null })).toBeNull();
    });
    it('no origin + 2 stores → the leg between the stores', () => {
        expect(journeyKmForStores([S(1), S(3)], { origin: null, routeEndpoints: null })).toBeCloseTo(2, 1);
    });
    it('stores with null coordinates are ignored', () => {
        const withNull: StoreLike[] = [{ latitude: null, longitude: null }, S(2)];
        expect(journeyKmForStores(withNull, gps)).toBeCloseTo(2, 1);
    });
    it('no stores at all → null', () => {
        expect(journeyKmForStores([], gps)).toBeNull();
        expect(buildJourneyCoords([], route)).toBeNull();
    });
    it('route coords bracket the stores with the endpoints', () => {
        const coords = buildJourneyCoords([S(1)], route)!;
        expect(coords[0]).toEqual(route.routeEndpoints!.from);
        expect(coords[coords.length - 1]).toEqual(route.routeEndpoints!.to);
    });
});
