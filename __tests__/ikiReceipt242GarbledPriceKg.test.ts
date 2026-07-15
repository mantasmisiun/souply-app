import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 242 — two OCR-garble classes, both breaking product structure:
//
// 1. GLYPH-ROTTED PRICE DECIMAL: the flaxseed oil's total printed "3,49 A" but OCR read
//    the 9 as "y" ("3, 4y A"). Every price lane required real digits, so the oil never
//    got a total, never closed, and swallowed the price text AND the next product into
//    its name: "BILZA BI0 LINŲ SEMENŲ ALI 3, 4y A SALOZ I0SIOS BULVES". Fixed by
//    matchGarbledVatAmt: integer + separator + VAT letter + end-of-row anchor the shape;
//    only the two decimal chars may be confusion glyphs (O0 I1 Z2 S5 B8 g/q/y9).
//
// 2. INTERPUNCT + HEADLESS TOTAL on a weighed calc row: IKI prints "0,245 · kg" — OCR
//    read "0.245 - kg" (the dash blocked the qty→kg bind) and the sub-1€ total ",86 A"
//    lost its integer (".86 A"). The paprika kept its €/kg but lost the amount (qty
//    defaulted to 1) and the promo recovery. Fixed by interpunct-tolerant T_KG_LEAD_RE/
//    T_KG_QTY_RE + the headless-decimal total lane on weight rows.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt242.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);
const byName = (frag: string) => res.products.find((p: any) => p.name.includes(frag));

describe('IKI receipt 242 — glyph-rotted price decimal ("3, 4y A")', () => {
    test('the oil closes at 3.49 with its card discount — no merged double-product', () => {
        const oil = byName('LINŲ SEMENŲ');
        expect(oil).toBeTruthy();
        expect(oil.name).not.toMatch(/BULVES|4y/);
        expect(oil.price).toBeCloseTo(3.49, 2);
        expect(oil.promoPrice).toBeCloseTo(2.79, 2); // 3.49 − 0.70 card discount
    });

    test('the salad potatoes are their OWN weighed product', () => {
        const bulves = byName('BULVES');
        expect(bulves).toBeTruthy();
        expect(bulves.price).toBeCloseTo(2.49, 2);   // €/kg
        expect(bulves.quantity).toBeCloseTo(0.475, 3);
    });

    test('7 products total — the merge produced 6', () => {
        expect(res.products).toHaveLength(7);
    });
});

describe('IKI receipt 242 — interpunct kg + headless total ("0.245 - kg … .86 A")', () => {
    test('the paprika keeps its printed amount and recovers the promo €/kg', () => {
        const paprika = byName('PAPKIKOS');
        expect(paprika).toBeTruthy();
        expect(paprika.quantity).toBeCloseTo(0.245, 3);        // was lost → defaulted to 1
        expect(paprika.price).toBeCloseTo(3.49, 2);            // €/kg regular
        // total .86 − discount 0.26 = 0.60 paid for 0.245 kg → 2.45 €/kg effective
        expect(paprika.promoPrice).toBeCloseTo(2.45, 2);
    });

    test('footer total survives', () => {
        expect(res.footer.total).toBeCloseTo(7.10, 2);
    });
});
