import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 317 — INTERLEAVED "label + next name" union row.
// Vision glued two printed rows into one line: "NUOLAIDA SU KORTELL" (paprikos'
// discount label) + "Fasuoti obuoliai IKI ÜKIS" (the NEXT product's name). The
// same-line union in ikiClusterRows correctly merges the sub-rows (the label can't
// stand alone), but the final x-sort INTERLEAVES their words — "Fasuoti NUÓLAIDA
// obuoliai SU KORTELL IKI ÜKIS -0,23" — so the ^NUOL-anchored label strip left
// "SU KORTELL" residue in leftText, ikiNameText rejected it, and the apples went
// nameless ("?") while carrying correct data (2,090 kg × 1,85 = 3,87). The classify
// discount branch now rebuilds the name from the row's WORDS (drop amount/label/short
// words, require a strong name at/below the label words) when the plain strip fails.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt317.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 317 — interleaved discount-label + next-name union row', () => {
    test('the apples get their name back from the interleaved label row', () => {
        const ob = res.products.find((p: any) => /obuoliai/i.test(p.name));
        expect(ob).toBeDefined();
        expect(ob.name).not.toMatch(/NUOL|KORTEL/i);   // no label residue in the name
        expect(ob.price).toBe(1.85);
        expect(ob.quantity).toBeCloseTo(2.09, 2);
        expect(ob.unit).toBe('kg');
    });

    test('paprikos keep their own name, data and the -0,23 card discount', () => {
        const pap = res.products.find((p: any) => /PAPRIKOS/i.test(p.name));
        expect(pap.price).toBe(3.49);
        expect(pap.promoPrice).toBeCloseTo(3.0, 2);    // (1,64 − 0,23) ÷ 0,470
        expect(pap.quantity).toBeCloseTo(0.47, 2);
    });

    test('all eight products named and the receipt reconciles', () => {
        expect(res.products).toHaveLength(8);
        expect(res.products.every((p: any) => p.name && p.name !== '?')).toBe(true);
        expect(res.footer.total).toBeCloseTo(26.52, 2);
        expect(res.footer.reconciled).toBe(true);
    });
});
