// multiStopRoute → locationStorage (haversineKm) → AsyncStorage, which has no
// native module under jest. Mock it so the pure routing helpers can be tested.
import { orderStopsNearestFirst, orderStopsAlongRoute, buildGoogleMapsRouteUrl } from '../utils/multiStopRoute';

jest.mock('@react-native-async-storage/async-storage', () =>
    require('@react-native-async-storage/async-storage/jest/async-storage-mock'));

const at = (latitude: number, longitude: number) => ({ latitude, longitude });

describe('orderStopsAlongRoute', () => {
    const from = at(0, 0);
    const to = at(0, 10); // travelling east along the equator

    it('orders stops by progress from start toward destination', () => {
        const stops = [at(0, 8), at(0, 2), at(0, 5)];
        const ordered = orderStopsAlongRoute(from, to, stops);
        expect(ordered.map(s => s.longitude)).toEqual([2, 5, 8]);
    });

    it('2-store case: nearest-to-start first, nearest-to-end second', () => {
        const a = at(0.1, 3);  // closer to start
        const b = at(-0.1, 7); // closer to destination
        const ordered = orderStopsAlongRoute(from, to, [b, a]);
        expect(ordered[0]).toBe(a);
        expect(ordered[1]).toBe(b);
    });

    it('passes through 0/1 stops unchanged', () => {
        expect(orderStopsAlongRoute(from, to, [])).toEqual([]);
        const one = [at(0, 4)];
        expect(orderStopsAlongRoute(from, to, one)).toEqual(one);
    });
});

describe('buildGoogleMapsRouteUrl (route mode: from → stops → to)', () => {
    it('makes the LAST stop the destination and the rest waypoints', () => {
        const from = at(54.7, 25.2);
        const to = at(54.9, 25.4);
        const stores = [at(54.75, 25.25), at(54.85, 25.35)];
        const url = buildGoogleMapsRouteUrl(from, [...stores, to]);
        expect(url).toContain('origin=54.7,25.2');
        expect(url).toContain('destination=54.9,25.4');           // routeTo
        expect(url).toContain('waypoints=54.75,25.25|54.85,25.35'); // the stores
    });
});

describe('orderStopsNearestFirst (single-origin modes)', () => {
    it('greedily visits the nearest unvisited store', () => {
        const origin = at(0, 0);
        const ordered = orderStopsNearestFirst(origin, [at(0, 9), at(0, 1), at(0, 3)]);
        expect(ordered.map(s => s.longitude)).toEqual([1, 3, 9]);
    });
});
