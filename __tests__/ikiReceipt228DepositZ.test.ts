import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 228 — the SAME tightly-printed layout as receipt 169 (ACTO vinegar + 2× TICHĖ water,
// each with a bottle deposit + a RINKINYS combo discount), but here the OCR rendered the FIRST
// deposit label as "DEPOŽ1TAS" — with the Lithuanian ž (U+017D), not a plain Z, and an I→1.
// T_DEPOSIT_RE was `/DEP[O0]Z/` (plain Z only), so it missed "DEPOŽ…"; and because a mis-clustered
// "1,69 A" rode onto the deposit's line, the `!hadVat` fallback couldn't catch it either — so the
// deposit minted a phantom product "DEPOŽ1TAS €1,69". The fix widens the class to [ZŽž].
// (The second deposit "DEPOZI TAS" had a plain Z and was always caught.)
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt228.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 228 — a ž-garbled DEPOŽ1TAS deposit label is not a product', () => {
    test('no product is a deposit label (DEPOŽ1TAS / DEPOZITAS)', () => {
        const depositish = res.products.filter((p: any) =>
            /DEP[O0][ZŽž]/i.test(p.name) || /U[ŽZ]STAT/i.test(p.name));
        expect(depositish).toEqual([]);
    });

    test('the phantom "DEPOŽ1TAS €1,69" product specifically is gone', () => {
        expect(res.products.some((p: any) =>
            /DEPO/i.test(p.name) && Math.abs(p.price - 1.69) < 0.01)).toBe(false);
    });

    test('the ACTO (vinegar) line still survives at €0,65', () => {
        expect(res.products.some((p: any) => /ACTO/i.test(p.name) && Math.abs(p.price - 0.65) < 0.01))
            .toBe(true);
    });
});

// The deeper structural bug behind this receipt (image was perfectly clean — verified against
// the stored photo): MLKit padded its word boxes to ~48px on a ~38px printed pitch, so the
// box-height-derived clustering threshold chain-merged the ACTO and TICHĖ name lines into one
// interleaved row, and the deposit's bare "0,10" (glued by MLKit onto the next water's name
// line) rode down a line stealing water #2's price. Pinned here: with the measured-pitch split
// (splitH), the helper-gated source-line union, and the deposit-targeted re-home, the receipt
// parses EXACTLY as printed.
describe('IKI receipt 228 — pitch-aware clustering recovers the printed layout', () => {
    test('exactly the 3 printed products, no interleaved names', () => {
        expect(res.products).toHaveLength(3);
        // No product name mixes vinegar and water tokens (the old chain-merge signature).
        expect(res.products.some((p: any) => /ACTO/i.test(p.name) && /TICHE/i.test(p.name)))
            .toBe(false);
    });

    test('BOTH Tichė waters survive as separate products at €1,69 each', () => {
        const waters = res.products.filter((p: any) =>
            /NEGAZUOTA/i.test(p.name) && Math.abs(p.price - 1.69) < 0.01);
        expect(waters).toHaveLength(2);
    });

    test('no product carries the 0,10 deposit price', () => {
        expect(res.products.some((p: any) => Math.abs(p.price - 0.1) < 0.001)).toBe(false);
    });
});
