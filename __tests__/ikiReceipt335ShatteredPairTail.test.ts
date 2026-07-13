import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 335 — SHATTERED discount+total PAIR on a weighed calc row's tail.
// The right column shattered both amounts into orphan heads + bare cents, and they
// interleaved x-wise onto the kg-calc row: bananai's row read
// "0,400 kg X 1,19 EUR/ kg -0, 0, 08 48 A" (= discount -0,08 + total 0,48) and the
// weigh branch's strict negative regex saw nothing — the discount silently vanished
// (its label had fused onto the NEXT product's name line, so nothing else could
// recover it). Pomidorai shattered identically ("-0, 0, 10 35 A"). The weigh branch
// now runs the receipt-271 head+cents pairing on the tokens after the €/kg marker,
// committed only in the unambiguous shape (all heads consumed, no foreign tokens,
// ≤1 positive, ≤1 negative, VAT letter present).
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt335.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 335 — shattered pair on the calc tail keeps the discount', () => {
    test('bananai recover the -0,08: promo 1,00 €/kg', () => {
        const ban = res.products.find((p: any) => /BANANAI/i.test(p.name));
        expect(ban.price).toBeCloseTo(1.19, 2);
        expect(ban.quantity).toBeCloseTo(0.4, 3);
        expect(ban.promoPrice).toBeCloseTo(1.0, 2);       // (0,48 − 0,08) ÷ 0,400
    });

    test('pomidorai recover the identically shattered -0,10', () => {
        const pom = res.products.find((p: any) => /POMIDORAI/i.test(p.name));
        expect(pom.promoPrice).toBeCloseTo(1.79, 2);      // (0,35 − 0,10) ÷ 0,140
    });

    test('the NUOLAIDA label bands with bananai, not with tilapija (band split)', () => {
        // Label sub-row prints at y≈774-807; tilapija's own name sub-row starts ≈y800.
        const ban = res.products.find((p: any) => /BANANAI/i.test(p.name));
        const til = res.products.find((p: any) => /TILAPIJU/i.test(p.name));
        expect(ban.region.yBottom).toBeGreaterThan(790);   // bananai's band covers its label line
        expect(til.region.yTop).toBeGreaterThan(790);      // tilapija starts below the label
    });

    test('tilapija keeps its own clean 50% deal — nothing stolen across products', () => {
        const til = res.products.find((p: any) => /TILAPIJU/i.test(p.name));
        expect(til.price).toBeCloseTo(14.49, 2);
        expect(til.promoPrice).toBeCloseTo(7.24, 2);      // (7,88 − 3,94) ÷ 0,544
        expect(res.products).toHaveLength(8);
    });
});
