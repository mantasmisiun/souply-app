/**
 * PER-ITEM TRUTH (v2) — review a batch receipt ONCE, checkmark the products
 * that parsed correctly, and every later run compares itself against those
 * assertions so only regressions need eyes.
 *
 * Files live next to the legacy hand-annotated truths
 * (shared/receipts/<chain>/<basename>.truth.json — git-versioned approvals)
 * and are distinguished by `version: 2`. Legacy files keep flowing through
 * utils/compareToTruth unchanged.
 *
 * Semantics: only CHECKMARKED products exist in the file — everything else
 * is "unknown", never "wrong". A checkmark stores the product's CURRENT
 * parse snapshot; re-checking overwrites it; long-press removes it.
 */

export interface ItemTruthProduct {
    name: string;
    price: number;
    promoPrice: number | null;
    quantity: number;
    unit: string;
    parsedAmount: number | null;
    parsedUnit: string | null;
    checkedAt: string;
}

export interface ItemTruthFooter {
    total: number | null;
    date: string | null;
    receiptNo: string | null;
    reconciled: boolean | null;
    checkedAt: string;
}

export interface ItemTruthFile {
    version: 2;
    source: string;
    products: ItemTruthProduct[];
    footer: ItemTruthFooter | null;
}

/** Loose parsed-product shape (all chains are structurally identical here). */
export interface ParsedProductLike {
    name?: string | null;
    price?: number;
    promoPrice?: number | null;
    quantity?: number;
    unit?: string;
    parsedAmount?: number | null;
    parsedUnit?: string | null;
}

export interface ParsedFooterLike {
    total?: number | null;
    date?: string | null;
    receiptNo?: string | null;
    reconciled?: boolean | null;
}

export type ProductTruthState = 'unchecked' | 'match' | 'near' | 'differ';

export interface ProductTruthComparison {
    state: ProductTruthState;
    /** Index into truth.products when matched (match/differ). */
    truthIdx: number | null;
    /** Human-readable field diffs, e.g. "price 1.19 → 1.25". */
    diffs: string[];
}

export interface TruthComparison {
    /** Aligned 1:1 with the parsed products passed in. */
    perProduct: ProductTruthComparison[];
    /** Truth products the parse LOST entirely. */
    missing: ItemTruthProduct[];
    footer: 'none' | 'match' | 'differ';
    footerDiffs: string[];
    /** Roll-up for the batch list icon:
     *  ok        — ≥1 assertion, all match (incl. near), nothing missing;
     *  attention — any differ / missing / footer differ;
     *  partial   — assertions all match but some products unchecked;
     *  none      — no assertions at all.
     *  NEAR counts as acceptable: the two OCR engines garble names in
     *  different, characteristic ways (iOS drops diacritics, Android swaps
     *  m→n / O→0), so a strict name compare flags every cross-engine run.
     *  Numeric fields stay STRICT — a near name with a price diff is differ. */
    summary: 'ok' | 'attention' | 'partial' | 'none';
}

const fold = (s: string): string =>
    s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Spaceless fold: OCR injects mid-word spaces nondeterministically
 *  ("Val gomieji batat ai" ↔ "Valgomieji batatai" across ios-55 runs) —
 *  token comparison sees ZERO overlap and the same product mints a
 *  duplicate truth entry instead of replacing its old one. */
const foldTight = (s: string): string => fold(s).replace(/ /g, '');

/** Normalized char-level similarity of the folded, spaceless names —
 *  1 − levenshtein/maxLen. ≥ NEAR_NAME_SIM ⇒ same product, different OCR
 *  flavor ('near'); below ⇒ a real name difference ('differ'). */
export const NEAR_NAME_SIM = 0.85;
export const nameSimilarity = (a: string, b: string): number => {
    const fa = foldTight(a);
    const fb = foldTight(b);
    if (fa === fb) return 1;
    if (!fa.length || !fb.length) return 0;
    const m = fa.length, n = fb.length;
    let prev = new Array(n + 1).fill(0).map((_, j) => j);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) {
            cur[j] = Math.min(
                prev[j] + 1,
                cur[j - 1] + 1,
                prev[j - 1] + (fa[i - 1] === fb[j - 1] ? 0 : 1),
            );
        }
        prev = cur;
    }
    return 1 - prev[n] / Math.max(m, n);
};

