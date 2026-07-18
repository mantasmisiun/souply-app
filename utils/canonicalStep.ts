/**
 * Resolve the canonical step + display unit for a Product on the client.
 *
 * The server attaches `canonicalUnit` / `canonicalStep` / `canonicalFamily`
 * to every Product fetched from the browse / discounts / detail endpoints
 * (see basket-api/src/services/productCanonical.ts). When those are
 * present (which they always should be on current builds), they're used
 * verbatim — they're the same values the basket calc service uses for
 * cheapest-per-pack math, so the UI stays consistent with the price.
 *
 * Legacy fallback: when canonicalUnit is null (cached old responses,
 * old clients, or Products with no SPs at all), we map g→kg, ml→l, and
 * pick step 0.1 for weighable/kg/l, 1 otherwise. This matches the
 * pre-canonical defaults so the UI doesn't break for in-flight builds.
 */
export interface ProductCanonical {
    canonicalUnit?: string | null;
    canonicalStep?: number | null;
    canonicalFamily?: 'fluid' | 'count' | null;
    /** Either of these signals "sold by weight". Different endpoints use
     *  different field names — accept both. */
    isWeighable?: boolean;
    hasWeighable?: boolean | number;
    unit?: string | null;
}

export function resolveDisplayUnit(p: ProductCanonical): string {
    if (p.canonicalUnit) return p.canonicalUnit;
    const u = p.unit;
    if (u === 'g') return 'kg';
    if (u === 'ml') return 'l';
    return u ?? '';
}

/** The canonical unit KEY to show next to a quantity: one of
 *  kg / l / vnt / pak / rit. Callers localise it via `t('units.<key>')`.
 *
 *  Unlike resolveDisplayUnit this NEVER maps the raw `unit` field (the browse /
 *  discounts endpoints hardcode `'g'`, so mapping g→kg painted count items — a
 *  book, a single can — as "1 kg"). Only a real canonical unit or an explicit
 *  weighable flag yields kg/l; everything else is a countable pack → 'vnt'
 *  (localised to pcs / units in EN). This mirrors resolveCanonicalStep, so the
 *  displayed unit and the step granularity can never disagree. */
export function resolveDisplayUnitKey(p: ProductCanonical): 'kg' | 'l' | 'vnt' | 'pak' | 'rit' {
    const cu = p.canonicalUnit;
    if (cu === 'kg' || cu === 'l' || cu === 'vnt' || cu === 'pak' || cu === 'rit') return cu;
    if (p.isWeighable ?? p.hasWeighable) return 'kg';
    return 'vnt';
}

export function resolveCanonicalStep(p: ProductCanonical): number {
    if (p.canonicalStep && p.canonicalStep > 0) return p.canonicalStep;
    // Weighable always steps in deli granularity.
    if (p.isWeighable ?? p.hasWeighable) return 0.1;
    // Only a *computed* canonical fluid/weight unit justifies a 0.1 step. The
    // raw `unit` field is an unreliable fallback — the browse endpoint hardcodes
    // `'g'` for every product — so basing the step on it makes a count item
    // (e.g. a single-SP 330 ml can with no amount/unit) add as "0,1" instead of
    // "1". With no canonicalUnit the item is a pack → step 1.
    if (p.canonicalUnit === 'kg' || p.canonicalUnit === 'l') return 0.1;
    return 1;
}

/**
 * Round a free-form numeric input up to the next valid step multiple ≥ step.
 * The picker uses this on confirm so the user can't request a quantity that
 * doesn't correspond to a whole pack.
 */
export function snapUpToStep(value: number, step: number): number {
    if (!Number.isFinite(value) || value <= 0) return step;
    const snapped = Math.max(step, Math.ceil(value / step) * step);
    return Math.round(snapped * 1000) / 1000;
}
