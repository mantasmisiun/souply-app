import AsyncStorage from '@react-native-async-storage/async-storage';
import { bootstrapStoreResults } from '../utils/storeResultsBootstrap';
import { resolveOrigin, calculateBasket } from '../utils/basketCalc';
import * as location from '../utils/location';
import * as locationStorage from '../utils/locationStorage';
import * as candidatePool from '../utils/candidatePool';

/**
 * MAP ENTRY — one pass, one origin, one loading state.
 *
 * Tapping "Parduotuvės ›" used to show: a white spinner screen → a map on
 * Vilnius behind a loading modal → a jump to the user's location → the modal
 * AGAIN for the calculation → a zoom-out as pills appeared. The work behind that
 * was duplicated, not sequential: the settings were read three times, the GPS
 * fix resolved up to three times, and `loading` was cleared between the cache
 * read and the calculation (which is what re-opened the modal).
 *
 * These tests pin the contract that removes it: ONE settings read, ONE origin
 * resolution reused by the calculation, and a single snapshot the screen can
 * render in one go.
 */

jest.mock('../utils/location', () => ({
    loadCachedCoords: jest.fn(),
    tryGpsCoords: jest.fn(),
    persistCoords: jest.fn(async () => {}),
}));
jest.mock('../utils/locationStorage', () => ({
    getLocationSettings: jest.fn(),
    getPresets: jest.fn(async () => ({})),
}));
jest.mock('../utils/candidatePool', () => ({ buildCandidatePool: jest.fn() }));

const GPS = { lat: 55.93, lng: 23.31, label: 'Šiauliai', source: 'cache' as const };
const settings = (over: Partial<locationStorage.LocationSettings> = {}) => ({
    transport: 'car', mode: 'current', specificPreset: null,
    routeFrom: null, routeTo: null, storeCount: 3, ...over,
} as locationStorage.LocationSettings);

beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    (locationStorage.getLocationSettings as jest.Mock).mockResolvedValue(settings());
    (location.loadCachedCoords as jest.Mock).mockResolvedValue(GPS);
    (location.tryGpsCoords as jest.Mock).mockResolvedValue(GPS);
    (candidatePool.buildCandidatePool as jest.Mock).mockResolvedValue({
        storeIds: [1, 2, 3], searchCenter: { lat: GPS.lat, lng: GPS.lng },
    });
    (global as any).fetch = jest.fn(async () => ({
        ok: true, json: async () => ([{ storeId: 1, total: 12.3 }]),
    }));
});

describe('resolveOrigin', () => {
    test('GPS mode prefers the cached fix over a hardware read', async () => {
        const r = await resolveOrigin('55');
        expect(r.coords).toEqual({ lat: GPS.lat, lng: GPS.lng });
        expect(location.tryGpsCoords).not.toHaveBeenCalled();   // no hardware wait
        expect(r.gpsFix).toBeTruthy();
    });

    test('no cached fix → one live read', async () => {
        (location.loadCachedCoords as jest.Mock).mockResolvedValue(null);
        const r = await resolveOrigin('55');
        expect(location.tryGpsCoords).toHaveBeenCalledTimes(1);
        expect(r.coords).toEqual({ lat: GPS.lat, lng: GPS.lng });
    });

    test('denied GPS with nothing cached is reported, not guessed', async () => {
        (location.loadCachedCoords as jest.Mock).mockResolvedValue(null);
        (location.tryGpsCoords as jest.Mock).mockResolvedValue(null);
        const r = await resolveOrigin('55');
        expect(r.gpsDenied).toBe(true);
        expect(r.coords).toBeNull();
    });

    test('place mode uses its preset and never touches GPS', async () => {
        (locationStorage.getLocationSettings as jest.Mock).mockResolvedValue(
            settings({ mode: 'specific', specificPreset: 'home' }));
        (locationStorage.getPresets as jest.Mock).mockResolvedValue({
            home: { lat: 54.9, lng: 23.9, address: 'Home' },
        });
        const r = await resolveOrigin('55');
        expect(r.coords).toEqual({ lat: 54.9, lng: 23.9 });
        expect(r.gpsFix).toBeNull();                            // must not be cached as "you"
        expect(location.loadCachedCoords).not.toHaveBeenCalled();
    });

    test('route mode resolves both endpoints and starts at the first', async () => {
        (locationStorage.getLocationSettings as jest.Mock).mockResolvedValue(
            settings({ mode: 'route', routeFrom: 'home', routeTo: 'work' }));
        (locationStorage.getPresets as jest.Mock).mockResolvedValue({
            home: { lat: 54.9, lng: 23.9, address: 'Home' },
            work: { lat: 55.1, lng: 24.1, address: 'Work' },
        });
        const r = await resolveOrigin('55');
        expect(r.endpoints?.from).toEqual({ latitude: 54.9, longitude: 23.9 });
        expect(r.endpoints?.to).toEqual({ latitude: 55.1, longitude: 24.1 });
        expect(r.coords).toEqual({ lat: 54.9, lng: 23.9 });
    });

    test('pre-read settings are reused, not fetched again', async () => {
        await resolveOrigin('55', { settings: settings() });
        expect(locationStorage.getLocationSettings).not.toHaveBeenCalled();
    });
});

