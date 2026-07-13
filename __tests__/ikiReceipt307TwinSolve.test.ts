import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 307 — the compound showcase:
//   • TWIN PURCHASE: two identical "KETO LENGVAI DUONA SU SĖK" loaves; the FIRST one's
//     total OCR-destroyed ("… CO"). The old name-continuation merged the twins into one
//     double-named product and silently absorbed the 2,59. Now: identical consecutive
//     strong names are a boundary (a wrap never repeats the whole name); the totalless
//     twin flushes as an UNKNOWN and Phase-2 reconciliation SOLVES its total from the
//     printed sum (10,11 − 7,52 known = exactly 2,59).
//   • LABEL-GLUED NAME THEFT: agurkai's name rode the avocado's discount line
//     ("NUOLAIDA SU KORTELE -0,40 A TRUMPAVAISIAI AGURKAI"); the ^-anchored lead
//     patterns missed it and agurkai stayed "?". The label-anchored pattern recovers it.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt307.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 307 — twin split + recon solve + label-glued name recovery', () => {
    test('five separate products — the twin loaves are NOT merged', () => {
        expect(res.products).toHaveLength(5);
        const ketos = res.products.filter((p: any) => /KETO LENGVAI/i.test(p.name));
        expect(ketos).toHaveLength(2);
        for (const k of ketos) {
            expect(k.price).toBeCloseTo(2.59, 2);   // the destroyed one SOLVED by reconciliation
            expect(k.name).not.toMatch(/KETO.*KETO/i); // never double-named
        }
    });

    test('agurkai recovers its name from the label-glued discount line', () => {
        const a = res.products.find((p: any) => /AGURKAI/i.test(p.name));
        expect(a).toBeDefined();
        expect(a.unit).toBe('kg');
        expect(a.quantity).toBeCloseTo(0.485, 3);
        expect(a.price).toBeCloseTo(2.99, 2);
        expect(a.promoPrice).toBeCloseTo(1.96, 2);  // (1,45 − 0,50) ÷ 0,485
        expect(res.products.some((p: any) => p.name === '?')).toBe(false);
    });

    test('fully reconciled to the printed 10,11 (the solve corroborated)', () => {
        expect(res.footer.total).toBeCloseTo(10.11, 2);
        expect(res.footer.reconciled).toBe(true);
        expect(Math.abs(res.footer.reconDelta)).toBeLessThanOrEqual(0.011);
    });
});
