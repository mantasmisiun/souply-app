import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 315 — GLUED kg QUANTITY on a ×-less calc row.
// Vision emitted the agurkai calc row as "0,245kg 2,99 EUR/ kg" — no "X" separator
// (so T_WEIGHT_LOOSE_RE misses it) AND the unit glued straight onto the digits.
// The weighed-recovery gate's hasLeadingKgQty used a `\b` after the 3 decimals, but
// `\b` never fires between a digit and a letter ("…245kg"), so the calc row fell
// through classify, fused into the NAME, and the item lost its price entirely
// (price=0, qty=1kg) despite qty, €/kg AND total all being readable on the receipt.
// The gate now accepts a glued unit ("245kg"/"245ka"/…) as an explicit alternative.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt315.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 315 — glued "0,245kg" weighed row keeps its price', () => {
    test('agurkai parse as a weighed item with €/kg and quantity, calc row NOT fused into the name', () => {
        const ag = res.products.find((p: any) => /AGURK/i.test(p.name));
        expect(ag).toBeDefined();
        expect(ag.name).not.toMatch(/\d/);      // no "0,245kg 2,99" swallowed into the name
        expect(ag.price).toBe(2.99);            // €/kg read from the calc row
        expect(ag.quantity).toBeCloseTo(0.245, 3);
        expect(ag.unit).toBe('kg');
    });

    test('all seven products parse and the receipt sums to the product total', () => {
        expect(res.products).toHaveLength(7);
        expect(res.products.every((p: any) => (p.promoPrice ?? p.price) > 0)).toBe(true);
        expect(res.footer.total).toBeCloseTo(7.6, 2); // 0,73+2,79+1,18+0,33+0,23+1,74+0,60
    });

    test('spaced weighed rows still parse (no regression from the glued-unit alternative)', () => {
        const bulves = res.products.find((p: any) => /BULVES/i.test(p.name));
        expect(bulves.price).toBe(2.49);
        expect(bulves.quantity).toBeCloseTo(0.475, 3);
    });
});
