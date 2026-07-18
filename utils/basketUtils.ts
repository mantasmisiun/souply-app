import { API_BASE_URL } from '../config/api';
import { getUserId } from '../config/user';
import type { DisplayMode } from '../contexts/DisplayPreferenceContext';
import { useBasketSession, discoverOptions, postBasketItem } from '../state/basketSession';
import { addTemplateItem } from './basketTemplatesApi';

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
    userId: string,
    // Explicit "new basket" pick: mint a fresh draft even if one exists, and
    // do NOT share the in-flight singleton (each force is its own basket).
    force: boolean = false,
): Promise<number> {
    if (existingId && !force) return existingId;
    if (!force && createDraftPromise) return createDraftPromise;

    const doCreate = async (): Promise<number> => {
        const res = await fetch(`${API_BASE_URL}/api/baskets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(force ? { userId, forceNew: true } : { userId }),
        });
        if (!res.ok) throw new Error(`create basket failed: ${res.status}`);
        const data = await res.json();
        setDraftBasketId(data.id);
        return data.id as number;
    };

    if (force) return doCreate();

    createDraftPromise = doCreate();
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

        // 1. Session target already chosen → silent add. The target is a basket
        //    OR a template (same mechanic, different persistence). Re-summons the
        //    bar even after an X dismissal (user decision 2026-07-16).
        if (session.target) {
            const t = session.target;
            let r: { success: boolean; message: string };
            if (t.kind === 'template') {
                try {
                    await addTemplateItem(t.templateId, { productId, quantity });
                    r = { success: true, message: 'Pridėta į šabloną' };
                } catch {
                    r = { success: false, message: 'Nepavyko pridėti produkto' };
                }
            } else {
                r = await postBasketItem(t.basketId, productId, quantity, matchMode);
            }
            if (r.success) {
                session.bumpCount(1);
                session.markNewProduct(productId);
                session.bumpBasketRev();
                session.showBar();
            }
            return r;
        }

        // 2. No target yet (cold start / first add). Supersedes the 2026-07-17
        //    silent-resume (user decision 2026-07-18): DON'T assume the last
        //    basket. When a resumable basket exists (family and/or previous),
        //    QUEUE this add and raise the "Baskets" dock sheet so the user
        //    picks; the pick flushes the queue. Only when there's no ambiguity
        //    at all do we create a personal draft silently.
        const options = await discoverOptions();
        if (options == null) {
            const userId = await getUserId();
            const basketId = await ensureDraftBasket(draftBasketId, setDraftBasketId, userId);
            const r = await postBasketItem(basketId, productId, quantity, matchMode);
            if (r.success) {
                // Bar appears COLLAPSED (BasketListSheet no longer auto-expands).
                useBasketSession.getState().setTarget({ kind: 'basket', basketId, isFamily: false }, 1);
                useBasketSession.getState().markNewProduct(productId);
                useBasketSession.getState().bumpBasketRev();
            }
            return r;
        }

        // Ambiguity → publish the options to the dock, mark a resumable basket
        // exists (so the sheet is available), queue the add and raise the sheet.
        const resumable = options.find(o => o.key !== 'new') ?? null;
        useBasketSession.getState().setDockOptions(options);
        useBasketSession.getState().setDormant({ count: resumable?.itemCount ?? 0 });
        return await new Promise<{ success: boolean; message: string }>((resolve) => {
            useBasketSession.getState().queueAdd({ productId, quantity, matchMode, resolve });
            useBasketSession.getState().requestDockExpand();
        });
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
        // key 'new' → force a brand-new draft (don't reuse the existing one;
        // the previous basket stays available as its own chooser row).
        const userId = await getUserId();
        basketId = await ensureDraftBasket(null, setDraftBasketId, userId, true);
    }
    session.setTarget({ kind: 'basket', basketId, isFamily: option.key === 'family' }, option.itemCount);
    session.closeChooser();
    // Collapse the raised chooser sheet — the session continues COLLAPSED (just
    // the bar) so the user keeps browsing; they pull it up to review.
    session.collapseDock?.();
    const pending = session.takePending();
    for (const add of pending) {
        const r = await postBasketItem(basketId, add.productId, add.quantity, add.matchMode);
        if (r.success) {
            useBasketSession.getState().bumpCount(1);
            useBasketSession.getState().markNewProduct(add.productId);
        }
        add.resolve(r);
    }
    useBasketSession.getState().bumpBasketRev();
};