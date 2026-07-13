import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 170 — a CLEAN photo, but two parser bugs:
//   1. LEAD DISCOUNT mis-homed: MLKit fused product 1's "-0,60 A" discount onto product 2's NAME line
//      ("-0,60 A KETO LENGVAI DUONA SU SĖK"). ikiBuildRows bound the discount to KETO (same MLKit line)
//      instead of the row above, so ROKIŠKIO lost its promo AND the two KETO loaves mega-merged into
//      one garbage row. Fix: a NEGATIVE amount whose same-line host is a real product NAME sitting a
//      line BELOW it is a leading discount → re-home it to the row above (nearest-Y).
//   2. ADDRESS grabbed the company line: OCR garbled "UAB" → "A8", so "iKI Lietuva, A8" wasn't stripped
//      and was taken as the store address instead of "Vilniaus g. 220-1, Šiauliai".
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt170.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);
const byName = (re: RegExp) => res.products.filter((p: any) => re.test(p.name));

describe('IKI receipt 170 — lead discount re-homing + company-line address', () => {
    test('product 1 ROKIŠKIO keeps its -0,60 discount → promo 2,39 (not lost to product 2)', () => {
        const r = byName(/ROK.SKI|NAMINE/)[0];
        expect(r.price).toBeCloseTo(2.99, 2);
        expect(r.promoPrice).toBeCloseTo(2.39, 2);
    });

    test('the two KETO loaves are TWO separate €2,59 products (not one merged row)', () => {
        const keto = byName(/KETO/);
        expect(keto).toHaveLength(2);
        keto.forEach((p: any) => expect(p.price).toBeCloseTo(2.59, 2));
        // the discount + price no longer leak into a KETO name
        expect(keto.some((p: any) => /-0|2\.59|60 A/.test(p.name))).toBe(false);
    });

    test('all five products present with correct prices (total reconciles to 10,11)', () => {
        expect(res.products).toHaveLength(5);
        const paid = res.products.reduce((s: number, p: any) => {
            const unit = p.promoPrice != null ? p.promoPrice : p.price;
            return s + (unit ?? 0) * (p.quantity && p.quantity > 0 ? p.quantity : 1);
        }, 0);
        expect(paid).toBeCloseTo(10.11, 2);
    });

    test('store address is the street line, not the "iKI Lietuva, A8" company line', () => {
        expect(res.header.storeAddress).toMatch(/Vilniaus/);
        expect(res.header.storeAddress).not.toMatch(/Lietuva/);
    });
});
