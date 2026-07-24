/**
 * Back-compat shims. All amount/unit display logic now lives in ONE place —
 * `utils/amountDisplay.ts`. These thin wrappers keep older call sites working
 * and delegate there so kg-vs-vnt and the grams/ml polish can never diverge.
 * Prefer importing from amountDisplay directly in new code.
 */
import { isWeightDisplay, formatItemAmount } from './amountDisplay';

/** @deprecated use `isWeightDisplay` from amountDisplay. */
export function isWeighableDisplay(isWeighable: unknown, quantity: number | string): boolean {
    return isWeightDisplay({ isWeighable }, quantity);
}

/**
 * "[amount] [unit]" for a basket/list quantity — delegates to the unified
 * formatter. There's no pack size at these call sites, so packed items show a
 * plain count; a fractional canonicalStep still reads as weight.
 * @deprecated use `formatItemAmount` from amountDisplay.
 */
export function formatAmount(
    quantity: number | string,
    isWeighable: unknown,
    canonicalStep?: number | null,
): string {
    return formatItemAmount({ quantity, isWeighable, canonicalStep });
}
