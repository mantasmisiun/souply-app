import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 271 — dense pitch + curvature made MLKit glue EVERY discount amount to the
// next product's name, and both of a product's amounts (total + discount) attached to
// its NAME row as x-interleaved token soup. Three fixes pinned here:
//   A. mergedTotal donation requires a REAL discount on the row (dv > 0): a bare
//      "NUOLAIDA…" label glued with a positive can no longer donate the NEXT product's
//      price to the open one (Lavazza stole grietinė's 2,79).
//   B. attach preference: a positive VAT-lettered amount prefers a NAME/calc host over
//      a bare discount-label row within the radius (labels only own negatives).
//   C. soup-row reconstruction: exactly one positive + one negative on a name row —
//      tokens possibly scrambled ("MALTA -4, 9,99 50 A A", even two-head interleaves
//      "-0, 2, 84 79 A A") — become total + selfDisc, FIFO-paired by x-order.
// Plus: T_TRAIL tolerates a stray doubled VAT letter ("2,59 A A"), guarded so the
// receipt-154 merged-discount row still reaches the discount branch.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt271.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);
const byName = (frag: string) => res.products.filter((p: any) => p.name.includes(frag));

describe('IKI receipt 271 — soup rows and the label price-theft', () => {
    test('Lavazza keeps its own 9,99 → 5,49 (scrambled soup "−4, 9,99 50 A A" reconstructed)', () => {
        const [lavazza] = byName('LAVAZ');
        expect(lavazza).toBeTruthy();
        expect(lavazza.price).toBeCloseTo(9.99, 2);
        expect(lavazza.promoPrice).toBeCloseTo(5.49, 2);
        expect(lavazza.name).not.toMatch(/9,99|4, 50|GRIETIN/);
    });

    test('grietinė gets its 2,79 → 1,95 back (two-head interleave "−0, 2, 84 79")', () => {
        const [grietine] = byName('GRIETIN');
        expect(grietine).toBeTruthy();
        expect(grietine.price).toBeCloseTo(2.79, 2);
        expect(grietine.promoPrice).toBeCloseTo(1.95, 2);
        expect(grietine.name).not.toMatch(/MAG[TI]JA/);
    });

    test('BOTH Magija sūreliai parse at 0,65 → 0,39', () => {
        const magijos = byName('MAG');
        expect(magijos).toHaveLength(2);
        for (const m of magijos) {
            expect(m.price).toBeCloseTo(0.65, 2);
            expect(m.promoPrice).toBeCloseTo(0.39, 2);
        }
    });

    test('the two KETO loaves stay separate at 2,59 each (doubled-VAT tail tolerated)', () => {
        const keto = byName('KETO');
        expect(keto).toHaveLength(2);
        for (const k of keto) expect(k.price).toBeCloseTo(2.59, 2);
    });

    test('bands follow print order for the first four products', () => {
        const [lavazza] = byName('LAVAZ');
        const [grietine] = byName('GRIETIN');
        const magijos = byName('MAG').sort((a: any, b: any) => a.region.yTop - b.region.yTop);
        expect(lavazza.region.yTop).toBeLessThan(grietine.region.yTop);
        expect(grietine.region.yTop).toBeLessThan(magijos[0].region.yTop);
        expect(magijos[0].region.yTop).toBeLessThan(magijos[1].region.yTop);
    });

    test('weighed slyvos untouched by the new lanes', () => {
        const [slyvos] = byName('SLYVOS');
        expect(slyvos.price).toBeCloseTo(8.99, 2);
        expect(slyvos.promoPrice).toBeCloseTo(6.73, 2);
        expect(slyvos.quantity).toBeCloseTo(0.355, 3);
    });
});
