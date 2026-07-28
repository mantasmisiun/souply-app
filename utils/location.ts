import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { API_BASE_URL } from '../config/api';

/**
 * User location resolution for basket calculation.
 *
 *   1. AsyncStorage cache — short-lived (30 min TTL). Avoids re-prompting
 *      GPS on rapid back-to-back calcs. After expiry the cache is cleared
 *      and the next calc re-queries GPS, so coords stay current as the
 *      user moves between cities.
 *   2. expo-location — device GPS with the standard permission flow.
 *      Covers the happy path: user grants permission once on calc.
 *   3. Address modal (handled in UI) — when permission is denied or GPS
 *      fails, user types an address, we POST to /api/geocode.
 *   4. Vilnius city centre — the last-resort default so the calc never
 *      breaks. The store list just ranks by distance from Vilnius, which
 *      is a reasonable baseline for most Lithuanian users.
 */

export interface UserCoords {
    lat: number;
    lng: number;
    /** Human-readable label for the resolved location (address or chain
     *  name), shown in UI so the user can tell where the calc was run
     *  from. Falls back to 'Vilnius' for the default. */
    label: string;
    source: 'gps' | 'address' | 'cache' | 'fallback';
}

const CACHE_KEY = 'userCoords';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const VILNIUS: UserCoords = {
    lat: 54.6872,
    lng: 25.2797,
    label: 'Vilniaus centras',
    source: 'fallback',
};

export const VILNIUS_FALLBACK: UserCoords = VILNIUS;

export async function loadCachedCoords(): Promise<UserCoords | null> {
    try {
        const raw = await AsyncStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!Number.isFinite(parsed?.lat) || !Number.isFinite(parsed?.lng)) return null;
        // TTL check: past CACHE_TTL_MS this is no longer "where you are", so the
        // caller falls through to a fresh GPS query. The value is KEPT on disk —
        // an expired fix is still the best guess for a map's fallback camera
        // (see loadLastKnownCoords); deleting it left the map with nothing but a
        // hardcoded Vilnius.
        const cachedAt = Number(parsed?.cachedAt);
        if (!Number.isFinite(cachedAt) || Date.now() - cachedAt > CACHE_TTL_MS) return null;
        return { lat: parsed.lat, lng: parsed.lng, label: parsed.label, source: 'cache' };
    } catch {
        return null;
    }
}

/**
 * The last position we ever recorded, TTL ignored. NOT for calculations — an
 * hours-old fix must never silently price a basket — only for framing a map when
 * nothing better is available yet.
 */
export async function loadLastKnownCoords(): Promise<UserCoords | null> {
    try {
        const raw = await AsyncStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!Number.isFinite(parsed?.lat) || !Number.isFinite(parsed?.lng)) return null;
        return { lat: parsed.lat, lng: parsed.lng, label: parsed.label, source: 'cache' };
    } catch {
        return null;
    }
}

export async function persistCoords(coords: UserCoords): Promise<void> {
    try {
        const payload = { ...coords, cachedAt: Date.now() };
        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    } catch {
        // non-fatal
    }
}

export async function clearCachedCoords(): Promise<void> {
    try {
        await AsyncStorage.removeItem(CACHE_KEY);
    } catch {
        // non-fatal
    }
}

/**
 * How long we'll wait for a hardware fix before giving up. `getCurrentPositionAsync`
 * takes NO timeout option, so without racing it the call can sit there for 30+
 * seconds on a cold/indoor fix — and every caller `await`s it. That is exactly
 * how opening a shopping list came to take half a minute: the screen blocked on
 * GPS purely to sort its store tabs by distance. Past this budget we return null
 * and callers fall back to cached coords / a preset / the address prompt.
 */
const GPS_TIMEOUT_MS = 6000;

/**
 * Try to get GPS coordinates. Returns null (and DOESN'T throw) if permission is
 * denied, the fix takes longer than GPS_TIMEOUT_MS, or any other failure —
 * caller routes to cached coords or the address-modal fallback.
 *
 * NEVER call this on a path that blocks a render without a cached fallback: it
 * is best-effort by design.
 */
export async function tryGpsCoords(): Promise<UserCoords | null> {
    try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return null;
        const pos = await Promise.race([
            Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
            new Promise<null>(resolve => setTimeout(() => resolve(null), GPS_TIMEOUT_MS)),
        ]);
        if (!pos) return null;               // timed out — don't strand the caller
        return {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            label: 'Dabartinė vietovė',
            source: 'gps',
        };
    } catch {
        return null;
    }
}

/**
 * Ask backend to geocode a typed address. Returns null on any failure
 * (no result, network error, Nominatim 5xx) so the UI can surface a
 * targeted error message + offer retry or Vilnius-centre fallback.
 */
export async function geocodeAddress(address: string): Promise<UserCoords | null> {
    try {
        const res = await fetch(`${API_BASE_URL}/api/geocode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (!Number.isFinite(data?.lat) || !Number.isFinite(data?.lng)) return null;
        return {
            lat: Number(data.lat),
            lng: Number(data.lng),
            label: data.displayName ?? address,
            source: 'address',
        };
    } catch {
        return null;
    }
}
