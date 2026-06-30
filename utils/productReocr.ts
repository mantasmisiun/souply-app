import {
    parseIkiReceipt,
    type IkiLine,
    type IkiParseResult,
    type IkiProduct,
} from '../shared/parsers/ikiParser';

/**
 * Product-region re-OCR — Phase 0 PURE CORE (no device, no I/O).
 *
 * The IKI parser's recurring band/name failures are an OCR-DATA ceiling: MLKit
 * drops/scrambles/merges per-word boxes in the product section (a name comes back
 * empty → product "?"). The root-cause fix is to re-OCR a cropped+upscaled strip of
 * the image IN ISOLATION (clean, complete, correctly-ordered boxes) and feed those
 * boxes back through the ONE public contract — parseIkiReceipt(IkiLine[]) — re-running
 * the WHOLE receipt so every global post-pass (twin recovery, RINKINYS skip, lead-
 * discount re-home, discPending) re-applies. See memory project_roadmap_product_reocr.
 *
 * This module is the device-INDEPENDENT half: the failure-signal GATE, the SPLICE, and
 * the ACCEPT gate. The actual pixel re-OCR is INJECTED as a callback (`ReOcrFn`) so this
 * whole pipeline is unit-testable with hand-authored "clean re-OCR" IkiLines — only the
 * injected callback is device-only. Off by default; the caller wires the real callback.
 */

// Mirror souply-api reparseMetrics.isGarbage exactly so on-device and the off-device
// regression harness agree on what "garbage" means.
const NAME_HAS_AMOUNT = /-?\d{1,4}[.,]\s?\d{2}\b/;
// A real product band is tens of px tall; below this is a degenerate/collapsed band.
const MIN_BAND_H = 8;

export type SuspectReason = 'no-name' | 'amount-in-name' | 'no-price' | 'collapsed-band' | 'reconciliation';

/** A product is "garbage" by the reparse-harness definition (no-name / amount-in-name / no-price). */
export function isGarbageProduct(p: IkiProduct): boolean {
    const nm = (p.name ?? '').trim();
    if (!nm || nm === '?') return true;
    if (NAME_HAS_AMOUNT.test(nm)) return true;
    if (!(p.price != null && p.price > 0)) return true;
    return false;
}

/** Why a product should be re-OCR'd (garbage signals + a collapsed band), or null if clean. */
export function suspectReason(p: IkiProduct): SuspectReason | null {
    const nm = (p.name ?? '').trim();
    if (!nm || nm === '?') return 'no-name';
    if (NAME_HAS_AMOUNT.test(nm)) return 'amount-in-name';
    if (!(p.price != null && p.price > 0)) return 'no-price';
    const r = p.region;
    if (r && (r.yBottom - r.yTop) < MIN_BAND_H) return 'collapsed-band';
    return null;
}

export interface SuspectStrip {
    index: number;
    reason: SuspectReason;
    /** Source-image y-span of the product's band — the strip to crop+re-OCR + splice. */
    ySpan: [number, number];
}

/** Per-product failure gate. Clean receipts return [] → the caller does nothing (zero cost). */
export function detectSuspectProducts(parsed: IkiParseResult): SuspectStrip[] {
    const out: SuspectStrip[] = [];
    parsed.products.forEach((p, index) => {
        const reason = suspectReason(p);
        if (reason && p.region && p.region.yBottom > p.region.yTop) {
            out.push({ index, reason, ySpan: [p.region.yTop, p.region.yBottom] });
        }
    });
    return out;
}

/** Σ (promoPrice ?? price) × max(quantity,1), rounded — matches reparseMetrics.paidSum. */
export function paidSum(products: IkiProduct[]): number {
    return (
        Math.round(
            products.reduce((s, p) => {
                const unit = p.promoPrice != null ? p.promoPrice : (p.price ?? 0);
                const q = p.quantity && p.quantity > 0 ? p.quantity : 1;
                return s + unit * q;
            }, 0) * 100,
        ) / 100
    );
}

