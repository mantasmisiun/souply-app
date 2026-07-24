import * as fs from 'fs';
import * as path from 'path';
import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 318 — TRIPLE-GLUED Vision line vs the same-line attach rule.
// One Vision line fused THREE printed rows: "LIETUVISKI POMIDORAI" (name) + its
// "0,720 kg X 3.90 EUR/kg" calc + a tall smeared "-69 A" (the destroyed total 2,87
// AND discount -0,72 overlapping). The attach rule (1) bound the right-column
// fragment "EUR/ kg -69 A" to the FIRST host sharing the source line — the NAME row,
// a full pitch away — instead of the kg-calc row right next to it. Cascade: the name
// row became a fake discount row, LYDYTAS (the 1,99 unit item above) took pomidorai's
// discount, then the receipt-96 source-line weight recovery read the glued line and
// turned LYDYTAS into a phantom weighed item (3,90 €/kg × 0,720, promo 1,81); its
// band swallowed both products and pomidorai's band collapsed to a 9px sliver.
// Rule (1) now tie-breaks same-line hosts SEMANTICALLY: an amount fragment carrying
// the "EUR/" tail prefers the nearest kg-CALC host (leading kg quantity), never a
// name row. Pure nearest-Y was tried and broke pinned 152/172 (top-most is correct
// there); the semantic gate keeps those on first-match.
const pd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures_ikiReceipt318.json'), 'utf8'));
const lines: IkiLine[] = (pd.wordsDump as any[]).map((d) => ({
    text: d.t, xLeft: d.x[0], xRight: d.x[1], yTop: d.y[0], yBottom: d.y[1],
    ...(d.c ? { yLeftTop: d.c[0], yRightTop: d.c[1], yLeftBottom: d.c[2], yRightBottom: d.c[3] } : {}),
    words: (d.w || []).map((w: any) => ({ text: w[0], xLeft: w[1], xRight: w[2], yTop: w[3], yBottom: w[4] })),
}));
const res: any = parseIkiReceipt(lines);

describe('IKI receipt 318 — triple-glued line: EUR/ fragment homes on the kg-calc row', () => {
    test('LYDYTAS stays a 1,99 unit item — no stolen weigh data, no foreign discount', () => {
        const lyd = res.products.find((p: any) => /LYDYTAS/i.test(p.name));
        expect(lyd.price).toBe(1.99);
        expect(lyd.unit).toBe('vnt');
        expect(lyd.promoPrice).toBeNull();
    });

    test('POMIDORAI keep their own weigh data', () => {
        const pom = res.products.find((p: any) => /POMIDORAI/i.test(p.name));
        expect(pom.unit).toBe('kg');
        expect(pom.quantity).toBeCloseTo(0.72, 2);
        expect(pom.price).toBeCloseTo(3.9, 2);   // "3.90" is the scan's own garble of 3,99
    });

    test('bands tile one product each: LYDYTAS tight, POMIDORAI not collapsed', () => {
        const lyd = res.products.find((p: any) => /LYDYTAS/i.test(p.name)).region;
        const pom = res.products.find((p: any) => /POMIDORAI/i.test(p.name)).region;
        expect(lyd.yBottom - lyd.yTop).toBeLessThan(60);     // was 120px spanning both
        expect(pom.yBottom - pom.yTop).toBeGreaterThan(60);  // was a 9px sliver
        // Bands are per-column quads (tileByContent): the LEFT edge carries the names, so the
        // no-swallow seam is checked on the name column — lyd's left-bottom must land at/above
        // POMIDORAI's name-top so the name is never clipped. (yBottom/yTop mix columns now.)
        expect(lyd.yLeftBottom).toBeLessThan(pom.yLeftTop + 15);   // name-column seam sits between them
    });

    test('all eight products present and named', () => {
        expect(res.products).toHaveLength(8);
        expect(res.products.every((p: any) => p.name && p.name !== '?')).toBe(true);
    });
});
