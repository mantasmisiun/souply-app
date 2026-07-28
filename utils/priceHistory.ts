import { API_BASE_URL } from '../config/api';
import type { PricePoint } from '../components/MiniPriceChart';

/**
 * Bulk price-history fetch for the product-detail screen.
 *
 * The screen used to await one `/api/prices/store-product/:id/history` round
 * trip PER store product, in sequence, committing state per response — 15–30
 * serial round trips and as many full re-renders on a multi-chain product.
 *
 * `GET /api/prices/store-products/history?spIds=1,2,3` returns them all at
 * once as `{ histories: { [storeProductId]: PricePoint[] } }` (same element
 * shape as the single-id endpoint's array). The server caps the id count per
 * request, so ids are CHUNKED; a chunk that fails (400 over-cap, older server
 * without the route, network hiccup) falls back to per-id single fetches so
 * the screen keeps working against any server version.
 */

/** Conservative chunk size — kept under the server's per-request id cap. */
export const HISTORY_CHUNK_SIZE = 20;

export function chunkIds(ids: number[], size: number = HISTORY_CHUNK_SIZE): number[][] {
    const out: number[][] = [];
    for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
    return out;
}

const asPoints = (v: unknown): PricePoint[] => (Array.isArray(v) ? (v as PricePoint[]) : []);

/** Single-id fallback: one legacy request per id, failures → empty history. */
async function fetchSingles(ids: number[]): Promise<Record<number, PricePoint[]>> {
    const out: Record<number, PricePoint[]> = {};
    await Promise.all(ids.map(async (id) => {
        try {
            const res = await fetch(`${API_BASE_URL}/api/prices/store-product/${id}/history`);
            out[id] = res.ok ? asPoints(await res.json()) : [];
        } catch {
            out[id] = [];
        }
    }));
    return out;
}

async function fetchChunk(ids: number[]): Promise<Record<number, PricePoint[]>> {
    try {
        const res = await fetch(`${API_BASE_URL}/api/prices/store-products/history?spIds=${ids.join(',')}`);
        if (!res.ok) return fetchSingles(ids);
        const body = await res.json();
        const histories = body?.histories;
        if (!histories || typeof histories !== 'object') return fetchSingles(ids);
        const out: Record<number, PricePoint[]> = {};
        // Requested ids drive the output: an id the server omitted (no
        // history) resolves to [], never to undefined.
        for (const id of ids) out[id] = asPoints((histories as Record<string, unknown>)[String(id)]);
        return out;
    } catch {
        return fetchSingles(ids);
    }
}

/**
 * Fetch price histories for `spIds` — chunked-parallel bulk requests with a
 * per-chunk single-id fallback. Always resolves with an entry for every
 * requested id (worst case `[]`); never throws.
 */
export async function fetchPriceHistories(spIds: number[]): Promise<Record<number, PricePoint[]>> {
    if (spIds.length === 0) return {};
    const results = await Promise.all(chunkIds(spIds).map(fetchChunk));
    return Object.assign({}, ...results);
}
