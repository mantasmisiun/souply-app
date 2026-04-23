import { API_BASE_URL } from '../config/api';
import { getUserId } from '../config/user';
import type { DisplayMode } from '../contexts/DisplayPreferenceContext';

/**
 * Module-level in-flight promise: serializes concurrent "create draft
 * basket" requests so taps from two product screens within the same tick
 * share one POST /api/baskets call. Without this, the first tap's POST is
 * still in flight when the second tap fires; both see draftBasketId=null
 * on the client, both POST, and two baskets are created (one becomes
 * orphaned). The backend also short-circuits duplicate creates via
 * getUserDraftBasketId, but this keeps the request count at 1 on happy
 * paths and avoids the UI showing a different id briefly.
 *
 * Cleared as soon as the promise settles so subsequent calls see the
 * now-populated draftBasketId via the zustand store and bypass creation
 * altogether.
 */
let createDraftPromise: Promise<number> | null = null;

async function ensureDraftBasket(
    existingId: number | null,
    setDraftBasketId: (id: number) => void,
    userId: string
): Promise<number> {
    if (existingId) return existingId;
    if (createDraftPromise) return createDraftPromise;

    createDraftPromise = (async () => {
        const res = await fetch(`${API_BASE_URL}/api/baskets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        if (!res.ok) throw new Error(`create basket failed: ${res.status}`);
        const data = await res.json();
        setDraftBasketId(data.id);
        return data.id as number;
    })();

    createDraftPromise.finally(() => {
        createDraftPromise = null;
    });
    return createDraftPromise;
}

/**
 * Add a Product to the user's current draft basket.
 *
 * `matchMode` is the "detalumas" flag captured at add time — stored on the
 * BasketItem row so the basket calculation service later knows whether to
 * score this slot as a specific SKU or as "any variant of this cluster".
 * Default 'sku' matches the pre-Phase-1 behavior for call sites that
 * haven't been updated yet.
 */
export const addProductToBasket = async (
    productId: number,
    draftBasketId: number | null,
    setDraftBasketId: (id: number) => void,
    quantity: number = 1,
    matchMode: DisplayMode = 'sku'
) => {
    try {
        const userId = await getUserId();
        const basketId = await ensureDraftBasket(draftBasketId, setDraftBasketId, userId);

        const res = await fetch(`${API_BASE_URL}/api/basket-items`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ basketId, productId, quantity, matchMode }),
        });

        if (res.status === 409) {
            return { success: false, message: 'Produktas jau yra krepšelyje' };
        }

        return { success: true, message: 'Produktas pridėtas į krepšelį' };
    } catch (error) {
        return { success: false, message: 'Nepavyko pridėti produkto' };
    }
};