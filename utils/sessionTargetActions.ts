import { API_BASE_URL } from '../config/api';
import { useBasketSession, type SessionTarget } from '../state/basketSession';
import { useBasketState } from '../state/basketState';
import { useTemplateAddState } from '../state/templateAddState';
import { useShoppingSheet } from '../state/shoppingSheet';
import { deleteTemplate } from './basketTemplatesApi';

/**
 * The session sheet's View/Delete card actions (BasketListSheet's action row),
 * extracted so the teardown + navigation contracts are directly testable.
 *
 * A `pending-new` target has NO server row (lazy cart) — both actions are
 * no-ops here and the cards are disabled in the sheet; nothing to open or
 * delete until the first add mints the real basket.
 */

/** The two router calls the sheet needs — a structural subset of expo-router. */
export interface SessionNavRouter {
    navigate: (path: string) => void;
    push: (path: string) => void;
}

/**
 * "View" card: open the target's own detail screen with an EXPLICIT stack —
 * the owning tab first (a tab switch, no stack entry), then the detail push —
 * exactly the shape BasketListSheet.finishToShopping builds, so Back lands on
 * the target's home tab, not wherever the catalog left off.
 */
export function viewSessionTarget(target: SessionTarget, router: SessionNavRouter): void {
    if (target.kind === 'basket') {
        router.navigate('/(tabs)/basket');
        router.push(`/basket/${target.basketId}`);
    } else if (target.kind === 'template') {
        router.navigate('/(tabs)/templates');
        router.push(`/template/${target.templateId}`);
    }
}

/**
 * "Delete" card: delete the basket/recipe ITSELF (items go with it via
 * cascade), then end the collecting session the same way finishToShopping
 * does — template-add overlay cleared, session target gone — plus the legacy
 * basket-state + shopping-card sync the basket-detail delete performs
 * (app/basket/[id].tsx doRemoveBasket).
 *
 * THROWS on failure with the session fully intact, so the caller can surface
 * an error and leave the user exactly where they were. `collapse` runs only
 * after a successful teardown (the sheet drops with the session).
 */
export async function deleteSessionTarget(target: SessionTarget, collapse?: () => void): Promise<void> {
    if (target.kind === 'pending-new') return; // nothing persisted — card is disabled anyway
    if (target.kind === 'template') {
        await deleteTemplate(target.templateId);
        // The recipe flow's add-overlay tracks this template — clear it with
        // the session (same pairing as finishToShopping).
        useTemplateAddState.getState().clear();
    } else {
        const res = await fetch(`${API_BASE_URL}/api/baskets/${target.basketId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`DELETE basket ${target.basketId} → ${res.status}`);
        // Legacy draft/session ids must not resurrect the deleted basket …
        useBasketState.getState().clearSessionBasket();
        // … and a live Shopping-tab card for it animates away (no-op when the
        // tab isn't mounted; it refetches on focus).
        useShoppingSheet.getState().removeTripByBasket?.(target.basketId);
    }
    useBasketSession.getState().endSession();
    collapse?.();
}
