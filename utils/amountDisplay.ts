/**
 * amountDisplay — the ONE place that decides how a product/item amount is
 * shown. Every surface (catalog stepper, basket sheet, shopping list, receipt
 * details, stats) routes through here so kg-vs-vnt and the grams/ml polish can
 * NEVER diverge again.
 *
 * Two display worlds, one rule set:
 *
 *  • CATALOG (a Product, interactive stepper) — the quantity is CANONICAL
 *    (kg/l for weight items, a piece count for count items). Driven by the
 *    server's `canonicalFamily`. Never divides quantity by a step.
 *
 *  • ITEM (a resolved SP / receipt line / list row, read-only) — driven by the
 *    row's own `isWeighable` + `unit` + pack size. Weighable rows show the
 *    weight; packed rows show "N × pack size".
 *
 * The single decision is WEIGHT vs COUNT (`isWeightDisplay`); everything else
 * (unit label, step, whether a picker opens, the formatted string) follows.
 */

export type UnitToken = 'g' | 'kg' | 'ml' | 'l' | 'vnt' | 'pak' | 'rit';

const MASS_UNITS = new Set(['g', 'kg']);
const VOLUME_UNITS = new Set(['ml', 'l']);
const FLUID_UNITS = new Set(['g', 'kg', 'ml', 'l']);
const COUNT_UNITS = new Set(['vnt', 'pak', 'rit']);

/** Signals any surface might carry; all optional — the resolver uses the best
 *  available, most authoritative first. */
export interface AmountSignals {
    /** Raw flag — the API sends `1 | "1" | true | 0 | null` per driver; coerced. */
    isWeighable?: unknown;
    canonicalFamily?: 'fluid' | 'count' | string | null;
    canonicalUnit?: string | null;
    canonicalStep?: number | null;
    unit?: string | null;
}

const truthyWeighable = (v: unknown): boolean => v === true || Number(v) === 1;
const lc = (u: string | null | undefined): string => (u ?? '').toLowerCase();
/** Trim float noise to at most 3 decimals (250, 1.5, 1.25 — never 1.2500001). */
const trim = (n: number): number => parseFloat(n.toFixed(3));

/**
 * WEIGHT vs COUNT — the one decision. Priority (most authoritative first):
 *   1. canonicalFamily — the server's computed classification (weighable OR
 *      multi-size packed → 'fluid'; single-size / count-unit → 'count').
 *   2. isWeighable — an SP-level truth (sold by weight).
 *   3. a fractional canonicalStep (0.1 / 0.25 / 0.5) — only weight steppers are
 *      sub-1; count steppers are ≥1.
 *   4. a fractional quantity — you can't buy 0,5 of a packed loaf, so it's a
 *      weight (the classic "no 0,5 vnt" guard). A bare fluid UNIT is NOT enough
 *      (a 500 g pack is a count "1 vnt"), so unit alone never forces weight.
 */
export function isWeightDisplay(sig: AmountSignals, quantity?: number | string | null): boolean {
    if (sig.canonicalFamily === 'fluid') return true;
    if (sig.canonicalFamily === 'count') return false;
    if (truthyWeighable(sig.isWeighable)) return true;
    if (sig.canonicalStep != null && sig.canonicalStep > 0 && sig.canonicalStep < 1) return true;
    const q = Number(quantity);
    if (Number.isFinite(q) && q % 1 !== 0) return true;
    return false;
}

/** The count sub-unit to label with (vnt / pak / rit) — defaults to vnt. */
function countUnitToken(sig: AmountSignals): UnitToken {
    const cu = lc(sig.canonicalUnit);
    if (COUNT_UNITS.has(cu)) return cu as UnitToken;
    const u = lc(sig.unit);
    if (COUNT_UNITS.has(u)) return u as UnitToken;
    return 'vnt';
}

/** The weight display unit (kg / l) for a weight-mode signal. */
function weightUnitToken(sig: AmountSignals): 'kg' | 'l' {
    if (lc(sig.canonicalUnit) === 'l') return 'l';
    if (VOLUME_UNITS.has(lc(sig.unit))) return 'l';
    return 'kg';
}

/**
 * Format a SIZE in its natural unit with grams/ml polish:
 *   (500,'g')→500 g   (1500,'g')→1.5 kg   (0.5,'kg')→500 g   (1.5,'kg')→1.5 kg
 *   (500,'ml')→500 ml (0.33,'l')→330 ml   (1,'l')→1 l
 * Count/unknown units pass through as-is. Returns the value + the unit token to
 * label with, so callers keep control of styling and localisation.
 */
export function fmtSize(amount: number, unit?: string | null): { value: number; unit: UnitToken } {
    const u = lc(unit);
    const a = Number(amount);
    if (!Number.isFinite(a)) return { value: 0, unit: (COUNT_UNITS.has(u) ? u : 'vnt') as UnitToken };
    if (MASS_UNITS.has(u)) {
        const grams = u === 'kg' ? a * 1000 : a;
        return grams < 1000 ? { value: Math.round(grams), unit: 'g' } : { value: trim(grams / 1000), unit: 'kg' };
    }
    if (VOLUME_UNITS.has(u)) {
        const ml = u === 'l' ? a * 1000 : a;
        return ml < 1000 ? { value: Math.round(ml), unit: 'ml' } : { value: trim(ml / 1000), unit: 'l' };
    }
    return { value: trim(a), unit: (COUNT_UNITS.has(u) ? u : 'vnt') as UnitToken };
}

