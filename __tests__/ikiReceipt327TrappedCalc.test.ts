import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 327 — kg-CALC TRAPPED inside a discount-label row.
// Vision glued kopūstai's calc with its own NUOLAIDA label into one line; the union
// interleaved them ("NUOLAIDA 1,250 kg e X KORTFLE 1,39 EUR/ kg") and the composite
// classified as a DISCOUNT row — the calc VALUES vanished from the assembly stream.
// The next strong name (paprikos) then found cur.perKg null, NO boundary fired, and
// the paprikos name was absorbed into kopūstai ("SVIEZI KOPUSTAI RAUDONOS IOS
// PAPKIKOS") while paprikos itself vanished as a product. The discount branch now
// CARRIES a trapped calc (leading 3-decimal kg qty + readable €/kg in the row) so
// the boundary sees perKg in-stream. Companion rule: a MINUS-LESS loose amount on a
// trapped-calc row ("B6 A" = the garbled total "0,86 A", 8→B) is never booked as a
// discount — the row solver recovers the exact total from kg × €/kg instead.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt327.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 327 — trapped calc keeps the product boundary alive', () => {
    test('kopūstai and paprikos are separate products with clean names', () => {
        expect(res.products).toHaveLength(7);
        const kop = res.products.find((p: any) => /KOPUSTAI/i.test(p.name));
        expect(kop.name).not.toMatch(/PAPKIKOS|PAPRIK/i);
        const pap = res.products.find((p: any) => /PAPKIKOS/i.test(p.name));
        expect(pap).toBeDefined();
    });

    test('both weighed items carry their own trapped-calc data and exact discounts', () => {
        const kop = res.products.find((p: any) => /KOPUSTAI/i.test(p.name));
        expect(kop.price).toBeCloseTo(1.39, 2);
        expect(kop.quantity).toBeCloseTo(1.25, 3);
        expect(kop.promoPrice).toBeCloseTo(0.99, 2);      // savings pin 0,50 — the true split
        const pap = res.products.find((p: any) => /PAPKIKOS/i.test(p.name));
        expect(pap.price).toBeCloseTo(3.49, 2);
        expect(pap.quantity).toBeCloseTo(0.245, 3);
        expect(pap.promoPrice).toBeCloseTo(2.45, 2);      // its own -0,26; the "B6 A" crumb is NOT a discount
    });

    test('the receipt reconciles exactly on the recovered 7,10 total', () => {
        expect(res.footer.total).toBeCloseTo(7.1, 2);
        expect(res.footer.reconciled).toBe(true);
        expect(Math.abs(res.footer.reconDelta ?? 1)).toBeLessThanOrEqual(0.011);
    });
});
