import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { API_BASE_URL } from './api';
import { DEV_RANDOM_USER_UUID } from '../constants/flags';

const USER_ID_KEY = 'userId';
const USER_SYNCED_KEY = 'userSyncedToBackend';

// In debug builds (npx expo run:android) the fixed dev user makes test data
// easy to identify and wipe — unless DEV_RANDOM_USER_UUID is on, in which
// case dev behaves identically to production (real per-install UUID). Use
// that flag when exercising the account-recovery flow on a dev build.
// __DEV__ is false in production.
const DEV_USER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Every install gets a fresh UUID on first launch. The device is the source
 * of truth for its identity — we generate locally, persist to AsyncStorage,
 * and POST to /api/users so the backend User row exists (required because
 * votes/baskets/shopping lists all FK against User.id).
 *
 * Concurrency: the resolver is memoized in a module-level promise. Without
 * this, multiple screens (browse + basket + _layout) that all call
 * getUserId() on mount would race through AsyncStorage — each seeing `null`,
 * each generating a different UUID, each POSTing — producing a handful of
 * duplicate User rows on first install. With memoization, the first caller
 * owns the full first-run work and everyone else awaits the same promise.
 *
 * Sync retry: if the POST fails (no network, server down), the memo only
 * caches the generated UUID, not the synced-to-backend state. Subsequent
 * calls re-check the USER_SYNCED_KEY flag and retry the POST — fire-and-
 * forget so they don't block basic app use.
 */

let initPromise: Promise<string> | null = null;

async function initUserId(): Promise<string> {
    if (__DEV__ && !DEV_RANDOM_USER_UUID) {
        syncToBackendIfNeeded(DEV_USER_ID);
        return DEV_USER_ID;
    }
    let userId = await AsyncStorage.getItem(USER_ID_KEY);
    if (!userId) {
        userId = Crypto.randomUUID();
        await AsyncStorage.setItem(USER_ID_KEY, userId);
    }
    await syncToBackendIfNeeded(userId);
    return userId;
}

async function syncToBackendIfNeeded(userId: string): Promise<void> {
    const synced = await AsyncStorage.getItem(USER_SYNCED_KEY);
    if (synced === '1') return;
    try {
        const res = await fetch(`${API_BASE_URL}/api/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: userId }),
        });
        if (res.ok) {
            await AsyncStorage.setItem(USER_SYNCED_KEY, '1');
        }
    } catch {
        // Offline / server unreachable — leave the flag unset so the next
        // getUserId() retries. Basic app navigation still works offline;
        // FK-dependent backend calls will fail until sync eventually lands.
    }
}

export const getUserId = async (): Promise<string> => {
    if (!initPromise) {
        initPromise = initUserId();
    }
    const id = await initPromise;
    // Opportunistic sync retry on every call when offline failed earlier.
    // Cheap: AsyncStorage read + one early-return when already synced.
    syncToBackendIfNeeded(id);
    return id;
};

/**
 * Reset the device's stored identity. Used by the account-delete flow:
 * after the server-side `anonymize` removes the User row, the client
 * wipes its UUID + sync flag so the next `getUserId()` call generates a
 * fresh UUID and POSTs to /api/users to create a new account.
 *
 * Production-only impact — in __DEV__ the UUID is hardcoded to
 * `DEV_USER_ID` so this just nudges the sync retry path. That's the
 * right testing behaviour: delete locally then immediately recreate
 * the same dev User row on next backend sync.
 */
export const resetUserId = async (): Promise<void> => {
    await AsyncStorage.multiRemove([USER_ID_KEY, USER_SYNCED_KEY]);
    // Drop the memoised promise so `getUserId()` re-runs `initUserId()`.
    initPromise = null;
};

/**
 * Adopt a server-issued UUID as the local identity. Used by the account
 * recovery flow: after the server confirms the recovered userId, the
 * client overwrites its local UUID and marks it already-synced (the
 * recovered User row obviously exists server-side, so no POST is
 * required).
 *
 * Caller is expected to immediately reload the app afterwards so every
 * Zustand store hydrates against the new identity — `expo-updates`
 * `reloadAsync()` is the path used by the restore screen.
 */
export const setUserId = async (recoveredId: string): Promise<void> => {
    await AsyncStorage.setItem(USER_ID_KEY, recoveredId);
    await AsyncStorage.setItem(USER_SYNCED_KEY, '1');
    initPromise = null;
};
