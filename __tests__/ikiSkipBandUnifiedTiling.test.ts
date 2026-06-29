import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Skipped-item bands (coupons / bags / loyalty points) must tile by the EXACT same rule as
// product bands: no overlap, no gap, tilt-following, ordered by reading position. Previously the
// skip bands were fitted in a separate, cruder pass (only "drop to the next product below"), so
// a product ABOVE a skip overlapped it and stacked skips overlapped each other. Now products and
// skips run through one shared per-corner seam enforcement (ordered by each item's true
// content-top), while skips keep their grey 'skipped' identity and stay out of `products`.
const W = (text: string, xL: number, xR: number, yT: number, yB: number) => ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB });
const L = (text: string, xL: number, xR: number, yT: number, yB: number, words: any[]): IkiLine => ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB, words });

const top = (r: any) => Math.min(r.yLeftTop ?? r.yTop, r.yRightTop ?? r.yTop);
const bot = (r: any) => Math.max(r.yLeftBottom ?? r.yBottom, r.yRightBottom ?? r.yBottom);

describe('IKI skip-band unified tiling (column-engine path)', () => {
    // AKVILE (product) → KUPONAS (skip) → MAISELIS (skip) → AGURKAI (product): two skips sandwiched
    // BETWEEN two products — the case the old per-skip fitter handled worst.
    const lines: IkiLine[] = [
        L('PVM mokėtojo kodas LT101937219', 60, 600, 40, 80, [W('PVM', 60, 130, 40, 80), W('mokėtojo', 140, 320, 40, 80), W('kodas', 330, 440, 40, 80), W('LT101937219', 450, 600, 40, 80)]),
        L('AKVILE GAZ..', 71, 321, 120, 170, [W('AKVILE', 71, 204, 120, 170), W('GAZ..', 226, 321, 120, 170)]),
        L('0, 65 A', 800, 940, 120, 170, [W('0,', 800, 840, 120, 170), W('65', 850, 900, 120, 170), W('A', 910, 940, 120, 170)]),
        L('KUPONAS NUOLAIDA', 60, 400, 230, 280, [W('KUPONAS', 60, 250, 230, 280), W('NUOLAIDA', 260, 400, 230, 280)]),
        L('MAISELIS PLASTIKINIS', 55, 580, 320, 370, [W('MAISELIS', 55, 224, 320, 370), W('PLASTIKINIS', 242, 475, 320, 370)]),
        L('AGURKAI LIETUVISKI', 55, 520, 420, 470, [W('AGURKAI', 55, 250, 420, 470), W('LIETUVISKI', 260, 520, 420, 470)]),
        L('0, 99 A', 800, 940, 420, 470, [W('0,', 800, 840, 420, 470), W('99', 850, 900, 420, 470), W('A', 910, 940, 420, 470)]),
        L('Prekiautojo ID 150', 60, 500, 520, 560, [W('Prekiautojo', 60, 300, 520, 560), W('ID', 320, 360, 520, 560), W('150', 380, 500, 520, 560)]),
    ];
    const res: any = parseIkiReceipt(lines);
    const products = res.products;
    const skips = (res.skippedRegions ?? []).slice().sort((a: any, b: any) => top(a) - top(b));

    test('2 products parsed, 2 skipped bands (coupon + bag), skips excluded from products', () => {
        expect(products.map((p: any) => p.name).sort()).toEqual(['AGURKAI LIETUVISKI', 'AKVILE GAZ..']);
        expect(skips.length).toBe(2);
    });

    test('every band (product + skip) tiles seam-to-seam: no overlaps, no gaps', () => {
        const all = [...products.map((p: any) => p.region), ...skips].sort((a, b) => top(a) - top(b));
        for (let i = 1; i < all.length; i++) {
            const seam = bot(all[i - 1]) - top(all[i]);
            expect(Math.abs(seam)).toBeLessThanOrEqual(2);   // flush (no overlap, no gap)
        }
    });

    test('the lower product (AGURKAI) band still covers its OWN name (not collapsed to a sliver)', () => {
        const agurkai = products.find((p: any) => /AGURKAI/.test(p.name));
        expect(top(agurkai.region)).toBeLessThanOrEqual(425);   // name top ≈ 420
        expect(bot(agurkai.region)).toBeGreaterThanOrEqual(465); // name bottom ≈ 470
    });

    test('skip bands are widened to the product span (price column covered, not clipped)', () => {
        for (const s of skips) {
            expect(s.xRight).toBeGreaterThanOrEqual(900);
            expect(s.xLeft).toBeLessThanOrEqual(75);
        }
    });
});
