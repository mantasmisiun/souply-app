import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';
import {
    detectSuspectProducts,
    spliceIkiLines,
    reconcileGap,
    garbageCount,
    acceptReocr,
    maybeReocrProducts,
    suspectReason,
    type ReOcrFn,
} from '../utils/productReocr';

const linesFromFixture = (file: string): IkiLine[] => {
    const pd = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
    return (pd.wordsDump as any[]).map((d) => ({
        text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
        words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
    }));
};
const mkLine = (text: string, yTop: number, yBottom: number): IkiLine =>
    ({ text, xLeft: 60, xRight: 900, yTop, yBottom, words: [{ text, xLeft: 60, xRight: 900, yTop, yBottom }] });
// The dropped/original lines whose y-centre lands in THIS strip (no pad → one strip each) — what
// an isolated-strip crop would return.
const inStrip = (lines: IkiLine[], [yT, yB]: [number, number]): IkiLine[] =>
    lines.filter((l) => { const yc = (l.yTop + l.yBottom) / 2; return yc >= yT && yc <= yB; });

describe('productReocr — pure helpers', () => {
    test('spliceIkiLines drops originals whose y-centre is inside the span, inserts fresh, stays y-sorted', () => {
        const orig = [mkLine('A', 0, 10), mkLine('B', 100, 120), mkLine('C', 200, 210)];   // B centre=110 ∈ [95,125]
        const fresh = [mkLine('B-name', 96, 108), mkLine('B-price', 110, 122)];
        const out = spliceIkiLines(orig, fresh, [95, 125]);
        expect(out.map((l) => l.text)).toEqual(['A', 'B-name', 'B-price', 'C']);
        for (let i = 1; i < out.length; i++) expect(out[i].yTop).toBeGreaterThanOrEqual(out[i - 1].yTop);
        expect(out.find((l) => l.text === 'B')).toBeUndefined();
    });

    test('suspectReason flags no-name / amount-in-name / no-price, clean → null', () => {
        const region = { xLeft: 0, xRight: 900, yTop: 0, yBottom: 50 } as any;
        expect(suspectReason({ name: '?', price: 1, region } as any)).toBe('no-name');
        expect(suspectReason({ name: 'X 1,29 A', price: 1, region } as any)).toBe('amount-in-name');
        expect(suspectReason({ name: 'PIENAS', price: 0, region } as any)).toBe('no-price');
        expect(suspectReason({ name: 'PIENAS', price: 1.29, region } as any)).toBeNull();
    });

    test('reconcileGap = |Σ(promoPrice ?? price)·qty − total|', () => {
        const p = (price: number, promo: number | null, qty = 1) => ({ name: 'X', price, promoPrice: promo, quantity: qty } as any);
        const parsed: any = { products: [p(0.65, 0.32), p(0.10, null)], footer: { total: 0.42 } };
        expect(reconcileGap(parsed)).toBeCloseTo(0, 2);          // 0.32 + 0.10 = 0.42
        expect(reconcileGap({ products: [p(1, null)], footer: { total: 5 } } as any)).toBeCloseTo(4, 2);
        expect(reconcileGap({ products: [], footer: { total: null } } as any)).toBeNull();
    });

    test('acceptReocr: accept on fewer garbage / smaller gap; reject when reconciliation worsens', () => {
        const mk = (products: any[], total: number): any => ({ products, footer: { total } });
        const good = { name: 'PIENAS', price: 1.29, promoPrice: null, quantity: 1 };
        const phantom = { name: '?', price: 0.10, promoPrice: null, quantity: 1 };
        const orig = mk([good, phantom], 1.29);                  // 1 garbage, gap |1.39-1.29|=0.10
        const fixed = mk([good], 1.29);                          // 0 garbage, gap 0
        expect(acceptReocr(orig, fixed)).toBe(true);             // fewer garbage + smaller gap
        const worse = mk([good, { name: 'Y', price: 9.99, promoPrice: null, quantity: 1 }], 1.29); // 0 garbage BUT gap 9.99
        expect(acceptReocr(orig, worse)).toBe(false);            // garbage gone but reconciliation worse → reject
    });
});