/** Localise a unit token. Metric tokens are locale-invariant; count tokens use
 *  the i18n `units.*` keys. `t` is optional so non-React callers still work. */
export function unitLabel(token: UnitToken, t?: (k: string) => string): string {
    if (token === 'g' || token === 'kg' || token === 'ml' || token === 'l') return token;
    return t ? t(`units.${token}`) : token;
}

/** The +/- stepper granularity: 0.1 for weight (deli), 1 for count. */
export function productStep(sig: AmountSignals): number {
    return isWeightDisplay(sig) ? 0.1 : 1;
}

/** Whether tapping Add opens the amount picker (weight items) vs adds one
 *  directly (count items). */
export function productUsesPicker(sig: AmountSignals): boolean {
    return isWeightDisplay(sig);
}

/**
 * CATALOG amount → { value, unit } for the stepper. Quantity is CANONICAL:
 *   weight → the kg/l amount with grams/ml polish (0.5 → 500 g).
 *   count  → the integer piece count (2 → 2 vnt).
 */
export function productAmountParts(sig: AmountSignals, quantity: number): { value: number; unit: UnitToken } {
    if (isWeightDisplay(sig, quantity)) return fmtSize(quantity, weightUnitToken(sig));
    return { value: Math.max(1, Math.round(quantity)), unit: countUnitToken(sig) };
}

/** CATALOG amount as a localised string ("500 g", "2 vnt"). */
export function formatProductAmount(sig: AmountSignals, quantity: number, t?: (k: string) => string): string {
    const { value, unit } = productAmountParts(sig, quantity);
    return `${value} ${unitLabel(unit, t)}`;
}

export interface DisplayItem extends AmountSignals {
    /** weight items: kg/l amount; count items: how many packs. */
    quantity: number | string;
    /** Pack size of the resolved SP (numeric, e.g. 500 with unit 'g'). */
    packAmount?: number | string | null;
    /** Pre-formatted pack size label (receipts store this as text, e.g.
     *  "400 g"); used when a numeric packAmount isn't available. */
    packLabel?: string | null;
    /** Explicit multiplier N when it isn't the quantity (receipts: the number
     *  of merged lines). Defaults to the quantity. */
    multiplier?: number | null;
}

/**
 * ITEM amount (read-only rows: shopping list, receipt, basket details, stats):
 *   weighable                       → the weight ("500 g", "1.5 kg")
 *   packed, fluid unit + pack size  → "N × pack size" ("2 × 500 g")
 *   packed, count unit, multipack   → "N × M vnt" ("1 × 10 vnt")
 *   packed, count unit, single/none → "N vnt"
 */
export function formatItemAmount(item: DisplayItem, t?: (k: string) => string): string {
    const q = Number(item.quantity);
    if (!Number.isFinite(q)) return '';

    // Decide weight-vs-count on the COUNT (an explicit multiplier when present —
    // a packed receipt line's merged-line count — else the quantity), so a
    // fractional weight only triggers weight-mode when there's no pack context.
    const decisionQty = item.multiplier != null ? Number(item.multiplier) : q;
    if (isWeightDisplay(item, decisionQty)) {
        const { value, unit } = fmtSize(q, item.unit ?? item.canonicalUnit ?? 'kg');
        return `${value} ${unitLabel(unit, t)}`;
    }

    const n = Math.max(1, Math.round(item.multiplier != null ? Number(item.multiplier) : q));
    const u = lc(item.unit);
    const packAmt = Number(item.packAmount);
    const hasPackAmt = Number.isFinite(packAmt) && packAmt > 0;

    // Fluid-unit pack (g/ml/kg/l): show the pack size polished — "N × 500 g".
    if (FLUID_UNITS.has(u) && hasPackAmt) {
        const size = fmtSize(packAmt, u);
        return `${n} × ${size.value} ${unitLabel(size.unit, t)}`;
    }
    // Pre-formatted pack label (receipt lines) — "N × 400 g".
    if (item.packLabel) return `${n} × ${item.packLabel}`;
    // Count-unit real multipack (a 10-pack) — "N × 10 vnt".
    if (COUNT_UNITS.has(u) && hasPackAmt && packAmt > 1) {
        return `${n} × ${trim(packAmt)} ${unitLabel(u as UnitToken, t)}`;
    }
    // Plain count — "N vnt" (no redundant "× 1").
    return `${n} ${unitLabel(countUnitToken(item), t)}`;
}

/** Back-compat: the old boolean gate some callers still branch on. Prefer
 *  `isWeightDisplay` / `formatItemAmount`. */
export function isWeighableDisplay(isWeighable: unknown, quantity: number | string): boolean {
    return isWeightDisplay({ isWeighable }, quantity);
}
