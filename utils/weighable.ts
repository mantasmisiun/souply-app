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

/**
 * Pack COUNT for a stored canonical quantity: a packaged product's quantity is
 * held in canonical units (a 250 g pack = 0,25 kg), so its count is
 * `quantity ÷ smallest-pack`. 0,25 ÷ 0,25 = 1. Clamped to ≥1 so a rounding
 * blip never shows "0 vnt". Falls back to a plain round when the step is unknown.
 */
export function displayPackCount(quantity: number, canonicalStep: number | null | undefined): number {
    const step = canonicalStep && canonicalStep > 0 ? canonicalStep : null;
    return step ? Math.max(1, Math.round(quantity / step)) : Math.max(1, Math.round(quantity));
}

/**
 * "[amount] [unit]" for a basket/list quantity — the ONE amount formatter every
 * read-only surface (sheets, rows) shares, so kg-vs-vnt can't diverge:
 *   · truly weighable (sold by weight)      → kg with up to 3 decimals;
 *   · packaged (with a known canonical step) → pack count ("1 vnt");
 *   · no step: legacy fallback — a fractional qty is a weight (kg), else a count.
 */
export function formatAmount(quantity: number | string, isWeighable: unknown, canonicalStep?: number | null): string {
    const q = Number(quantity);
    if (!Number.isFinite(q)) return '';
    const flag = isWeighable === true || Number(isWeighable) === 1;
    if (flag) return `${parseFloat(q.toFixed(3))} kg`;
    if (canonicalStep && canonicalStep > 0) return `${displayPackCount(q, canonicalStep)} vnt`;
    if (q % 1 !== 0) return `${parseFloat(q.toFixed(3))} kg`;   // fractional, no step → weight
    return `${Math.round(q)} vnt`;
}
