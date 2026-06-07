import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE_URL } from '../config/api';
import { type StoreLite } from './candidatePool';

/**
 * The full store directory (every store's location + chain) for the results
 * map. It's small (~hundreds of stores, ~100 KB) and near-static, so we cache
 * it on disk for a week and in memory for the session — the map can show all of
 * Lithuania without ever hitting the server again. Prices are NOT here; those
 * are lazy (see basketPricing.fetchStorePrices).
 */
export type { StoreLite };

const CACHE_KEY = 'store_directory_v1';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let mem: { ts: number; data: StoreLite[] } | null = null;

async function fromNetwork(): Promise<StoreLite[]> {
    const res = await fetch(`${API_BASE_URL}/api/stores/lite`);
    if (!res.ok) throw new Error(`stores/lite ${res.status}`);
    const data = (await res.json()) as StoreLite[];
    mem = { ts: Date.now(), data };
    AsyncStorage.setItem(CACHE_KEY, JSON.stringify(mem)).catch(() => {});
    return data;
}

/**
 * Returns all stores, preferring the in-memory cache, then the disk cache,
 * then the network. Throws only if the network is reached AND fails with no
 * cache to fall back on.
 */
export async function getStoreDirectory(): Promise<StoreLite[]> {
    const now = Date.now();
    if (mem && now - mem.ts < TTL_MS) return mem.data;

    try {
        const raw = await AsyncStorage.getItem(CACHE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as { ts: number; data: StoreLite[] };
            if (parsed?.data?.length) {
                mem = parsed;
                // Stale-while-revalidate: serve disk immediately, refresh behind it.
                if (now - parsed.ts >= TTL_MS) void fromNetwork().catch(() => {});
                return parsed.data;
            }
        }
    } catch { /* fall through to network */ }

    return fromNetwork();
}

/** Silent background refresh of the disk cache (best-effort, never throws). */
export async function refreshStoreDirectory(): Promise<void> {
    try { await fromNetwork(); } catch { /* ignore */ }
}
