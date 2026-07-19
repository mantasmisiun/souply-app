import { useCallback, useEffect, useState } from 'react';
import { API_BASE_URL } from '../config/api';
import { useBasketSession } from '../state/basketSession';
import { useBasketState } from '../state/basketState';

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
    const draftBasketId = useBasketState(s => s.draftBasketId);
    const basketId = target?.kind === 'basket' ? target.basketId
        : target?.kind === 'template' ? null
        : draftBasketId;

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
