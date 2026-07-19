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
            if (t.kind === 'pending-new') {
                // Lazy cart: the first real add mints the basket.
                const userId = await getUserId();
                const basketId = await ensureDraftBasket(null, setDraftBasketId, userId, true);
                r = await postBasketItem(basketId, productId, quantity, matchMode);
                if (r.success) {
                    session.setTarget({ kind: 'basket', basketId, isFamily: false }, 0);
                    session.bumpCount(1);
                    session.markNewProduct(productId);
                    session.bumpBasketRev();
                    session.showBar();
                }
                return r;
            }
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

/** The chooser's pick handler: resolve the target (basket OR template — creating
 *  a basket when `new`), set it as the session target and flush every queued add
 *  into it. */
export const applyChooserPick = async (
    option: {
        key: 'family' | 'previous' | 'new' | 'template';
        basketId: number | null;
        templateId?: number | null;
        name?: string | null;
        itemCount: number;
    },
    setDraftBasketId: (id: number) => void,
): Promise<void> => {
    const session = useBasketSession.getState();
    // CLAIM the queued adds BEFORE collapsing: collapse SYNCHRONOUSLY fires the
    // dock's stage-0 handler, whose "chooser dismissed without a pick" guard
    // (target==null && pending) would cancel-and-clear the queue we are about
    // to flush — the add would silently vanish (bug: pick applied, item lost).
    const pending = session.takePending();
    session.closeChooser();
    // Collapse the raised chooser sheet — the session continues COLLAPSED (just
    // the bar) so the user keeps browsing; they pull it up to review.
    session.collapseDock?.();

    // Template pick → the session targets the template; queued adds flush via the
    // template API rather than the basket-items endpoint.
    if (option.key === 'template' && option.templateId != null) {
        const templateId = option.templateId;
        session.setTarget({ kind: 'template', templateId, name: option.name ?? undefined }, option.itemCount);
        for (const add of pending) {
            let r: { success: boolean; message: string };
            try {
                await addTemplateItem(templateId, { productId: add.productId, quantity: add.quantity });
                r = { success: true, message: 'Pridėta į šabloną' };
            } catch {
                r = { success: false, message: 'Nepavyko pridėti produkto' };
            }
            if (r.success) {
                useBasketSession.getState().bumpCount(1);
                useBasketSession.getState().markNewProduct(add.productId);
            }
            add.resolve(r);
        }
        useBasketSession.getState().bumpBasketRev();
        return;
    }

    let basketId = option.basketId;
    if (basketId == null) {
        if (pending.length === 0) {
            // key 'new' picked with NOTHING queued: defer creation (lazy cart
            // — Shopify/Amazon semantics). The session targets a sentinel; the
            // first successful add mints the basket. Abandoning leaves no row.
            session.setTarget({ kind: 'pending-new' }, 0);
            useBasketSession.getState().bumpBasketRev();
            return;
        }
        // Adds already queued → the basket is non-empty from birth; create it.
        const userId = await getUserId();
        basketId = await ensureDraftBasket(null, setDraftBasketId, userId, true);
    }
    session.setTarget({ kind: 'basket', basketId, isFamily: option.key === 'family' }, option.itemCount);
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