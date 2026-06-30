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
    maybeReocrFooter,
    maybeReocrHeader,
    productSectionSpan,
    footerSectionSpan,
    headerSectionSpan,
    nameGarbleCount,
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

    test('product re-OCR fixes a mis-OCR\'d price → gap shrinks → accept (fixture-170 also has the ROK1SKI0 garble)', async () => {
        const { full, degraded } = corruptPrice('7,99');     // 2,99 → 7,99 : total off by €5
        const before = parseIkiReceipt(degraded);
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

describe('productReocr — whole-section (handles cross-band scramble)', () => {
    test('productSectionSpan = [min product top, max product bottom]', () => {
        const reg = (yTop: number, yBottom: number) =>
            ({ name: 'X', price: 1, region: { xLeft: 0, xRight: 9, yTop, yBottom } } as any);
        expect(productSectionSpan({ products: [reg(100, 150), reg(160, 220), reg(50, 90)], footer: {} } as any))
            .toEqual([50, 220]);
        expect(productSectionSpan({ products: [], footer: {} } as any)).toBeNull();
    });

    // The key whole-section property: even with MULTIPLE suspects, re-OCR is ONE crop over the
    // entire product section (so displaced content in a DIFFERENT band than the suspect is
    // recovered) — not one crop per suspect band, which per-band re-OCR did and which can't fix
    // a vertical/horizontal scramble.
    test('re-OCR fires ONCE over the whole product section, not one crop per suspect', async () => {
        const full = linesFromFixture('fixtures_ikiReceipt170.json');
        const degraded = full.filter((l) => !/\bKETO\b/i.test(l.text));   // drop the KETO name rows
        const before = parseIkiReceipt(degraded);
        expect(detectSuspectProducts(before).length).toBeGreaterThanOrEqual(1);
        const calls: [number, number][] = [];
        const stub: ReOcrFn = async (ySpan) => { calls.push(ySpan); return inStrip(full, ySpan); };
        const out = await maybeReocrProducts(before, degraded, stub);
        expect(calls.length).toBe(1);                                     // ONE section crop…
        expect(calls[0]).toEqual(productSectionSpan(before));             // …spanning the whole section
        expect(out.accepted).toBe(true);                                  // and it still recovers
        expect(garbageCount(out.parsed)).toBeLessThan(garbageCount(before));
    });
});

describe('productReocr — #3 garbled-name signal', () => {
    test('suspectReason flags a digit wedged inside a word; clean names + edge digits are NOT flagged', () => {
        const region = { xLeft: 0, xRight: 9, yTop: 0, yBottom: 50 } as any;
        const s = (name: string) => suspectReason({ name, price: 1, region } as any);
        expect(s('ROK1SKI0 NAMINE GRIETINE')).toBe('garbled-name');   // ROKIŠKIO, I→1 mid-word
        expect(s('DŽ10VINTOS SLYVOS')).toBe('garbled-name');          // DŽIOVINTOS, IO→10 mid-word
        expect(s('DVARO GRIETINE 30% RIEBUM')).toBeNull();            // 30% is an edge digit
        expect(s('NAMINIS 2,5 PIENAS')).toBeNull();                   // a size, digit at a word edge
        expect(s('LAVAZZA QUALITA ORO')).toBeNull();                  // clean
    });

    test('acceptReocr accepts a candidate that CLEARS a garbled name (gap + garbage unchanged)', () => {
        const mk = (name: string): any => ({ products: [{ name, price: 1.0, promoPrice: null, quantity: 1 }], footer: { total: 1.0 } });
        const before = mk('ROK1SKI0 NAMINE GRIETINE');   // 1 garbled name, gap 0, 0 garbage
        const after = mk('ROKIŠKIO NAMINE GRIETINE');    // name cleared — same gap, same garbage
        expect(nameGarbleCount(before)).toBe(1);
        expect(nameGarbleCount(after)).toBe(0);
        expect(acceptReocr(before, after)).toBe(true);   // rewarded purely for fewer garbled names
        expect(acceptReocr(after, before)).toBe(false);  // and never accepts a candidate that ADDS one
    });
});

describe('productReocr — #1 footer-section re-OCR (smart routing)', () => {
    // Corrupt fixture-183's authoritative total line ("Mokest is Suma su PVM 0, 42") to a wrong value,
    // so the products stay clean but the receipt no longer reconciles — the TOTAL is the suspect.
    const corruptTotal = (to: string) => {
        const full = linesFromFixture('fixtures_ikiReceipt183.json');
        // 0,42 appears only in the footer/payment lines — corrupt wherever it occurs so the total
        // (read from whichever payment line) goes wrong, regardless of its exact source.
        const degraded = full.map((l) =>
            /0,\s?42/.test(l.text) ? { ...l, text: l.text.replace(/0,\s?42/g, to) } : l);
        return { full, degraded };
    };

    test('footerSectionSpan covers the payment-keyword lines below the products', () => {
        const lines = linesFromFixture('fixtures_ikiReceipt183.json');
        const parsed = parseIkiReceipt(lines);
        const span = footerSectionSpan(parsed, lines)!;
        expect(span).not.toBeNull();
        expect(span[0]).toBeGreaterThan(productSectionSpan(parsed)![1]);   // strictly BELOW the products
    });

    test('clean products + wrong total → footer re-OCR re-reads the payment block → reconciles → accept', async () => {
        const { full, degraded } = corruptTotal('9, 42');     // total 0,42 → 9,42 : products clean, gap ~9
        const before = parseIkiReceipt(degraded);
        expect(detectSuspectProducts(before)).toEqual([]);     // products are clean — only the total is wrong
        expect(reconcileGap(before) ?? 0).toBeGreaterThan(1.0);
        const stub: ReOcrFn = async (ySpan) => inStrip(full, ySpan);   // re-OCR returns the CLEAN footer
        const out = await maybeReocrFooter(before, degraded, stub, { reconcileThreshold: 1.0 });
        expect(out.accepted).toBe(true);
        expect(out.parsed.footer.total).toBeCloseTo(0.42, 2);   // total recovered
        expect(reconcileGap(out.parsed) ?? 99).toBeLessThan(reconcileGap(before) ?? 0);
    });

    test('footer re-OCR does NOT fire when products are dirty (fix products first) or already reconciled', async () => {
        const throwing: ReOcrFn = async () => { throw new Error('must NOT re-OCR'); };
        // dirty products → products-dirty
        const full = linesFromFixture('fixtures_ikiReceipt170.json');
        const dropped = full.filter((l) => !/\bKETO\b/i.test(l.text));   // makes "?" products
        const dirty = parseIkiReceipt(dropped);
        expect((await maybeReocrFooter(dirty, dropped, throwing)).detail).toBe('footer:products-dirty');
        // reconciled (small gap) → reconciled
        const clean = linesFromFixture('fixtures_ikiReceipt183.json');
        const ok = parseIkiReceipt(clean);
        expect((await maybeReocrFooter(ok, clean, throwing, { reconcileThreshold: 1.0 })).detail).toBe('footer:reconciled');
    });
});

describe('productReocr — #2 header-section re-OCR', () => {
    test('headerSectionSpan = [0, first product top]', () => {
        const reg = (yTop: number, yBottom: number) =>
            ({ name: 'X', price: 1, region: { xLeft: 0, xRight: 9, yTop, yBottom } } as any);
        expect(headerSectionSpan({ products: [reg(300, 360), reg(370, 420)], footer: {} } as any)).toEqual([0, 300]);
    });

    test('maybeReocrHeader skips (never re-OCRs) when the store address already looks good', async () => {
        const throwing: ReOcrFn = async () => { throw new Error('must NOT re-OCR a good address'); };
        const good: any = { header: { storeAddress: 'Vilniaus g. 220-1, Šiauliai' }, products: [], footer: {} };
        const out = await maybeReocrHeader(good, [], throwing);
        expect(out.accepted).toBe(false);
        expect(out.detail).toBe('header:address-ok');
    });
});
