import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 166 — a rough thermal scan with the TOP cut off and OCR garble, exercising three distinct
// product-region boundary bugs (all reported from device testing):
//   1. HEADER BLEED: the "PVM mokėtojo kodas LT101937219" line OCR-shredded to just "1019372 19"
//      (no PVM/kodas/LT), so the header boundary wasn't found and "uliai"/"1019372 19" folded into
//      product 1's name + band. Fix: a 7+ digit near-numeric header line is the company code → boundary.
//   2. DISCOUNT-AS-PHANTOM: "NUOLAIDA" OCR'd to "NUOLAlUn" (the trailing "DA" shredded), so isTDiscount
//      missed it and the label became a phantom product. Fix: the NUOLAI skeleton matches without the
//      "DA" tail → it folds into METOS as its -0,25 discount (promo 0,74).
//   3. TRAILER BLEED: the payment block ("Prekiauto:", transaction time, card AID, "Par davimas")
//      became a phantom product because pEnd only stopped at "SUMA". Fix: a "Prekiautojo …" label
//      ending in ":" (and space-tolerant "Par davimas") ends the product list before the trailer.
// Driven by the real MLKit wordsDump so the boundaries + clustering are faithful.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt166.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 166 — header/trailer bleed + garbled NUOLAIDA discount', () => {
    test('exactly two real products (no NUOLAIDA / trailer phantoms)', () => {
        expect(res.products).toHaveLength(2);
        expect(res.products.some((p: any) => /NUOL|Prekiaut|davimas|Data|EC\/MC/i.test(p.name))).toBe(false);
    });

    test('product 1 is METOS €0,99 with the -0,25 discount (promo 0,74), header text not in the name', () => {
        const m = res.products[0];
        expect(m.name).toMatch(/METOS/);
        expect(m.name).not.toMatch(/uliai|1019372|Un/);   // header fragment + the NUOLAlUn tail are gone
        expect(m.price).toBeCloseTo(0.99, 2);
        expect(m.promoPrice).toBeCloseTo(0.74, 2);
    });

    test('product 2 is IKI LEDO €1,29', () => {
        const led = res.products[1];
        expect(led.name).toMatch(/IKI LED/);
        expect(led.price).toBeCloseTo(1.29, 2);
    });

    test('footer total is 2,03', () => {
        expect(res.footer.total).toBeCloseTo(2.03, 2);
    });
});
