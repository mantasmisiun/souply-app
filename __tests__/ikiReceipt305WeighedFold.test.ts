import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 305 — two defects:
//   • BANANAS SCATTER: IKI printed the weighed item's TOTAL on its NAME line ("BANANAI BON
//     VIA 0,48 A") with the kg-calc on the NEXT line — the name row closed as a unit item
//     and the orphaned calc minted a nameless weighed "?" (name/calc/discount across three
//     bands). The WEIGHED-PHANTOM FOLD merges them via the receipt's own arithmetic
//     (0,400 × 1,19 = 0,48 to the cent) and recovers the word-boxed -0,08 discount.
//   • FABRICATED TOTAL: the sheared payment table put "A 21,00 %" on the Grynieji line —
//     the cash last-resort lane grabbed the VAT RATE as cash (21,00−7,10=13,90 for a 12,90
//     receipt). The %-guard now skips rate tokens (true cash 20,00 − 7,10 = 12,90).
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt305.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 305 — weighed name+total / calc split (bananas)', () => {
    test('bananas are ONE weighed product with calc + discount folded in', () => {
        const b = res.products.find((p: any) => /BANANAI/i.test(p.name));
        expect(b).toBeDefined();
        expect(b.unit).toBe('kg');
        expect(b.quantity).toBeCloseTo(0.4, 3);
        expect(b.price).toBeCloseTo(1.19, 2);      // €/kg
        expect(b.promoPrice).toBeCloseTo(1.0, 2);  // (0,48 − 0,08) ÷ 0,400
    });

    test('no nameless phantom; band spans name + calc rows', () => {
        expect(res.products.some((p: any) => p.name === '?' || p.name === '')).toBe(false);
        const b = res.products.find((p: any) => /BANANAI/i.test(p.name));
        expect(b.region.yBottom - b.region.yTop).toBeGreaterThan(50); // covers both printed rows
    });

    test('total is the real 12,90 — not the VAT-rate-fabricated 13,90', () => {
        expect(res.footer.total).toBeCloseTo(12.9, 2);
    });
});
