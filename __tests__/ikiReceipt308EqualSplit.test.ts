import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 308 (re-scan of 307's basket, degraded differently): BOTH twin loaves' totals
// collapsed to bare cents ("KETO LENGVAI DUONA SU SĖK 59" for "… 2,59 A"). Pinned lanes:
//   • HEADLESS BARE-CENTS classify: a strong name ending in a stray 2-digit token is an
//     UNKNOWN total whose cents are known — never a name suffix, never a merge;
//   • EQUAL-SPLIT reconciliation: N same-name unknowns solve as delta÷N when every
//     unknown's cents corroborate (2× 2,59 = the 5,17 gap within a rounding cent).
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt308.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 308 — bare-cents twins solved by equal-split reconciliation', () => {
    test('five products; the loaves never merge with each other or the avocado', () => {
        expect(res.products).toHaveLength(5);
        const ketos = res.products.filter((p: any) => /KETO LENGVAI/i.test(p.name));
        expect(ketos).toHaveLength(2);
        for (const k of ketos) {
            expect(k.price).toBeCloseTo(2.59, 2);          // reconstructed from "59" + printed total
            expect(k.name).not.toMatch(/AVOKAD|KETO.*KETO/i);
        }
        const a = res.products.find((p: any) => /AVOKADAI/i.test(p.name));
        expect(a.price).toBeCloseTo(1.99, 2);
        expect(a.promoPrice).toBeCloseTo(1.59, 2);
    });

    test('reconciled: equal-split + savings-pinned discount both corroborated', () => {
        expect(res.footer.reconciled).toBe(true);
        expect(Math.abs(res.footer.reconDelta)).toBeLessThanOrEqual(0.011);
        const g = res.products.find((p: any) => /GRIETINE/i.test(p.name));
        expect(g.promoPrice).toBeCloseTo(2.39, 2);          // headless "60" discount pinned via sutaupėte
    });
});
