import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 363 — LABEL-ROW BOUNDARY under catastrophic OCR dropout.
// Vision dropped whole regions of this scan: "MORKOS", "BUROKĖLIAI CLEVER" and
// kopūstai's "1,250 kg X 1,39" calc DO NOT EXIST in the OCR output. With the calc
// destroyed, no value boundary existed at RAUDONOSIOS and the paprikos name was
// absorbed into kopūstai ("SVIEZI KOPŪSTAI 39 EUR/ ka RAUDONOSIOS PAPKIKOS") —
// the junk "39 EUR/ ka" being the label row's calc-fragment residue passing the
// name guards. Two rules pin this:
//   • a strong name right after a discount/label row opens a NEW product (a label
//     prints at the END of its product's block; a wrapped name is never split by one),
//   • a label row's residue with a €/kg marker (or no ≥4-letter word) is never a name.
// Kopūstai stays honestly priceless (nothing to recover — the ensemble's job);
// morkos keeps its only surviving fragment "PLAUS"; burokėliai's "?" is honest.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt363.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 363 — label row bounds the product even with a destroyed calc', () => {
    test('kopūstai and paprikos are separate; no calc-fragment junk in any name', () => {
        expect(res.products).toHaveLength(7);
        const kop = res.products.find((p: any) => /KOP[UŪ]STAI/i.test(p.name));
        expect(kop.name).not.toMatch(/PAPKIKOS|EUR/i);
        const pap = res.products.find((p: any) => /PAPKIKOS/i.test(p.name));
        expect(pap).toBeDefined();
    });

    test('paprikos keep their own data and discount', () => {
        const pap = res.products.find((p: any) => /PAPKIKOS/i.test(p.name));
        expect(pap.price).toBeCloseTo(3.49, 2);
        expect(pap.quantity).toBeCloseTo(0.245, 3);
        expect(pap.promoPrice).toBeCloseTo(2.49, 2);   // (0,86 − 0,25) ÷ 0,245
    });

    test('kopūstai stay honestly priceless — the calc is absent from the OCR entirely', () => {
        const kop = res.products.find((p: any) => /KOP[UŪ]STAI/i.test(p.name));
        expect(kop.price).toBe(0);
        expect(Math.abs(res.footer.reconDelta ?? 0)).toBeGreaterThan(1); // flags for the ensemble
    });

    test('the dropped-text victims parse from what exists: PLAUS fragment + honest "?"', () => {
        const mork = res.products.find((p: any) => /PLAUS/.test(p.name));
        expect(mork.price).toBeCloseTo(0.89, 2);
        expect(mork.quantity).toBeCloseTo(0.375, 3);
        const bur = res.products.find((p: any) => p.name === '?');
        expect(bur.price).toBeCloseTo(0.55, 2);
        expect(bur.quantity).toBeCloseTo(0.41, 3);
    });
});
