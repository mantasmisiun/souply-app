import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 275 — the price column does NOT continue the left column's baseline. The photo is
// curled/perspective-warped: left-column baselines measure ~+0.05 slope while the printed
// name→price pairs are near-level, so the global-linear de-skew displaced every price norm
// ~27px (0.6·lineH) — "9,99 A" went STANDALONE, the assembly shifted one row, and Lavazza
// took grietinė's 2,79 + its crop band while a "?" phantom held the real 9,99 (the exact
// user-facing swap: crop shows Grietinė, name says Lavazza, match goes to another coffee).
// Reconciliation can NOT catch this class — swapped prices still sum correctly.
// Pinned mechanisms:
//   • CROSS-COLUMN OFFSET (colCorr): same-printed-row glued lines ("NUOLAIDA SU KORTELE
//     -4,50 A") measure the model error directly; amt norms shift by the median residual
//     (deadband 0.25·lineH, cap 0.9·lineH, ≥2 samples, tight-side + shape gates so the
//     receipt-161 two-row mega-glue and the receipt-170 leading-discount fusion can't poison);
//   • MONGREL SPLIT: a name tail past xMid ("ORO MALTA") that clustered with a NEIGHBOUR
//     row's negative goes home to its own name row, the negative to its label row;
//   • cleanProductName drops a stranded consumed discount token from a name.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt275.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 275 — warped price column must not swap products', () => {
    test('Lavazza keeps its own price 9,99 → 5,49 and its FULL name', () => {
        const lav = res.products.find((p: any) => /LAVAZZA/i.test(p.name));
        expect(lav).toBeDefined();
        expect(lav.name).toMatch(/ORO MALTA/i);          // the tail returned home, not into an amt cluster
        expect(lav.price).toBeCloseTo(9.99, 2);
        expect(lav.promoPrice).toBeCloseTo(5.49, 2);
    });

    test('Dvaro grietinė keeps 2,79 → 1,95 and no discount token in the name', () => {
        const gr = res.products.find((p: any) => /GRIETIN/i.test(p.name));
        expect(gr).toBeDefined();
        expect(gr.price).toBeCloseTo(2.79, 2);
        expect(gr.promoPrice).toBeCloseTo(1.95, 2);
        expect(gr.name).not.toMatch(/-\s?\d/);           // the consumed “-0,84” must not ride the name
    });

    test('no "?" phantom product — every line has a real name', () => {
        for (const p of res.products) expect(p.name).not.toBe('?');
    });

    test('bands follow print order: Lavazza ABOVE grietinė (the crop/name swap is dead)', () => {
        const lav = res.products.find((p: any) => /LAVAZZA/i.test(p.name));
        const gr = res.products.find((p: any) => /GRIETIN/i.test(p.name));
        expect(lav.region.yTop).toBeLessThan(gr.region.yTop);
        expect(lav.region.yBottom).toBeLessThan(gr.region.yBottom);
    });

    test('the rest of the receipt holds: both Magijas, weighed slyvos, unit-calc cukinijos', () => {
        const magijas = res.products.filter((p: any) => /MAGI\s?JA/i.test(p.name));
        expect(magijas).toHaveLength(2);
        for (const m of magijas) {
            expect(m.price).toBeCloseTo(0.65, 2);
            expect(m.promoPrice).toBeCloseTo(0.39, 2);
        }
        const slyvos = res.products.find((p: any) => /SLYV/i.test(p.name));
        expect(slyvos.unit).toBe('kg');
        expect(slyvos.quantity).toBeCloseTo(0.355, 3);
        expect(slyvos.price).toBeCloseTo(8.99, 2);
        expect(slyvos.promoPrice).toBeCloseTo(6.73, 2);
        const cuk = res.products.find((p: any) => /cukini/i.test(p.name));
        expect(cuk.quantity).toBe(2);
        expect(cuk.price).toBeCloseTo(1.49, 2);
        expect(cuk.promoPrice).toBeCloseTo(0.59, 2);
    });

    test('fully reconciled: Σ paid = printed 18,47, savings 8,96', () => {
        expect(res.footer.total).toBeCloseTo(18.47, 2);
        expect(res.footer.totalSavings).toBeCloseTo(8.96, 2);
        expect(res.footer.reconciled).toBe(true);
        expect(Math.abs(res.footer.reconDelta)).toBeLessThanOrEqual(0.011);
    });
});
