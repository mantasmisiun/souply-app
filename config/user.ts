import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { API_BASE_URL } from './api';

const USER_ID_KEY = 'userId';
const USER_SYNCED_KEY = 'userSyncedToBackend';

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