/** |Σpaid − footer.total| (the whole-receipt arithmetic invariant), or null if no total. */
export function reconcileGap(parsed: IkiParseResult): number | null {
    const total = parsed.footer?.total;
    if (total == null) return null;
    return Math.round(Math.abs(paidSum(parsed.products) - total) * 100) / 100;
}

export function garbageCount(parsed: IkiParseResult): number {
    return parsed.products.reduce((n, p) => n + (isGarbageProduct(p) ? 1 : 0), 0);
}

/**
 * Replace the original lines inside a strip with the re-OCR'd ones. Drops every original
 * line whose y-CENTRE falls inside `ySpan`, appends `freshLines`, and re-sorts by yTop so
 * the array stays the y-ordered input parseIkiReceipt expects. Splicing WHOLE IkiLines (not
 * loose words) means each line's host index is assigned naturally by position downstream.
 */
export function spliceIkiLines(mergedLines: IkiLine[], freshLines: IkiLine[], ySpan: [number, number]): IkiLine[] {
    const [yTop, yBottom] = ySpan;
    const kept = mergedLines.filter((l) => {
        const yc = (l.yTop + l.yBottom) / 2;
        return yc < yTop || yc > yBottom;
    });
    const merged = kept.concat(freshLines);
    merged.sort((a, b) => a.yTop - b.yTop);
    return merged;
}

/**
 * The ACCEPT gate: keep the re-run candidate ONLY if it STRICTLY improves (fewer garbage
 * products OR a smaller reconciliation gap) AND does not WORSEN reconciliation beyond
 * `epsilon`. This whole-receipt invariant is stronger than footerBandRefine's per-field
 * "value-not-found keeps original" — it defends against a haywire re-OCR rewriting a clean
 * product. Never accept a candidate that worsens the arithmetic.
 */
export function acceptReocr(
    original: IkiParseResult,
    candidate: IkiParseResult,
    epsilon = 0.05,
): boolean {
    // The re-OCR only re-images the PRODUCT strip — it never touches the footer lines, so the
    // footer total MUST be unchanged. If it moved, the splice corrupted the parse (e.g. a bogus
    // re-OCR line leaked into the total and faked a matching reconciliation) → reject outright.
    const ot = original.footer?.total, ct = candidate.footer?.total;
    if (ot != null && ct != null && Math.abs(ot - ct) > epsilon) return false;

    const origGarb = garbageCount(original);
    const candGarb = garbageCount(candidate);
    const origGap = reconcileGap(original);
    const candGap = reconcileGap(candidate);

    const reconImproved = origGap != null && candGap != null && candGap < origGap - 1e-9;
    const reconWorse = origGap != null && candGap != null && candGap > origGap + epsilon;
    const improved = candGarb < origGarb || reconImproved;
    return improved && !reconWorse;
}

/** Injected device re-OCR: given a strip's source y-span, return clean fresh IkiLines (or null on failure). */
export type ReOcrFn = (
    ySpan: [number, number],
    reason: SuspectReason,
    productIndex: number,
) => Promise<IkiLine[] | null>;

export interface ReocrOptions {
    /** Cap on suspect strips re-OCR'd per receipt (protects the tail). */
    maxStrips?: number;
    /** Reconciliation tolerance for the accept gate. */
    epsilon?: number;
    /** Restrict which per-product signals fire re-OCR (Phase 1 ships 'no-name' only). Default: all. */
    reasons?: SuspectReason[];
    /**
     * Receipt-level pre-gate (Phase 2): when NO per-product signal fires but the receipt doesn't
     * reconcile by MORE than this (|Σpaid − total|), re-OCR the product strips anyway — a product
     * has a clean-looking but mis-OCR'd PRICE. Undefined = off.
     *
     * Keep it ABOVE typical deposit-fold gaps: a bottle DEPOSIT folds as no-value, so every
     * deposit receipt already shows a gap = Σdeposits (0,10 each). ~1.00 cleanly separates a
     * mis-priced product (a single bad price shifts the total by €1-10) from deposit folding, so
     * the pre-gate doesn't waste a re-OCR on every deposit receipt. (The accept gate would reject
     * those anyway — re-OCR can't change a folded deposit — but this avoids the wasted latency.)
     */
    reconcileThreshold?: number;
    /** Cap on strips when only the receipt-level pre-gate fired (it re-OCRs every product). */
    maxReconStrips?: number;
}

