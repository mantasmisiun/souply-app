import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 320 — DISCOUNT-LABEL ROT beyond every detector's reach.
// The milk's discount row OCR'd as "-0,30 A NUQLATNA SU KO E": "NUQLATNA" is 3 edits
// from "nuolaida" (the fuzzy keyword budget is 2) and has no D for the regex skeleton,
// and "KO E" carries no KORT shape for the kortelė test. The residue therefore passed
// ikiNameText, was ruled a STRONG name, and prepended itself to the NEXT product —
// "NUQLATNA SU KO E ZEMAI:JOS TEPANAS SURELI". The discount branch now drops a
// "NU… SU <crumbs>" lead when the remainder after the SU has no ≥4-letter word — a
// genuine fused next-name always has one (receipt-99 "NUOLAIDA RAUDONOSIOS PAPRIKOS").
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt320.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 320 — rotted discount label must not leak into the next name', () => {
    test('ŽEMAITIJOS keeps a clean name with no label residue', () => {
        const zem = res.products.find((p: any) => /SURELI/i.test(p.name));
        expect(zem).toBeDefined();
        expect(zem.name).not.toMatch(/NUQLATNA|SU KO/i);
        expect(zem.price).toBe(1.99);
    });

    test('the -0,30 stays the milk\'s discount', () => {
        const milk = res.products.find((p: any) => /PIENAS/i.test(p.name));
        expect(milk.price).toBe(1.49);
        expect(milk.promoPrice).toBeCloseTo(1.19, 2);
    });

    test('all eight products parse and the receipt reconciles', () => {
        expect(res.products).toHaveLength(8);
        expect(res.footer.total).toBeCloseTo(26.52, 2);
        expect(Math.abs(res.footer.reconDelta ?? 0)).toBeLessThanOrEqual(0.011);
    });
});
