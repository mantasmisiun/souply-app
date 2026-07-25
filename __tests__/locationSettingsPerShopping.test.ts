import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocationSettings, saveLocationSettings } from '../utils/locationStorage';

// Store-search settings are PER SHOPPING (basket), not per device. A single
// global blob leaked "2 stores" / Place / Route from an old trip into every new
// one, and a brand-new shopping never started clean. The map surface
// (StoreResultsSurface, scope = basketId) and the basket detail screen
// (scope = the same route id) must therefore agree on the key, so leaving the
// map to edit the basket and coming back restores THIS shopping's settings.
describe('location settings are scoped per shopping', () => {
    beforeEach(async () => { await AsyncStorage.clear(); });

    test('a shopping with no saved settings starts FRESH (gps, one store)', async () => {
        const s = await getLocationSettings('83');
        expect(s.mode).toBe('current');
        expect(s.storeCount).toBe(1);
        expect(s.specificPreset).toBeNull();
    });

    test('settings persist for the shopping that set them', async () => {
        await saveLocationSettings({ storeCount: 2, mode: 'specific', specificPreset: 'home' }, '83');
        const again = await getLocationSettings('83');
        expect(again.storeCount).toBe(2);
        expect(again.mode).toBe('specific');
        expect(again.specificPreset).toBe('home');
    });

    test('they do NOT leak into a different shopping', async () => {
        await saveLocationSettings({ storeCount: 3, mode: 'route' }, '83');
        const other = await getLocationSettings('99');
        expect(other.storeCount).toBe(1);
        expect(other.mode).toBe('current');
    });

    test('numeric and string basket ids resolve to the SAME shopping', async () => {
        // The map passes String(basketId); the basket screen passes the route
        // param. Both must land on one key or the round-trip loses the settings.
        await saveLocationSettings({ storeCount: 2 }, 83);
        expect((await getLocationSettings('83')).storeCount).toBe(2);
    });

    test('a partial save MERGES rather than resetting the rest', async () => {
        await saveLocationSettings({ mode: 'specific', specificPreset: 'work' }, '83');
        await saveLocationSettings({ storeCount: 3 }, '83');
        const s = await getLocationSettings('83');
        expect(s.storeCount).toBe(3);
        expect(s.mode).toBe('specific');       // untouched by the second save
        expect(s.specificPreset).toBe('work');
    });

    test('the unscoped (global) blob is independent of any shopping', async () => {
        await saveLocationSettings({ storeCount: 3 });          // global
        expect((await getLocationSettings('83')).storeCount).toBe(1);
        await saveLocationSettings({ storeCount: 2 }, '83');    // shopping
        expect((await getLocationSettings()).storeCount).toBe(3);
    });
});