export interface ReocrOutcome {
    parsed: IkiParseResult;
    /** True iff the candidate was accepted and is returned. */
    accepted: boolean;
    /** How many strips were re-OCR'd + the gate decision, for devLog/audit. */
    detail: string;
}

/**
 * Orchestrate one re-OCR pass: detect suspect products → re-OCR each via the injected
 * callback → splice all fresh lines into mergedLines → re-run the UNMODIFIED parseIkiReceipt
 * over the WHOLE receipt ONCE → accept only if it strictly improves. FAIL-SAFE: any error,
 * empty re-OCR, or a non-improving / reconciliation-worsening candidate returns the ORIGINAL
 * untouched. `mergedLines` must be the SAME full IkiLine[] originally passed to parseIkiReceipt.
 */
export async function maybeReocrProducts(
    parsed: IkiParseResult,
    mergedLines: IkiLine[],
    reOcr: ReOcrFn,
    opts: ReocrOptions = {},
): Promise<ReocrOutcome> {
    const maxStrips = opts.maxStrips ?? 4;
    const epsilon = opts.epsilon ?? 0.05;
    const reasons = opts.reasons;

    let suspects = detectSuspectProducts(parsed);
    if (reasons) suspects = suspects.filter((s) => reasons.includes(s.reason));
    let cap = maxStrips;
    // RECEIPT-LEVEL pre-gate: nothing flagged per-product, but the receipt doesn't reconcile by
    // more than the threshold → a clean-looking product has a mis-OCR'd price. Re-OCR every
    // product strip (the accept gate keeps it only if the gap actually shrinks). Skipped when the
    // gap is deposit-sized (≤ threshold), so it never fires on a normal deposit receipt.
    if (suspects.length === 0 && opts.reconcileThreshold != null) {
        const gap = reconcileGap(parsed);
        const n = parsed.products.length;
        const reconCap = opts.maxReconStrips ?? 8;
        if (gap != null && gap > opts.reconcileThreshold && n > 0 && n <= reconCap) {
            suspects = parsed.products
                .map((p, index): SuspectStrip | null =>
                    p.region && p.region.yBottom > p.region.yTop
                        ? { index, reason: 'reconciliation', ySpan: [p.region.yTop, p.region.yBottom] }
                        : null)
                .filter((s): s is SuspectStrip => s != null);
            cap = reconCap;
        }
    }
    suspects = suspects.slice(0, cap);
    if (suspects.length === 0) return { parsed, accepted: false, detail: 'no-suspects' };

    let lines = mergedLines;
    let reOcrd = 0;
    for (const s of suspects) {
        let fresh: IkiLine[] | null = null;
        try {
            fresh = await reOcr(s.ySpan, s.reason, s.index);
        } catch {
            fresh = null;
        }
        if (fresh && fresh.length > 0) {
            lines = spliceIkiLines(lines, fresh, s.ySpan);
            reOcrd++;
        }
    }
    if (reOcrd === 0) return { parsed, accepted: false, detail: 're-ocr-empty' };

    let candidate: IkiParseResult;
    try {
        candidate = parseIkiReceipt(lines);
    } catch {
        return { parsed, accepted: false, detail: 're-parse-error' };
    }

    const og = garbageCount(parsed), cg = garbageCount(candidate);
    const ogap = reconcileGap(parsed), cgap = reconcileGap(candidate);
    const detail = `strips=${reOcrd} garb ${og}->${cg} gap ${ogap}->${cgap}`;
    if (acceptReocr(parsed, candidate, epsilon)) {
        return { parsed: candidate, accepted: true, detail: `accept: ${detail}` };
    }
    return { parsed, accepted: false, detail: `reject: ${detail}` };
}
