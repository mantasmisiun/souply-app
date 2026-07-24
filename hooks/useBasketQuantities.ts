import { useCallback, useEffect, useState } from 'react';
import { API_BASE_URL } from '../config/api';
import { useBasketSession } from '../state/basketSession';

/**
 * Quantities of the CURRENT add-target basket, keyed by productId — the ONE
 * source every catalog surface (L2 cards, search, discounts, product detail)
 * uses to decide Add vs stepper.
 *
 * The target basket is the basket-session pick when one exists — so X →
 * chooser → a different basket re-renders every surface against the NEW
 * basket's contents — falling back to the legacy draft basket when no
 * session is active. A template target has no basket quantities (cards show
 * Add; adds still flow to the template through the session).
 *
 * Re-fetches whenever the effective basket or basketRev changes (any add /
 * remove bumps the rev), so all surfaces stay in sync without their own
 * loaders. `setQuantities` is exposed for the screens' optimistic updates.
 */
export function useBasketQuantities() {
    const target = useBasketSession(s => s.target);
    const basketRev = useBasketSession(s => s.basketRev);
    // SESSION-SCOPED (2026-07-24): quantities reflect ONLY the active session
    // target. A persisted server draft from an EARLIER session is dormant on
    // cold start (target == null) and must NOT paint steppers on catalog cards
    // as if its items were "already added" this session — the user resumes it
    // (which sets the target) or adds something (which also sets the target)
    // first. Every add lands via addProductToBasket, which always setTarget()s
    // on success, so a null target reliably means "nothing active yet". The
    // old `draftBasketId` fallback resurrected the stale draft the moment the
    // app launched. Basket / pending-new / template kinds are unchanged.
    const basketId = target?.kind === 'basket' ? target.basketId : null;

    const [quantities, setQuantities] = useState<Record<number, number>>({});
    const [itemCount, setItemCount] = useState(0);

    const refresh = useCallback(async () => {
        if (!basketId) { setQuantities({}); setItemCount(0); return; }
        try {
            const res = await fetch(`${API_BASE_URL}/api/baskets/${basketId}/items`);
            const items = await res.json();
            if (!Array.isArray(items)) return;
            const q: Record<number, number> = {};
            for (const it of items) q[Number(it.productId)] = parseFloat(it.quantity);
            setQuantities(q);
            setItemCount(items.filter((i: any) => parseFloat(i.quantity) > 0).length);
        } catch {}
    }, [basketId]);

    useEffect(() => { void refresh(); }, [refresh, basketRev]);

    return { basketId, quantities, itemCount, refresh, setQuantities };
}
