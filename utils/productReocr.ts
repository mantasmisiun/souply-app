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
// A DIGIT wedged BETWEEN two letters inside a word ("DŽ10VINTOS"←DŽIOVINTOS, "RYZA1S") is almost
// always an OCR letter→digit substitution (I→1, O→0, IO→10), i.e. a garbled NAME. Letters on BOTH
// sides keep it tight: a leading "5L"/"30%"/"2,5kg" (digit at a word edge) is NOT flagged.
// Two more signals from receipt-388 ("SKANĖ JA RYŽIA1 BASMAlI"):
//   - a bare digit ENDING a ≥3-letter uppercase run ("RYŽIA1") — the same I→1 rot at the word
//     edge (size tokens like "5L"/"800G" have the digit FIRST, so they stay out);
//   - a single lowercase 'l' SANDWICHED between uppercase letters ("BASMAlI"←BASMATI, the T's
//     crossbar faded) — genuine mixed-case words carry lowercase RUNS, never one lone letter.
// A false suspect only costs one re-OCR attempt; the accept-guard keeps any no-better read out.
const NAME_GARBLE = /[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]\d+[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]|[A-ZĄČĘĖĮŠŲŪŽ]{3,}\d(?![\d,.:%/])|[A-ZĄČĘĖĮŠŲŪŽ]l[A-ZĄČĘĖĮŠŲŪŽ]/;

export type SuspectReason = 'no-name' | 'amount-in-name' | 'no-price' | 'collapsed-band' | 'garbled-name' | 'reconciliation';

/** A product is "garbage" by the reparse-harness definition (no-name / amount-in-name / no-price). */
export function isGarbageProduct(p: IkiProduct): boolean {
    const nm = (p.name ?? '').trim();
    if (!nm || nm === '?') return true;
    if (NAME_HAS_AMOUNT.test(nm)) return true;
    if (!(p.price != null && p.price > 0)) return true;
    return false;
}

/** Why a product should be re-OCR'd (garbage signals + collapsed band + garbled name), or null. */
export function suspectReason(p: IkiProduct): SuspectReason | null {
    const nm = (p.name ?? '').trim();
    if (!nm || nm === '?') return 'no-name';
    if (NAME_HAS_AMOUNT.test(nm)) return 'amount-in-name';
    if (!(p.price != null && p.price > 0)) return 'no-price';
    const r = p.region;
    if (r && (r.yBottom - r.yTop) < MIN_BAND_H) return 'collapsed-band';
    if (NAME_GARBLE.test(nm)) return 'garbled-name';
    return null;
}

/** A name with a digit wedged inside a word ("DŽ10VINTOS") — an OCR garble worth re-OCR'ing. */
export function isNameGarbled(p: IkiProduct): boolean {
    return NAME_GARBLE.test((p.name ?? '').trim());
}

export function nameGarbleCount(parsed: IkiParseResult): number {
    return parsed.products.reduce((n, p) => n + (isNameGarbled(p) ? 1 : 0), 0);
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
    // Also reward CLEARING a garbled name ("DŽ10VINTOS" → "DŽIOVINTOS"): a name fix changes neither
    // garbage count nor reconciliation, so without this signal the accept gate would reject it.
    const origNameG = nameGarbleCount(original);
    const candNameG = nameGarbleCount(candidate);

    const reconImproved = origGap != null && candGap != null && candGap < origGap - 1e-9;
    const reconWorse = origGap != null && candGap != null && candGap > origGap + epsilon;
    const improved = candGarb < origGarb || candNameG < origNameG || reconImproved;
    return improved && !reconWorse;
}

/** Injected device re-OCR: given a strip's source y-span, return clean fresh IkiLines (or null on failure). */
export type ReOcrFn = (
    ySpan: [number, number],
    reason: string,            // a label for logging (the trigger reason / section)
    productIndex: number,
) => Promise<IkiLine[] | null>;

/**
 * The y-span covering the WHOLE product section — first product's top to last product's bottom.
 * Whole-section re-OCR re-images this entire strip in ONE fresh isolated pass, so a mis-OCR that
 * displaced a price/name ACROSS bands (a vertical scramble like receipt-197's orphaned price, or
 * a horizontal name/weight interleave like receipt-198) comes back in the right place — which
 * per-band re-OCR (cropping a single suspect's band) cannot fix, because the displaced content
 * lives in a DIFFERENT band than the suspect. The footer is deliberately excluded (it parses more
 * reliably from the original lines + footerBandRefine).
 */
export function productSectionSpan(parsed: IkiParseResult): [number, number] | null {
    let top = Infinity, bottom = -Infinity;
    for (const p of parsed.products) {
        const r = p.region;
        if (r && r.yBottom > r.yTop) { top = Math.min(top, r.yTop); bottom = Math.max(bottom, r.yBottom); }
    }
    return bottom > top ? [top, bottom] : null;
}

/** Lines whose y-CENTRE falls within the span (drops any header/footer the crop's pad picked up). */
function linesInSpan(lines: IkiLine[], [yTop, yBottom]: [number, number]): IkiLine[] {
    return lines.filter((l) => {
        const yc = (l.yTop + l.yBottom) / 2;
        return yc >= yTop && yc <= yBottom;
    });
}

