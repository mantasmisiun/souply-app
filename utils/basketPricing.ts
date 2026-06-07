import { API_BASE_URL } from '../config/api';

/**
 * Shared basket-pricing types + the lazy per-store price fetch.
 *
 * `StoreResult` / `ItemResult` are the shape returned by BOTH the top-N
 * `/calculate` endpoint and the on-demand `/store-prices` endpoint — the map
 * treats lazily-priced stores identically to the precomputed ones.
 */
export interface ItemResult {
    productId: number;
    productName: string;
    quantity: number;
    matchMode: 'sku' | 'base';
    price: number | null;
    promoPrice: number | null;
    effectivePrice: number | null;
    isMissing: boolean;
    isFallback: boolean;
    isWeighable: boolean;
    isSubstituted: boolean;
    isCrossChainAverage: boolean;
    packsNeeded: number | null;
    totalPrice: number | null;
    storeProductName: string | null;
    storeProductId: number | null;
    resolvedProductId: number | null;
}

export interface StoreResult {
    storeId: number;
    storeName: string;
    chainName: string;
    chainId: number;
    chainLogoUrl: string | null;
    chainMiniLogoUrl?: string | null;
    storeAddress: string;
    latitude: number | null;
    longitude: number | null;
    distance: number;
    total: number;
    isApproximated: boolean;
    missingItemNames: string[];
    items: ItemResult[];
}

/** Max stores per on-demand request — mirrors the server cap. */
export const STORE_PRICE_BATCH_CAP = 10;

// In-flight dedup so two taps on the same pin (or overlapping batches) don't
// double-fire the comparison engine. Keyed by basket + sorted ids + location.
const inFlight = new Map<string, Promise<StoreResult[]>>();

/**
 * Lazily price the basket at the given stores (1–10) via POST
 * /api/baskets/:id/store-prices. Returns the same StoreResult shape as the
 * top-N results. The server caches per (basket, location, store), so repeats
 * are cheap; this layer only dedups concurrent identical requests.
 */
export async function fetchStorePrices(
    basketId: string | number,
    storeIds: number[],
    coords: { lat: number; lng: number } | null,
): Promise<StoreResult[]> {
    const ids = Array.from(new Set(storeIds.filter(n => Number.isFinite(n) && n > 0))).slice(0, STORE_PRICE_BATCH_CAP);
    if (ids.length === 0) return [];

    const locPart = coords ? `${coords.lat.toFixed(3)},${coords.lng.toFixed(3)}` : '';
    const key = `${basketId}:${[...ids].sort((a, b) => a - b).join(',')}:${locPart}`;
    const existing = inFlight.get(key);
    if (existing) return existing;

    const p = (async () => {
        try {
            const res = await fetch(`${API_BASE_URL}/api/baskets/${basketId}/store-prices`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ storeIds: ids, lat: coords?.lat, lng: coords?.lng }),
            });
            if (!res.ok) throw new Error(`store-prices ${res.status}`);
            return (await res.json()) as StoreResult[];
        } finally {
            inFlight.delete(key);
        }
    })();

    inFlight.set(key, p);
    return p;
}
