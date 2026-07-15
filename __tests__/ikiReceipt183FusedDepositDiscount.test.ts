import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 183 — the AKVILĖ GAZ. card discount (-0,33) was lost. The OCR put the discount
// AMOUNT on the row whose LEFT column is the deposit label, x-sorted to "DEPOZITAS -0,33 A".
// The "fused discount + deposit-label" recovery keyed off the text STARTING with a negative
// ("-0,33 A …", receipt-139), which this boxed-label variant doesn't. Variant (b) detection
// now treats a deposit-label row carrying a NEGATIVE as the product-above's discount AND folds
// the deposit's own bare price (0,10) on the next row — so the discount is applied (0,65→0,32)
// AND the "?" deposit phantom disappears. Total reconciles: 0,32 + 0,10 = 0,42.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt183.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 183 — fused discount + boxed deposit label', () => {
    test('AKVILĖ GAZ. keeps its base price 0,65 and gets the -0,33 card discount (promo 0,32)', () => {
        const a = res.products.find((p: any) => /AKVIL/i.test(p.name));
        expect(a).toBeTruthy();
        expect(a.price).toBeCloseTo(0.65, 2);
        expect(a.promoPrice).toBeCloseTo(0.32, 2);
    });

    test('the deposit (0,10) folds — no nameless "?" phantom product', () => {
        const phantom = res.products.find((p: any) => p.name === '?' || !/[a-ząčęėįšųūž]/i.test(p.name ?? ''));
        expect(phantom).toBeUndefined();
    });
});
