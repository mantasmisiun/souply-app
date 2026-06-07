/**
 * Whether to display/treat a basket or list item as weighable (kg) vs pieces
 * (vnt). Two robustness rules baked in:
 *
 *  1. Coerce the raw flag — the API may send `1 | "1" | true` depending on the
 *     SQL aggregation / driver, so a strict `=== 1` would wrongly read "vnt".
 *  2. A FRACTIONAL quantity can only be a weight — you can't buy 0,5 of a
 *     packaged loaf — so any fractional qty is weighable even when the item's
 *     StoreProducts aren't flagged `isWeighable` (common on sparse data). This
 *     is what prevents the nonsensical "0,5 vnt" we hit with bread.
 */
export function isWeighableDisplay(isWeighable: unknown, quantity: number | string): boolean {
    const flag = isWeighable === true || Number(isWeighable) === 1;
    const q = Number(quantity);
    return flag || (Number.isFinite(q) && q % 1 !== 0);
}
