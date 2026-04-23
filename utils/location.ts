import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { API_BASE_URL } from '../config/api';

/**
 * User location resolution for basket calculation.
 *
 *   1. AsyncStorage cache — per-install, keyed loosely so a manually-
 *      entered address sticks across app restarts. Cheap; if user moves
 *      or enters a different address, they trigger another geocode.
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
        return { ...parsed, source: 'cache' };
    } catch {
        return null;
    }
}

export async function persistCoords(coords: UserCoords): Promise<void> {
    try {
        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(coords));
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
 * Try to get GPS coordinates. Returns null (and DOESN'T throw) if
 * permission is denied, timeout, or any other failure — caller routes
 * to the address-modal fallback.
 */
export async function tryGpsCoords(): Promise<UserCoords | null> {
    try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return null;
        const pos = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
        });
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
