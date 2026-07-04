import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 292 — the top of the receipt was badly degraded: the "PVM mokėtojo kodas
// LT101937219" line OCR'd to "DUM :101937219" (label shredded to "DUM"), so the header-end
// detector missed it (no "kodas" keyword, and the bare-code fallback needs ≤2 label letters
// but "DUM" has 3). pStart stayed 0 → the IKI/address/VAT lines folded into product 1's NAME
// ("auliai DUM :101937219 METOS") and its band was drawn from the very top of the receipt.
// Fix: the 9-digit VAT code RUN bounds the header regardless of how many junk letters ride
// with the garbled label (loyalty-card line excluded so it can't be mistaken for it).
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt292.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 292 — garbled VAT-code header must not leak into product 1', () => {
    test('no product carries header junk (PVM code / Lietuva / address fragment)', () => {
        for (const p of res.products) {
            expect(p.name).not.toMatch(/101937219/);      // the VAT code
            expect(p.name).not.toMatch(/\bDUM\b/);         // the garbled "PVM…kodas" label
            expect(p.name).not.toMatch(/\d{8,}/);          // any long company/VAT code run
        }
    });

    test("product 1's band starts BELOW the header, not at the top of the receipt", () => {
        // The first product line ("METOS 0,99 A") sits at ~y=364; the header runs 70..360.
        // Before the fix the band top was ~70 (whole header swallowed).
        expect(res.products.length).toBeGreaterThanOrEqual(1);
        expect(res.products[0].region.yTop).toBeGreaterThan(300);
    });

    test('two products recovered with their prices; receipt reconciles to 2,03', () => {
        expect(res.products).toHaveLength(2);
        expect(res.products[0].price).toBeCloseTo(0.99, 2);
        expect(res.products[0].promoPrice).toBeCloseTo(0.74, 2);   // -0,25 discount
        expect(res.products[1].price).toBeCloseTo(1.29, 2);
        expect(res.footer.total).toBeCloseTo(2.03, 2);
        expect(res.footer.reconciled).toBe(true);
    });
});
