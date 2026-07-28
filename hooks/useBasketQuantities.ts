import { useCallback, useEffect } from 'react';
import { useBasketSession } from '../state/basketSession';
import { useBasketState } from '../state/basketState';
import { useBasketQuantitiesStore } from '../state/basketQuantities';
import { addProductToBasket } from '../utils/basketUtils';

/**
 * Quantities of the CURRENT add-target basket, keyed by productId — the ONE
 * source every catalog surface (L2 cards, search, discounts, product detail)
 * uses to decide Add vs stepper, and the ONE way they write.
 *
 * The target basket is the basket-session pick when one exists — so X →
 * chooser → a different basket re-renders every surface against the NEW
 * basket's contents. A template target has no basket quantities (cards show
 * Add; adds still flow to the template through the session).
 *
 * SESSION-SCOPED (2026-07-24): a persisted server draft from an EARLIER session
 * is dormant on cold start (target == null) and must NOT paint steppers on
 * catalog cards as if its items were "already added" this session. Every add
 * lands via addProductToBasket, which always setTarget()s on success, so a null
 * target reliably means "nothing active yet".
 *
 * The state itself lives in state/basketQuantities — one store, a pending-write
 * log and debounced writes, so a slow refresh can't stomp a fresh tap. This hook
 * is the React binding plus `commit`, which routes a new quantity: a FRESH add
 * still goes through addProductToBasket (session target / chooser / queue
 * semantics), everything else is a single by-product upsert.
 *
 * RENDER CONTRACT (2026-07-28): this hook deliberately does NOT subscribe to
 * the quantities map. It used to — so every ± tap replaced the map identity and
 * re-rendered the whole screen ABOVE the per-card scalar subscriptions in
 * ConnectedProductCard, cancelling their one-tap-one-card win. It also watched
 * basketRev through a selector, so the post-flush bump re-rendered the screen a
 * second time. Now:
 *   - everything returned here is referentially stable across quantity writes
 *     (store actions + a target-derived basketId that only changes on a basket
 *     switch), so consumer screens do not re-render on a tap at all;
 *   - basketRev is watched through a TRANSIENT store subscription that calls
 *     refresh() without rendering;
 *   - components that need a quantity VALUE use the scalar selector hooks
 *     below (or subscribe per product, like ConnectedProductCard).
 */
export function useBasketQuantities() {
    const target = useBasketSession(s => s.target);
    const basketId = target?.kind === 'basket' ? target.basketId : null;

    const setBasket = useBasketQuantitiesStore(s => s.setBasket);
    const refresh = useBasketQuantitiesStore(s => s.refresh);
    const adopt = useBasketQuantitiesStore(s => s.adopt);
    const commitQty = useBasketQuantitiesStore(s => s.commit);

    // Follow the session target (clears + re-reads on a basket switch).
    useEffect(() => { setBasket(basketId); }, [basketId, setBasket]);
    // Any add/remove anywhere bumps the rev. This refresh MERGES under pending
    // local writes, so — unlike the old one — it can no longer stomp a tap made
    // while it was in flight. Transient subscription: the bump must trigger a
    // refetch, not a render (the refresh itself only re-renders per-product
    // subscribers whose value actually changed).
    useEffect(() => {
        void refresh();
        return useBasketSession.subscribe((s, prev) => {
            if (s.basketRev !== prev.basketRev) void refresh();
        });
    }, [refresh]);

    /**
     * Set a product's quantity from any catalog surface. Optimistic on every
     * path: the card flips on tap and only corrects itself if the server
     * refuses. `currentQty` is what the card shows now (0 ⇒ a fresh add).
     *
     * `add` overrides the fresh-add call for screens that must ask something
     * first — discounts and browse resolve a COMPARED basket (use it / start a
     * new one) before adding, and that prompt has to keep running.
     */
    const commit = useCallback((
        productId: number,
        currentQty: number,
        qty: number,
        add?: (productId: number, qty: number) => Promise<{ success: boolean }>,
    ) => {
        // FRESH ADD keeps the session flow: it resolves the target, and may raise
        // the basket chooser and queue the add. Paint first so the Add button
        // becomes a stepper instantly instead of after the round trip.
        if (currentQty <= 0 && qty > 0) {
            adopt(productId, qty);
            const run = add
                ? add(productId, qty)
                : (() => {
                    const { draftBasketId, setDraftBasketId } = useBasketState.getState();
                    return addProductToBasket(productId, draftBasketId, setDraftBasketId, qty);
                })();
            void Promise.resolve(run).then(r => {
                // Refused, or cancelled at the chooser/prompt → fall back to "Add".
                if (!r?.success) adopt(productId, 0);
            }).catch(() => adopt(productId, 0));
            return;
        }
        commitQty(productId, qty);
    }, [adopt, commitQty]);

    return { basketId, refresh, commit, setQuantities: adopt };
}

/**
 * Number of distinct products currently in the target basket. Scalar
 * selector: subscribers re-render only when the COUNT changes, not on every
 * map-identity churn (each ± tap replaces the map).
 */
export function useBasketItemCount(): number {
    return useBasketQuantitiesStore(s => {
        let n = 0;
        for (const q of Object.values(s.quantities)) if (q > 0) n++;
        return n;
    });
}

/**
 * One product's quantity in the target basket. Scalar selector — the same
 * per-product subscription ConnectedProductCard uses, for screens (product
 * detail) that render a single stepper instead of a card grid.
 */
export function useBasketProductQuantity(productId: number): number {
    return useBasketQuantitiesStore(s => s.quantities[productId] ?? 0);
}
