/**
 * tryGpsCoords must be TIME-BOUNDED.
 *
 * expo-location's getCurrentPositionAsync takes no timeout option, so a cold or
 * indoor fix can sit unresolved for 30+ seconds while every caller awaits it.
 * That is what made opening a shopping list take half a minute: the screen
 * blocked on GPS purely to sort its store tabs by distance. The function's doc
 * comment always claimed it "returns null on timeout" — this pins that promise.
 */

import * as Location from 'expo-location';
import { tryGpsCoords } from '../utils/location';

let resolvePosition: ((v: unknown) => void) | null = null;

jest.mock('expo-location', () => ({
    Accuracy: { Balanced: 3 },
    requestForegroundPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
    // A fix that NEVER arrives unless a test resolves it — the hanging-GPS case.
    getCurrentPositionAsync: jest.fn(() => new Promise((res) => { resolvePosition = res; })),
}));

describe('tryGpsCoords is time-bounded', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        resolvePosition = null;
        (Location.requestForegroundPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
    });
    afterEach(() => { jest.useRealTimers(); });

    test('a GPS fix that never arrives resolves to null instead of hanging forever', async () => {
        const pending = tryGpsCoords();
        // Let the permission promise settle, then burn past the timeout budget.
        await Promise.resolve();
        await Promise.resolve();
        jest.advanceTimersByTime(10_000);
        await expect(pending).resolves.toBeNull();
    });

    test('a fix that arrives in time is still returned', async () => {
        const pending = tryGpsCoords();
        await Promise.resolve();
        await Promise.resolve();
        expect(resolvePosition).not.toBeNull();
        resolvePosition!({ coords: { latitude: 54.6872, longitude: 25.2797 } });
        await expect(pending).resolves.toMatchObject({ lat: 54.6872, lng: 25.2797, source: 'gps' });
    });

    test('denied permission returns null without ever touching the hardware', async () => {
        (Location.requestForegroundPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'denied' });
        (Location.getCurrentPositionAsync as jest.Mock).mockClear();
        await expect(tryGpsCoords()).resolves.toBeNull();
        expect(Location.getCurrentPositionAsync).not.toHaveBeenCalled();
    });
});