const tokenSim = (a: string, b: string): number => {
    const fa = foldTight(a);
    if (fa.length > 0 && fa === foldTight(b)) return 1;
    const ta = new Set(fold(a).split(' ').filter(Boolean));
    const tb = new Set(fold(b).split(' ').filter(Boolean));
    if (ta.size === 0 || tb.size === 0) return 0;
    let hit = 0;
    for (const t of ta) if (tb.has(t)) hit++;
    return hit / Math.min(ta.size, tb.size);
};

const numEq = (a: number | null | undefined, b: number | null | undefined, eps = 0.005): boolean => {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    return Math.abs(a - b) < eps;
};

export const truthFromParsed = (p: ParsedProductLike, checkedAt: string): ItemTruthProduct => ({
    name: p.name ?? '',
    price: p.price ?? 0,
    promoPrice: p.promoPrice ?? null,
    quantity: p.quantity ?? 1,
    unit: p.unit ?? 'vnt',
    parsedAmount: p.parsedAmount ?? null,
    parsedUnit: p.parsedUnit ?? null,
    checkedAt,
});

export const footerFromParsed = (f: ParsedFooterLike, checkedAt: string): ItemTruthFooter => ({
    total: f.total ?? null,
    date: f.date ?? null,
    receiptNo: f.receiptNo ?? null,
    reconciled: f.reconciled ?? null,
    checkedAt,
});

function productDiffs(t: ItemTruthProduct, p: ParsedProductLike): { diffs: string[]; nameOnlyNear: boolean } {
    const diffs: string[] = [];
    let nameNear = false;
    // Spacing/diacritic-insensitive: mid-word space injection varies run to
    // run on photos — flagging it every run is pure review fatigue. Real
    // character garbles ("aisto garmin." vs "maisto gamin.") still flag —
    // unless they're WITHIN the near-similarity band (cross-OCR-engine
    // flavor), which tiers the pair as 'near' instead of 'differ'.
    if (foldTight(p.name ?? '') !== foldTight(t.name)) {
        nameNear = nameSimilarity(p.name ?? '', t.name) >= NEAR_NAME_SIM;
        diffs.push(`name "${t.name}" → "${p.name ?? ''}"`);
    }
    if (!numEq(t.price, p.price ?? 0)) diffs.push(`price ${t.price} → ${p.price ?? 0}`);
    if (!numEq(t.promoPrice, p.promoPrice ?? null)) diffs.push(`akcija ${t.promoPrice ?? '—'} → ${p.promoPrice ?? '—'}`);
    if (!numEq(t.quantity, p.quantity ?? 1)) diffs.push(`qty ${t.quantity} → ${p.quantity ?? 1}`);
    if ((p.unit ?? 'vnt') !== t.unit) diffs.push(`unit ${t.unit} → ${p.unit ?? 'vnt'}`);
    if (!numEq(t.parsedAmount, p.parsedAmount ?? null, 0.001) || (t.parsedAmount != null && (p.parsedUnit ?? null) !== t.parsedUnit)) {
        diffs.push(`amount ${t.parsedAmount ?? '—'}${t.parsedUnit ?? ''} → ${p.parsedAmount ?? '—'}${p.parsedUnit ?? ''}`);
    }
    // 'near' only when the NAME is the sole difference and it's within the
    // similarity band — numeric fields are ground truth and stay strict.
    return { diffs, nameOnlyNear: nameNear && diffs.length === 1 };
}

/**
 * Match truth products to parsed products (greedy best-score 1:1 — indices
 * shift between runs, so identity is name similarity + price/qty agreement)
 * and diff every matched pair.
 */
