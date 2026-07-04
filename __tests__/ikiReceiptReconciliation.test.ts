import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// RECEIPT RECONCILIATION (Phase 2 of shared/ROBUST_PARSING_PLAN.md):
//   Σ line-paids + dropped charges (deposits/bags/points) − combo = printed total.
// Pinned here:
//   • a PRICE-SHAPED-but-unreadable trailing amount ("3, 4: A" — ':' maps to no digit)
//     CLOSES its product (unknown total + candidate readings) instead of absorbing into
//     the name and merging two products (the receipt-269 oil);
//   • the SINGLE-UNKNOWN SOLVE pins that value from the receipt equation — but ONLY when
//     the delta matches a candidate reading, so unaccounted leakage can never invent a fit;
//   • footer.reconciled reports the balance honestly (true / false / undefined=unchecked).
const line = (text: string, y: number, xLeft = 60, xRight = 900): IkiLine => ({
    text, xLeft, xRight, yTop: y, yBottom: y + 40,
    words: text.split(' ').filter(Boolean).map((w, i, arr) => {
        const step = (xRight - xLeft) / arr.length;
        return { text: w, xLeft: Math.round(xLeft + i * step), xRight: Math.round(xLeft + (i + 1) * step - 10), yTop: y, yBottom: y + 40 };
    }),
});
const receipt = (productLines: IkiLine[], suma: string): IkiLine[] => [
    line('IKI Lietuva, UAB', 0),
    line('PVM mokėtojo kodas LT101937219', 50),
    ...productLines,
    line('Prekiautojo ID 15027037', 900),
    line('Data 2026-06-18 Laikas 11:47:00', 950),
    line(`SUMA ${suma} EUR`, 1000),
];

describe('unknown-total row closes its product (the receipt-269 merge class)', () => {
    test('"3, 4: A" no longer merges two products', () => {
        const res: any = parseIkiReceipt(receipt([
            line('BILLA BIO LINŲ SEMENŲ ALIEJUS 3, 4: A', 100),
            line('SALDZIOSIOS BULVES', 150),
            line('0, 475 kg X 2,49 EUR/ kg 1, 18 A', 200),
        ], '9,99'));
        expect(res.products).toHaveLength(2);
        expect(res.products[0].name).not.toMatch(/BULVES|4:/);
        expect(res.products[1].name).toMatch(/BULVES/);
    });
});

describe('single-unknown solve from the receipt equation', () => {
    const rows = [
        line('OBUOLIAI KLASIKA 2, 99 A', 100),
        line('SVIESTAS ROKISKIO 3, 4: A', 150),
        line('NUOLAIDA SU KORTELE -0, 50 A', 200),
        line('PIENAS NAMINIS 1, 49 A', 250),
    ];

    test('delta matching a candidate reading pins the price (and its promo)', () => {
        // Σ = 2.99 + (T − 0.50) + 1.49 = printed 7.45 → T = 3.47 ∈ {3.40…3.49} ✓
        const res: any = parseIkiReceipt(receipt(rows, '7,45'));
        const butter = res.products.find((p: any) => p.name.includes('SVIESTAS'));
        expect(butter.price).toBeCloseTo(3.47, 2);
        expect(butter.promoPrice).toBeCloseTo(2.97, 2);
        expect(res.footer.reconciled).toBe(true);
    });

    test('a delta matching NO candidate is refused — price stays unknown, receipt flagged', () => {
        // Σ known = 4.48; printed 7.10 → solved T would be 3.12 ∉ {3.40…3.49} → refuse.
        const res: any = parseIkiReceipt(receipt(rows, '7,10'));
        const butter = res.products.find((p: any) => p.name.includes('SVIESTAS'));
        expect(butter.price).toBe(0);
        expect(butter.promoPrice).toBeNull();
        expect(res.footer.reconciled).toBe(false);
    });
});

describe('footer.reconciled on fully-readable receipts', () => {
    test('books balance to the cent → reconciled true', () => {
        const res: any = parseIkiReceipt(receipt([
            line('OBUOLIAI KLASIKA 2, 99 A', 100),
            line('PIENAS NAMINIS 1, 49 A', 150),
        ], '4,48'));
        expect(res.footer.reconciled).toBe(true);
        expect(res.footer.reconDelta).toBeCloseTo(0, 2);
    });

    test('trusted reads that do not balance → reconciled false (honest flag)', () => {
        const res: any = parseIkiReceipt(receipt([
            line('OBUOLIAI KLASIKA 2, 99 A', 100),
            line('PIENAS NAMINIS 1, 49 A', 150),
        ], '4,18'));
        expect(res.footer.reconciled).toBe(false);
        expect(res.footer.reconDelta).toBeCloseTo(-0.30, 2);
    });
});

describe('real receipt 269 — structural win + honest refusal', () => {
    const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt269.json'), 'utf8'));
    const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
        text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
        ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
        words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
    }));
    const res: any = parseIkiReceipt(lines);

    test('7 products — the oil no longer swallows the sweet potatoes', () => {
        expect(res.products).toHaveLength(7);
        const oil = res.products.find((p: any) => p.name.includes('LINŲ'));
        expect(oil.name).not.toMatch(/BULVES/);
    });

    test('the COMPOUND solve recovers everything: sutaupėte pins the cabbage discount, the total pins the oil', () => {
        // eq2: sutaupėte 1.46 − 0.70 (oil) − 0.25 (paprika) = 0.51 → the cabbage's amount-less
        // "HUOLA!DA KORTFLE" discount. eq1 then: delta + 0.70 = 3.49 ∈ {3.40…3.49} ✓ → commit both.
        const oil = res.products.find((p: any) => p.name.includes('LINŲ'));
        expect(oil.price).toBeCloseTo(3.49, 2);
        expect(oil.promoPrice).toBeCloseTo(2.79, 2);
        const cabbage = res.products.find((p: any) => p.name.includes('KOPUSTAI'));
        expect(cabbage.promoPrice).toBeCloseTo(0.98, 2);   // (1.74 − 0.51) / 1.25 kg
        expect(res.footer.reconciled).toBe(true);
    });

    test('savings pin alone is never committed without the total corroborating (safety)', () => {
        // Drop the SUMA line → no equation-1 corroboration → the tentative discount must
        // be discarded: the cabbage keeps promo null rather than an uncorroborated guess.
        const noTotal = lines.filter((l) => !/SUMA|Mokes|Mokė|Banko/i.test(l.text));
        const r2: any = parseIkiReceipt(noTotal);
        const cabbage = r2.products.find((p: any) => p.name.includes('KOPUSTAI'));
        if (cabbage) expect(cabbage.promoPrice).toBeNull();
    });
});