describe('bootstrapStoreResults', () => {
    test('cached results → no calculation, no POST', async () => {
        await AsyncStorage.setItem('basket_results_55', JSON.stringify([{ storeId: 9, total: 5 }]));
        const snap = await bootstrapStoreResults('55', { saver: false, allowCalc: true });
        expect(snap.calculated).toBe(false);
        expect(snap.results).toHaveLength(1);
        expect((global as any).fetch).not.toHaveBeenCalled();
        expect(snap.origin).toEqual({ lat: GPS.lat, lng: GPS.lng });
    });

    test('THE FIX: empty cache calculates in the SAME pass, from the same origin', async () => {
        const snap = await bootstrapStoreResults('55', { saver: false, allowCalc: true });
        expect(snap.calculated).toBe(true);
        expect(snap.results).toHaveLength(1);
        // One settings read for the whole entry (the calc reuses it), and one
        // origin resolution (no second GPS round).
        expect(locationStorage.getLocationSettings).toHaveBeenCalledTimes(1);
        expect(location.loadCachedCoords).toHaveBeenCalledTimes(1);
        // The pool was built around the resolved origin, not raw coordinates.
        expect(candidatePool.buildCandidatePool).toHaveBeenCalledWith(
            { lat: GPS.lat, lng: GPS.lng }, '55');
    });

    test('a second entry for the same basket can skip the calc (allowCalc=false)', async () => {
        const snap = await bootstrapStoreResults('55', { saver: false, allowCalc: false });
        expect(snap.calculated).toBe(false);
        expect((global as any).fetch).not.toHaveBeenCalled();
    });

    test('denied GPS returns a snapshot to act on instead of calculating blind', async () => {
        (location.loadCachedCoords as jest.Mock).mockResolvedValue(null);
        (location.tryGpsCoords as jest.Mock).mockResolvedValue(null);
        const snap = await bootstrapStoreResults('55', { saver: false, allowCalc: true });
        expect(snap.gpsDenied).toBe(true);
        expect(snap.calculated).toBe(false);
        expect((global as any).fetch).not.toHaveBeenCalled();
    });

    test('a failed calculation still returns the resolved origin (map opens in the right place)', async () => {
        (global as any).fetch = jest.fn(async () => { throw new Error('offline'); });
        const snap = await bootstrapStoreResults('55', { saver: false, allowCalc: true });
        expect(snap.results).toEqual([]);
        expect(snap.origin).toEqual({ lat: GPS.lat, lng: GPS.lng });
    });

    test('place mode pins its origin; GPS mode does not', async () => {
        (locationStorage.getLocationSettings as jest.Mock).mockResolvedValue(
            settings({ mode: 'specific', specificPreset: 'home' }));
        (locationStorage.getPresets as jest.Mock).mockResolvedValue({
            home: { lat: 54.9, lng: 23.9, address: 'Home' },
        });
        const place = await bootstrapStoreResults('55', { saver: false, allowCalc: false });
        expect(place.originPin).toEqual({ latitude: 54.9, longitude: 23.9 });

        (locationStorage.getLocationSettings as jest.Mock).mockResolvedValue(settings());
        const gps = await bootstrapStoreResults('55', { saver: false, allowCalc: false });
        expect(gps.originPin).toBeNull();
    });
});

describe('calculateBasket', () => {
    test('persists results AND the calc meta together', async () => {
        await calculateBasket('55', { coords: { lat: 1, lng: 2 }, saver: false, settings: settings() });
        expect(JSON.parse((await AsyncStorage.getItem('basket_results_55'))!)).toHaveLength(1);
        const meta = JSON.parse((await AsyncStorage.getItem('basket_calc_meta_55'))!);
        expect(meta.searchCenter).toEqual({ lat: GPS.lat, lng: GPS.lng });
        expect(meta.storeCount).toBe(3);
    });

    test('saver mode is sent only when on', async () => {
        await calculateBasket('55', { coords: { lat: 1, lng: 2 }, saver: true, settings: settings() });
        const body = JSON.parse(((global as any).fetch as jest.Mock).mock.calls[0][1].body);
        expect(body.saver).toBe(true);
        expect(body.storeIds).toEqual([1, 2, 3]);
    });

    test('an empty pool posts coordinates without a store list (server picks)', async () => {
        (candidatePool.buildCandidatePool as jest.Mock).mockResolvedValue({
            storeIds: [], searchCenter: { lat: 3, lng: 4 },
        });
        await calculateBasket('55', { coords: { lat: 1, lng: 2 }, saver: false, settings: settings() });
        const body = JSON.parse(((global as any).fetch as jest.Mock).mock.calls[0][1].body);
        expect(body).toEqual({ lat: 3, lng: 4 });
    });
});