export function compareItemTruth(
    truth: ItemTruthFile | null,
    products: ParsedProductLike[],
    footer: ParsedFooterLike | null,
): TruthComparison {
    const perProduct: ProductTruthComparison[] = products.map(() => ({ state: 'unchecked', truthIdx: null, diffs: [] }));
    const none: TruthComparison = { perProduct, missing: [], footer: 'none', footerDiffs: [], summary: 'none' };
    if (!truth || (truth.products.length === 0 && !truth.footer)) return none;

    // Greedy pairing by composite score.
    const takenParsed = new Set<number>();
    const pairs: { ti: number; pi: number }[] = [];
    const scored: { ti: number; pi: number; score: number }[] = [];
    truth.products.forEach((t, ti) => {
        products.forEach((p, pi) => {
            // Char-level similarity joins the token overlap: cross-engine
            // garbles (O→0, m→n, mid-word spaces) zero out shared TOKENS for
            // the same product ("Saldainiai OBUOLIUKAI" ↔ "Saldai niai
            // 0BUOLIUKAI") and reported it LOST + a phantom unchecked twin.
            const sim = Math.max(tokenSim(t.name, p.name ?? ''), nameSimilarity(t.name, p.name ?? ''));
            const priceOk = numEq(t.price, p.price ?? 0) ? 1 : 0;
            const qtyOk = numEq(t.quantity, p.quantity ?? 1) ? 0.5 : 0;
            const score = sim * 2 + priceOk + qtyOk;
            if (sim >= 0.5 || (priceOk && sim >= 0.25)) scored.push({ ti, pi, score });
        });
    });
    scored.sort((a, b) => b.score - a.score);
    const takenTruth = new Set<number>();
    for (const s of scored) {
        if (takenTruth.has(s.ti) || takenParsed.has(s.pi)) continue;
        takenTruth.add(s.ti);
        takenParsed.add(s.pi);
        pairs.push({ ti: s.ti, pi: s.pi });
    }

    const missing: ItemTruthProduct[] = truth.products.filter((_, ti) => !takenTruth.has(ti));
    for (const { ti, pi } of pairs) {
        const { diffs, nameOnlyNear } = productDiffs(truth.products[ti], products[pi]);
        const state: ProductTruthState = diffs.length === 0 ? 'match' : nameOnlyNear ? 'near' : 'differ';
        perProduct[pi] = { state, truthIdx: ti, diffs };
    }

    let footerState: TruthComparison['footer'] = 'none';
    const footerDiffs: string[] = [];
    if (truth.footer) {
        const tf = truth.footer;
        const pf = footer ?? {};
        if (!numEq(tf.total, pf.total ?? null)) footerDiffs.push(`total ${tf.total ?? '—'} → ${pf.total ?? '—'}`);
        if ((pf.date ?? null) !== tf.date) footerDiffs.push(`date ${tf.date ?? '—'} → ${pf.date ?? '—'}`);
        if ((pf.receiptNo ?? null) !== tf.receiptNo) footerDiffs.push(`nr ${tf.receiptNo ?? '—'} → ${pf.receiptNo ?? '—'}`);
        if ((pf.reconciled ?? null) !== tf.reconciled) footerDiffs.push(`recon ${tf.reconciled ?? '—'} → ${pf.reconciled ?? '—'}`);
        footerState = footerDiffs.length ? 'differ' : 'match';
    }

    const anyDiffer = perProduct.some((p) => p.state === 'differ') || missing.length > 0 || footerState === 'differ';
    const anyUnchecked = perProduct.some((p) => p.state === 'unchecked') || footerState === 'none';
    const summary: TruthComparison['summary'] = anyDiffer ? 'attention' : anyUnchecked ? 'partial' : 'ok';
    return { perProduct, missing, footer: footerState, footerDiffs, summary };
}

/** Is this JSON blob a v2 item-truth file? (Legacy truths lack `version`.) */
export const isItemTruthFile = (j: any): j is ItemTruthFile =>
    !!j && j.version === 2 && Array.isArray(j.products);
