import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// ROW SOLVER (Phase 1 of shared/ROBUST_PARSING_PLAN.md): a weighed IKI line is an
// arithmetic identity — printed total = round2(kg × €/kg). The solver uses it to:
//   RECOVER   a total whose read failed every lane ("0, 7? A" — the receipt-268 agurkai);
//   OVERRULE  a risky fallback-lane total (headless/bare/garbled = totSoft) that
//             contradicts the locked arithmetic (a foreign amount drifting onto the
//             calc row can no longer become the total);
//   NEVER touch a strict word-box total (printed-vs-computed mismatch on trusted reads
//             is a receipt-level concern, not a silent rewrite).
const line = (text: string, y: number, xLeft = 60, xRight = 900): IkiLine => ({
    text, xLeft, xRight, yTop: y, yBottom: y + 40,
    words: text.split(' ').filter(Boolean).map((w, i, arr) => {
        const step = (xRight - xLeft) / arr.length;
        return { text: w, xLeft: Math.round(xLeft + i * step), xRight: Math.round(xLeft + (i + 1) * step - 10), yTop: y, yBottom: y + 40 };
    }),
});

const receipt = (productLines: IkiLine[]): IkiLine[] => [
    line('IKI Lietuva, UAB', 0),
    line('PVM mokėtojo kodas LT101937219', 50),
    ...productLines,
    line('Prekiautojo ID 15027037', 900),
    line('Data 2026-06-18 Laikas 11:47:00', 950),
    line('SUMA 9,99 EUR', 1000),
];

const parse = (productLines: IkiLine[]) => (parseIkiReceipt(receipt(productLines)) as any).products;

describe('weighed row solver — RECOVER', () => {
    test('unreadable total ("0, 7? A") derives from kg × €/kg', () => {
        const p = parse([
            line('TRUMPAVAISIAI AGURKAI', 100),
            line('0, 245 kg X 2,99 EUR/ kg 0, 7? A', 150),
        ]);
        expect(p).toHaveLength(1);
        expect(p[0].price).toBeCloseTo(2.99, 2);
        expect(p[0].quantity).toBeCloseTo(0.245, 3);
        // total recovered 0.73 → with a discount it would price the promo; here it
        // proves itself via the rawLines-independent promo math below.
    });

    test('recovered total prices the promo when a discount follows', () => {
        const p = parse([
            line('SVIEZI KOPUSTAI', 100),
            line('1,250 kg X 1,39 EUR/ kg', 150),          // total never printed readable
            line('NUOLAIDA SU KORTELE -0, 24 A', 200),
        ]);
        expect(p).toHaveLength(1);
        expect(p[0].price).toBeCloseTo(1.39, 2);
        // total = round2(1.25 × 1.39) = 1.74; promo = (1.74 − 0.24) / 1.25 = 1.20 €/kg
        expect(p[0].promoPrice).toBeCloseTo(1.20, 2);
    });
});

describe('weighed row solver — OVERRULE vs CORROBORATE', () => {
    test('a bare-digit soft total contradicting locked kg × €/kg is overruled by the math', () => {
        // bare "99 A" would read 0.99, but 0.500 × 2.00 = 1.00 — the equation wins.
        const p = parse([
            line('MORKOS PLAUTOS', 100),
            line('0, 500 kg X 2,00 EUR/ kg 99 A', 150),
            line('NUOLAIDA SU KORTELE -0, 50 A', 200),
        ]);
        expect(p).toHaveLength(1);
        // promo from the CORRECTED total: (1.00 − 0.50) / 0.5 = 1.00 €/kg (not (0.99−0.5)/0.5 = 0.98)
        expect(p[0].promoPrice).toBeCloseTo(1.00, 2);
    });

    test('a corroborating soft total is kept (receipt-268 paprika shape)', () => {
        const p = parse([
            line('RAUDONOSIOS PAPRIKOS', 100),
            line('0,245 - kg X 3, 49 EUR/ kg 86 A', 150),  // bare "86" → 0.86; 0.245×3.49 → 0.86 ✓
            line('NUOLAIDA SU KORTELE -0, 35 A', 200),
        ]);
        expect(p[0].quantity).toBeCloseTo(0.245, 3);
        expect(p[0].promoPrice).toBeCloseTo(2.08, 2);      // (0.86 − 0.35) / 0.245
    });

    test('a STRICT total is never rewritten — a 1-digit-garbled qty is repaired to match it instead', () => {
        // Printed total 1,20 + €/kg 2,00 agree with each other only under qty 0,600 — and
        // "0,600" is ONE OCR digit from the read "0,500" (receipt-326: "0,175" for "0,475").
        // Two independent strict reads outvote one: the qty is the garble; the total stands.
        const p = parse([
            line('KELIONE KILOGRAMAIS', 100),
            line('0, 500 kg X 2,00 EUR/ kg 1, 20 A', 150),
        ]);
        expect(p).toHaveLength(1);
        expect(p[0].price).toBeCloseTo(2.00, 2);
        expect(p[0].quantity).toBeCloseTo(0.6, 3);   // repaired: 0.600 × 2.00 = 1.20 exactly
    });

    test('a qty further than one digit from any consistent value stays put — flag, not silent fix', () => {
        // total 1,24 ÷ 2,00 → 0,618…0,622: every candidate is ≥2 digits from "0,500".
        // The contradiction survives to receipt-level reconciliation instead of a guess.
        const p = parse([
            line('KELIONE KILOGRAMAIS', 100),
            line('0, 500 kg X 2,00 EUR/ kg 1, 24 A', 150),
        ]);
        expect(p).toHaveLength(1);
        expect(p[0].price).toBeCloseTo(2.00, 2);
        expect(p[0].quantity).toBeCloseTo(0.5, 3);
    });
});

describe('weighed row solver — legacy behavior when the equation is not checkable', () => {
    test('€/kg unreadable → existing total ÷ qty recovery still applies (not the solver)', () => {
        const p = parse([
            line('LIETUVISKI POMIDORAI', 100),
            line('0, 720 kg X 3.ga EUR/ kg 2, 87 A', 150),
        ]);
        expect(p).toHaveLength(1);
        expect(p[0].price).toBeCloseTo(3.99, 2);           // 2.87 ÷ 0.720
        expect(p[0].quantity).toBeCloseTo(0.72, 3);
    });
});

// Real-receipt pin: the solver's recoveries on the actual 268 dump.
describe('weighed row solver — receipt 268 recoveries', () => {
    const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt268.json'), 'utf8'));
    const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
        text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
        ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
        words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
    }));
    const res: any = parseIkiReceipt(lines);

    test('all six weighed products carry consistent qty/€-per-kg after solving', () => {
        const weighed = res.products.filter((p: any) => p.unit === 'kg' && p.pricePerUnit != null);
        expect(weighed.length).toBeGreaterThanOrEqual(5);
        for (const p of weighed) {
            expect(p.price).toBeGreaterThan(0);
            expect(p.quantity).toBeGreaterThan(0);
            expect(p.quantity).toBeLessThan(10);
        }
    });
});
