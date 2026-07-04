import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 324 — ORPHANED UNIT-CALC FRAGMENT mints a phantom product.
// Vision glued the cucumber name + its multi-buy calc into one line
// ("Žaliosios cukinijos 2 vnt. X 1,49 EUR/ V"), and the tilted geometry split it so
// the calc's "EUR/ V" tail tilt-normalized UP into the name row while "2 vnt. X 1,49"
// stayed its own fragment. The same-line union should have re-merged the pair, but
// helperish couldn't recognize the fragment: T_UNIT_CALC_RE needs the "EUR" tail that
// was carved off. Result: a phantom product "2 vnt. X" priced 1,49, the cucumbers took
// the bare 2,98 with no quantity, and the -1,80 discount was dropped (Δrecon -1.47).
// helperish now treats a row LEADING with "<count> vnt." as a calc fragment that can
// never stand alone — the leading anchor works even on the norm-order scramble
// ("2 vnt. 1,49 X"). An x-sort of helperish's text was tried and REVERTED: union
// decisions on pinned 308/309/318 are tuned against norm-order text and flipped.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt324.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 324 — orphaned "2 vnt. X 1,49" unions back into the cucumber', () => {
    test('cucumbers: one product, 2 vnt × 1,49 with the -1,80 discount applied', () => {
        const cuk = res.products.find((p: any) => /cukinijos/i.test(p.name));
        expect(cuk).toBeDefined();
        expect(cuk.name).not.toMatch(/EUR|vnt\.|X\b/);   // calc tokens cleaned from the name
        expect(cuk.price).toBeCloseTo(1.49, 2);
        expect(cuk.quantity).toBe(2);
        expect(cuk.promoPrice).toBeCloseTo(0.59, 2);     // (2,98 − 1,80) ÷ 2
    });

    test('no phantom "<count> vnt." product is minted', () => {
        expect(res.products.some((p: any) => /^\d+\s*vnt/i.test(p.name))).toBe(false);
        expect(res.products).toHaveLength(9);
    });

    test('the receipt reconciles', () => {
        expect(res.footer.total).toBeCloseTo(18.47, 2);
        expect(Math.abs(res.footer.reconDelta ?? 0)).toBeLessThanOrEqual(0.03);
    });
});
