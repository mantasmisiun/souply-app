import { API_BASE_URL } from '../config/api';
import { getUserId } from '../config/user';
import type { DisplayMode } from '../contexts/DisplayPreferenceContext';
import { useBasketSession, discoverOptions, postBasketItem } from '../state/basketSession';

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
        const session = useBasketSession.getState();

        // 1. Session target already chosen → silent add (re-summons the bar
        //    even after an X dismissal — user decision 2026-07-16).
        if (session.target) {
            const r = await postBasketItem(session.target.basketId, productId, quantity, matchMode);
            if (r.success) {
                session.bumpCount(1);
                session.bumpBasketRev();
                session.showBar();
            }
            return r;
        }

        // 2. No target yet (user decision 2026-07-17: NO upfront chooser).
        //    Silently resume the most-recent stage-1/2 personal basket, or
        //    create one — the bar is the feedback, and switching (incl. the
        //    family basket) lives behind the explicit "Keisti krepšelį" flow.
        const options = await discoverOptions();
        const previous = options?.find(o => o.key === 'previous') ?? null;
        let basketId = previous?.basketId ?? null;
        let count = previous?.itemCount ?? 0;
        if (basketId == null) {
            const userId = await getUserId();
            basketId = await ensureDraftBasket(draftBasketId, setDraftBasketId, userId);
            count = 0;
        }
        const r = await postBasketItem(basketId, productId, quantity, matchMode);
        if (r.success) {
            useBasketSession.getState().setTarget({ basketId, isFamily: false }, count + 1);
            useBasketSession.getState().bumpBasketRev();
        }
        return r;
    } catch {
        return { success: false, message: 'Nepavyko pridėti produkto' };
    }
};

/** The chooser's pick handler: resolve the basket (create when `new`),
 *  set it as the session target and flush every queued add into it. */
export const applyChooserPick = async (
    option: { key: 'family' | 'previous' | 'new'; basketId: number | null; itemCount: number },
    setDraftBasketId: (id: number) => void,
): Promise<void> => {
    const session = useBasketSession.getState();
    let basketId = option.basketId;
    if (basketId == null) {
        const userId = await getUserId();
        basketId = await ensureDraftBasket(null, setDraftBasketId, userId);
    }
    session.setTarget({ basketId, isFamily: option.key === 'family' }, option.itemCount);
    session.closeChooser();
    const pending = session.takePending();
    for (const add of pending) {
        const r = await postBasketItem(basketId, add.productId, add.quantity, add.matchMode);
        if (r.success) useBasketSession.getState().bumpCount(1);
        add.resolve(r);
    }
};