describe('productReocr — end-to-end through parseIkiReceipt (clean re-OCR injected)', () => {
    // NO-OP PROOF: a clean receipt has no suspects → re-OCR never fires → SAME object returned.
    test('clean receipt (183) → no suspects, re-OCR not invoked, parsed returned unchanged (byte-identical)', async () => {
        const lines = linesFromFixture('fixtures_ikiReceipt183.json');
        const parsed = parseIkiReceipt(lines);
        expect(detectSuspectProducts(parsed)).toEqual([]);
        const throwing: ReOcrFn = async () => { throw new Error('re-OCR must NOT be called on a clean receipt'); };
        const out = await maybeReocrProducts(parsed, lines, throwing);
        expect(out.accepted).toBe(false);
        expect(out.detail).toBe('no-suspects');
        expect(out.parsed).toBe(parsed);                          // same reference → unchanged
    });

    // '?'-CLEARS: simulate MLKit dropping the KETO name lines (receipt-170) → two "?" products
    // → the injected re-OCR returns the dropped lines for each strip → re-run whole receipt →
    // garbage clears, candidate accepted. The recovery is the literal dropped lines (what an
    // isolated-strip re-OCR would return).
    const dropKeto = () => {
        const full = linesFromFixture('fixtures_ikiReceipt170.json');
        // WORD-boundary so we drop the KETO product-name lines, NOT "moKETOjo" in the PVM header.
        const isKeto = (l: IkiLine) => /\bKETO\b/i.test(l.text);
        return { full, dropped: full.filter(isKeto), degraded: full.filter((l) => !isKeto(l)) };
    };
    test('dropped names → "?" products → injected re-OCR recovers them → accepted, garbage clears', async () => {
        const { full, degraded } = dropKeto();
        const before = parseIkiReceipt(degraded);
        const beforeGarb = garbageCount(before);
        expect(beforeGarb).toBeGreaterThan(0);                        // the drop created suspects

        // A real isolated-strip re-OCR returns the WHOLE strip (name + price) — model that with
        // the full original lines in the strip, so the recovered product keeps its price.
        const stub: ReOcrFn = async (ySpan) => inStrip(full, ySpan);
        const out = await maybeReocrProducts(before, degraded, stub);

        expect(out.accepted).toBe(true);
        expect(garbageCount(out.parsed)).toBeLessThan(beforeGarb);    // strictly fewer garbage products
        expect(reconcileGap(out.parsed) ?? 99).toBeLessThanOrEqual((reconcileGap(before) ?? 0) + 0.05);
    });

    // FAIL-SAFE: a haywire re-OCR that worsens reconciliation must be rejected, original kept —
    // even though it would "clear" the "?" (replacing it with a bogus big-priced product).
    test('haywire re-OCR (worsens reconciliation) → rejected, original kept', async () => {
        const { degraded } = dropKeto();
        const before = parseIkiReceipt(degraded);
        const bogus: ReOcrFn = async (ySpan) => [
            mkLine('BOGUS PRODUKTAS', ySpan[0] + 1, ySpan[0] + 20),
            mkLine('999,99 A', ySpan[0] + 2, ySpan[0] + 21),
        ];
        const out = await maybeReocrProducts(before, degraded, bogus);
        expect(out.accepted).toBe(false);
        expect(out.parsed).toBe(before);                              // original kept
    });
});

describe('productReocr — Phase 2 (expanded signals + reconciliation pre-gate)', () => {
    // Corrupt the unique no-promo ROKIŠKIO price line "2,99 A" → a chosen value, in text + word.
    const corruptPrice = (to: string) => {
        const full = linesFromFixture('fixtures_ikiReceipt170.json');
        const bad = to + ' A';
        const degraded = full.map((l) =>
            l.text.trim() === '2,99 A'
                ? { ...l, text: bad, words: l.words?.map((w) => (w.text === '2,99' ? { ...w, text: to } : w)) }
                : l);
        return { full, degraded };
    };

    test('amount-in-name signal: a 0,00 price leaks into the name + merges the next row → re-OCR recovers → accepted, garbage clears', async () => {
        // OCR'ing 2,99 as 0,00: the parser rejects 0,00 as a price, so "0,00 A" leaks into the name
        // and the next product merges in — an amount-in-name suspect (a Phase 2 signal).
        const { full, degraded } = corruptPrice('0,00');
        const before = parseIkiReceipt(degraded);
        expect(detectSuspectProducts(before).some((s) => s.reason === 'amount-in-name')).toBe(true);
        const stub: ReOcrFn = async (ySpan) => inStrip(full, ySpan);
        const out = await maybeReocrProducts(before, degraded, stub, { reasons: ['amount-in-name'] });
        expect(out.accepted).toBe(true);
        expect(garbageCount(out.parsed)).toBeLessThan(garbageCount(before));
    });

    test('reconciliation pre-gate: a clean-looking mis-OCR\'d price (no per-product suspect) → re-OCR all → gap shrinks → accept', async () => {
        const { full, degraded } = corruptPrice('7,99');     // 2,99 → 7,99 : not garbage, but total off by €5
        const before = parseIkiReceipt(degraded);
        expect(detectSuspectProducts(before)).toEqual([]);    // NO per-product signal
        expect(reconcileGap(before) ?? 0).toBeGreaterThan(1.0);
        const stub: ReOcrFn = async (ySpan) => inStrip(full, ySpan);
        const out = await maybeReocrProducts(before, degraded, stub, { reconcileThreshold: 1.0 });
        expect(out.accepted).toBe(true);
        expect(reconcileGap(out.parsed) ?? 99).toBeLessThan(reconcileGap(before) ?? 0);
    });

    test('reconciliation pre-gate does NOT fire on a deposit-sized gap (≤ threshold)', async () => {
        const lines = linesFromFixture('fixtures_ikiReceipt183.json');   // gap 0.10 — the deposit folds as no-value
        const parsed = parseIkiReceipt(lines);
        expect(detectSuspectProducts(parsed)).toEqual([]);
        expect(reconcileGap(parsed) ?? 0).toBeLessThan(1.0);
        const throwing: ReOcrFn = async () => { throw new Error('must NOT re-OCR a normal deposit-gap receipt'); };
        const out = await maybeReocrProducts(parsed, lines, throwing, { reconcileThreshold: 1.0 });
        expect(out.accepted).toBe(false);
        expect(out.detail).toBe('no-suspects');
        expect(out.parsed).toBe(parsed);
    });
});
