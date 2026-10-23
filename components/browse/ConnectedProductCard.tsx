import { memo, useCallback } from 'react';
import BasketProductCard, { type UnitPriceBadge, type CardBadge } from './BasketProductCard';
import { type SteppableProduct } from '../AddOrStepper';
import { useBasketQuantitiesStore } from '../../state/basketQuantities';

/**
 * A product card that reads its OWN quantity from the shared basket-quantities
 * store.
 *
 * Why not just pass the number down: the grids used to hand every card a slice
 * of one `basketQuantities` object, so `renderItem` depended on that object and
 * a single ± tap re-rendered every card in the list (and `memo` never hit,
 * because the inline `onCommit` closure was new each time). Subscribing per card
 * means one tap re-renders one card.
 *
 * The parent keeps a STABLE `onCommit(productId, currentQty, qty)` — building
 * the per-card closure in here doesn't break memoization, since it's created
 * during this component's own render.
 *
 * Template mode still takes its quantity as a prop: that lives in a different
 * store, and template edits are rare enough not to matter.
 */
export const ConnectedProductCard = memo(function ConnectedProductCard({
    product, name, imageUrls, chainLogos, amountText, badge, discountBadge,
    isTemplateMode = false, templateQuantity = 0, isAdding = false, addLabel,
    mergedProductIds, onOpen, onCommit,
}: {
    product: SteppableProduct & { id: number };
    name: string;
    imageUrls?: (string | null | undefined)[] | string | null;
    chainLogos?: { chainId: number; logoUrl: string | null }[] | string | null;
    amountText?: string;
    badge?: UnitPriceBadge | null;
    discountBadge?: CardBadge | null;
    isTemplateMode?: boolean;
    templateQuantity?: number;
    /** Products merged INTO this one (browse): their quantities count as this
     *  card's, so a merged sibling already in the basket shows as added here. */
    mergedProductIds?: number[];
    isAdding?: boolean;
    addLabel?: string;
    onOpen?: () => void;
    /** Stable across renders — (productId, currentQty, newQty). */
    onCommit: (productId: number, currentQty: number, qty: number) => void;
}) {
    // Selector returns a NUMBER, so the card re-renders only when its own
    // quantity changes — not on every other product's tap.
    const basketQuantity = useBasketQuantitiesStore(s => {
        let q = s.quantities[product.id] ?? 0;
        if (mergedProductIds) for (const id of mergedProductIds) q += s.quantities[id] ?? 0;
        return q;
    });
    const quantity = isTemplateMode ? templateQuantity : basketQuantity;
    const commit = useCallback((qty: number) => onCommit(product.id, quantity, qty), [onCommit, product.id, quantity]);

    return (
        <BasketProductCard
            name={name}
            imageUrls={imageUrls}
            chainLogos={chainLogos}
            amountText={amountText}
            badge={badge}
            discountBadge={discountBadge}
            product={product}
            quantity={quantity}
            isAdding={isAdding}
            addLabel={addLabel}
            onOpen={onOpen}
            onCommit={commit}
        />
    );
});