/**
 * HEADER section span — everything above the first product (store name + address). Re-OCR'd to
 * recover a garbled/dropped store address (the street-word split "Vilniaus"→"Vi IniauS").
 */
export function headerSectionSpan(parsed: IkiParseResult): [number, number] | null {
    const sec = productSectionSpan(parsed);
    if (!sec) return null;
    return sec[0] > 1 ? [0, sec[0]] : null;
}

// The payment block names the total / VAT / cash. Re-OCR'ing that strip recovers a scrambled
// payment TABLE (the wrong-total case, receipt-199: a column-shuffle gave a phantom 8,42).
const PAYMENT_KEYWORD = /Mok[eė]t[ia]|Mokestis|\bSUMA\b|Suma\s+su\s+P[VU]M|Grynieji|Gr[aą][žz]a|Be\s+PVM|PVM\s+suma|Pirkini/i;
/** FOOTER/payment section span — the y-range of payment-keyword lines BELOW the products. */
export function footerSectionSpan(parsed: IkiParseResult, lines: IkiLine[]): [number, number] | null {
    const sec = productSectionSpan(parsed);
    const after = sec ? sec[1] : 0;
    let top = Infinity, bottom = -Infinity;
    for (const l of lines) {
        if ((l.yTop + l.yBottom) / 2 > after && PAYMENT_KEYWORD.test(l.text)) {
            top = Math.min(top, l.yTop); bottom = Math.max(bottom, l.yBottom);
        }
    }
    return bottom > top ? [top, bottom] : null;
}

/** A crude "how good is this store address" score (street word + a house number + length). */
function addressScore(addr?: string | null): number {
    const a = (addr ?? '').trim();
    if (!a) return 0;
    let s = Math.min(a.length, 40);
    if (/\b(g\.|gatv[ėe]|pr\.|al[ėe]ja|prospekt|pl\.)/i.test(a)) s += 50;   // a street word
    if (/\d/.test(a)) s += 20;                                              // a house number
    return s;
}
const GOOD_ADDRESS_SCORE = 60;   // street word + a number is already good enough → don't re-OCR

/**
 * FOOTER accept: the footer re-OCR is ALLOWED to change the total (that's the point). Keep the
 * candidate iff the products are untouched (same count, no new garbage) AND the new total makes the
 * receipt reconcile STRICTLY better. A bad re-read can't win — only a smaller |Σpaid − total| does.
 */
export function acceptFooterReocr(original: IkiParseResult, candidate: IkiParseResult, epsilon = 0.05): boolean {
    if (candidate.products.length !== original.products.length) return false;
    if (garbageCount(candidate) > garbageCount(original)) return false;
    const ogap = reconcileGap(original), cgap = reconcileGap(candidate);
    if (ogap == null || cgap == null) return false;
    return cgap < ogap - epsilon;
}

/** HEADER accept: products + total untouched; keep iff the store address scores HIGHER (recovered). */
export function acceptHeaderReocr(original: IkiParseResult, candidate: IkiParseResult, epsilon = 0.05): boolean {
    if (candidate.products.length !== original.products.length) return false;
    if (garbageCount(candidate) > garbageCount(original)) return false;
    const ot = original.footer?.total, ct = candidate.footer?.total;
    if (ot != null && ct != null && Math.abs(ot - ct) > epsilon) return false;
    return addressScore(candidate.header?.storeAddress) > addressScore(original.header?.storeAddress);
}

export interface ReocrOptions {
    /** Reconciliation tolerance for the accept gate. */
    epsilon?: number;
    /** Restrict which per-product signals fire the PRODUCT re-OCR. Default: all of them. */
    reasons?: SuspectReason[];
    /** Receipt-level gap (|Σpaid − total|) above which the FOOTER re-OCR fires (default 1.0 — above
     *  deposit-fold noise). Also used as the product re-OCR's reconciliation pre-gate when passed. */
    reconcileThreshold?: number;
}

export interface ReocrOutcome {
    parsed: IkiParseResult;
    /** The line stream after this pass — spliced if accepted, else the input (so passes can chain). */
    lines: IkiLine[];
    accepted: boolean;
    /** The trigger + gate decision + deltas, for devLog/telemetry. */
    detail: string;
}

/**
 * The shared engine for ALL section re-OCR: re-OCR `span` in one isolated pass via the injected
 * callback → splice the fresh lines (clamped to the span) over the originals → re-run the UNMODIFIED
 * parseIkiReceipt → keep it ONLY if `accept` says it strictly improves. FAIL-SAFE: any error / empty
 * re-OCR / rejected candidate returns the ORIGINAL parse + lines untouched.
 */
async function runSectionReocr(
    parsed: IkiParseResult,
    mergedLines: IkiLine[],
    reOcr: ReOcrFn,
    span: [number, number],
    label: string,
    accept: (orig: IkiParseResult, cand: IkiParseResult) => boolean,
): Promise<ReocrOutcome> {
    let fresh: IkiLine[] | null = null;
    try { fresh = await reOcr(span, label, -1); } catch { fresh = null; }
    const freshInSpan = fresh ? linesInSpan(fresh, span) : [];
    if (freshInSpan.length === 0) return { parsed, lines: mergedLines, accepted: false, detail: `${label}:re-ocr-empty` };

    const lines = spliceIkiLines(mergedLines, freshInSpan, span);
    let candidate: IkiParseResult;
    try { candidate = parseIkiReceipt(lines); } catch { return { parsed, lines: mergedLines, accepted: false, detail: `${label}:re-parse-error` }; }

    const og = garbageCount(parsed), cg = garbageCount(candidate);
    const ogap = reconcileGap(parsed), cgap = reconcileGap(candidate);
    const detail = `${label} lines=${freshInSpan.length} garb ${og}->${cg} gap ${ogap}->${cgap} total ${parsed.footer?.total}->${candidate.footer?.total}`;
    if (accept(parsed, candidate)) return { parsed: candidate, lines, accepted: true, detail: `accept: ${detail}` };
    return { parsed, lines: mergedLines, accepted: false, detail: `reject: ${detail}` };
}

/**
 * PRODUCT-section re-OCR: fire on a per-product suspect (dropped name / garbled name / no-price /
 * amount-in-name / collapsed band), or — when `reconcileThreshold` is set and nothing is flagged
 * per product — a reconciliation gap. Re-OCRs the WHOLE product section in one pass, which fixes
 * cross-band scrambles (a price boxed above its name, a name/weight interleave) that a single
 * suspect's band can't. Footer total must stay unchanged.
 */
export async function maybeReocrProducts(
    parsed: IkiParseResult,
    mergedLines: IkiLine[],
    reOcr: ReOcrFn,
    opts: ReocrOptions = {},
): Promise<ReocrOutcome> {
    const epsilon = opts.epsilon ?? 0.05;
    const reasons = opts.reasons;
    let suspects = detectSuspectProducts(parsed);
    if (reasons) suspects = suspects.filter((s) => reasons.includes(s.reason));
    let trigger: string | null = suspects[0]?.reason ?? null;
    if (!trigger && opts.reconcileThreshold != null) {
        const gap = reconcileGap(parsed);
        if (gap != null && gap > opts.reconcileThreshold) trigger = 'reconciliation';
    }
    if (!trigger) return { parsed, lines: mergedLines, accepted: false, detail: 'no-suspects' };
    const span = productSectionSpan(parsed);
    if (!span) return { parsed, lines: mergedLines, accepted: false, detail: 'no-span' };
    return runSectionReocr(parsed, mergedLines, reOcr, span, `products(${trigger})`, (o, c) => acceptReocr(o, c, epsilon));
}

/**
 * FOOTER-section re-OCR (smart routing): fire ONLY when the products are CLEAN but the receipt
 * doesn't reconcile by more than `reconcileThreshold` → the TOTAL is the suspect, not a product
 * (receipt-199's phantom 8,42). Re-OCR the payment block; keep it iff the new total reconciles
 * better. If products are dirty, fix them with maybeReocrProducts first.
 */
export async function maybeReocrFooter(
    parsed: IkiParseResult,
    mergedLines: IkiLine[],
    reOcr: ReOcrFn,
    opts: ReocrOptions = {},
): Promise<ReocrOutcome> {
    const epsilon = opts.epsilon ?? 0.05;
    const threshold = opts.reconcileThreshold ?? 1.0;
    if (detectSuspectProducts(parsed).length > 0) return { parsed, lines: mergedLines, accepted: false, detail: 'footer:products-dirty' };
    const gap = reconcileGap(parsed);
    if (gap == null || gap <= threshold) return { parsed, lines: mergedLines, accepted: false, detail: 'footer:reconciled' };
    const span = footerSectionSpan(parsed, mergedLines);
    if (!span) return { parsed, lines: mergedLines, accepted: false, detail: 'footer:no-span' };
    return runSectionReocr(parsed, mergedLines, reOcr, span, 'footer', (o, c) => acceptFooterReocr(o, c, epsilon));
}

/**
 * HEADER-section re-OCR: fire only when the parsed store address looks garbled/missing. Re-OCR the
 * header strip; keep it iff the recovered address scores higher (products + total untouched). The
 * store usually matches by id anyway, so this mainly improves the displayed/searchable address.
 */
export async function maybeReocrHeader(
    parsed: IkiParseResult,
    mergedLines: IkiLine[],
    reOcr: ReOcrFn,
    opts: ReocrOptions = {},
): Promise<ReocrOutcome> {
    const epsilon = opts.epsilon ?? 0.05;
    if (addressScore(parsed.header?.storeAddress) >= GOOD_ADDRESS_SCORE) return { parsed, lines: mergedLines, accepted: false, detail: 'header:address-ok' };
    const span = headerSectionSpan(parsed);
    if (!span) return { parsed, lines: mergedLines, accepted: false, detail: 'header:no-span' };
    return runSectionReocr(parsed, mergedLines, reOcr, span, 'header', (o, c) => acceptHeaderReocr(o, c, epsilon));
}
