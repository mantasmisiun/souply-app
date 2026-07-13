import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 129: the skipped-item band (bag "MAIŠELIS PLASTIKINIS LENG") rendered as a raw
// name-only box that (a) clipped its right-aligned price and (b) overlapped the product below
// it. On the COLUMN-ENGINE path the skip bands must be fitted into the layout: widened to the
// product span (so the price column is covered) and dropped to the next product's top (so they
// tile flush with no overlap).
const W = (text: string, xL: number, xR: number, yT: number, yB: number) => ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB });
const L = (text: string, xL: number, xR: number, yT: number, yB: number, words: any[]): IkiLine => ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB, words });

const lines: IkiLine[] = [
    L('IKI Lietuva, UAB', 60, 360, 20, 50, [W('IKI', 60, 110, 20, 50), W('Lietuva,', 120, 260, 20, 50), W('UAB', 270, 360, 20, 50)]),
    L('PVM mokėtojo kodas LT101937219', 60, 600, 100, 130, [W('PVM', 60, 130, 100, 130), W('mokėtojo', 140, 320, 100, 130), W('kodas', 330, 440, 100, 130), W('LT101937219', 450, 600, 100, 130)]),
    // skipped bag — name on the left, price on the right (a separate line). The skip band is the
    // NAME box only; its price sits in the right column.
    L('MAISELIS PLASTIKINIS LENG', 55, 580, 200, 250, [W('MAISELIS', 55, 224, 200, 250), W('PLASTIKINIS', 242, 475, 200, 250), W('LENG', 496, 578, 200, 250)]),
    L('0, 01 A', 800, 940, 210, 255, [W('0,', 800, 840, 210, 255), W('01', 850, 900, 210, 255), W('A', 910, 940, 210, 255)]),
    // the product below
    L('AGURKAI LIETUVISKI', 55, 520, 320, 360, [W('AGURKAI', 55, 250, 320, 360), W('LIETUVISKI', 260, 520, 320, 360)]),
    L('0, 99 A', 800, 940, 320, 360, [W('0,', 800, 840, 320, 360), W('99', 850, 900, 320, 360), W('A', 910, 940, 320, 360)]),
    L('Pardavimas SUMA', 60, 600, 460, 500, [W('Pardavimas', 60, 280, 460, 500), W('SUMA', 400, 600, 460, 500)]),
];

describe('IKI skipped-item band tiling (column-engine path)', () => {
    const { products, skippedRegions = [] } = parseIkiReceipt(lines);
    const bag = skippedRegions[0];
    const product = products.find((p) => /AGURKAI/i.test(p.name))!;

    test('the bag IS a skipped band, the product IS parsed', () => {
        expect(skippedRegions.length).toBe(1);
        expect(product).toBeDefined();
    });

    test('the band is widened to the product span — its price column is now covered', () => {
        // raw name box ended at x=580; after widening it reaches the right price column.
        expect(bag.xRight).toBeGreaterThanOrEqual(900);
        expect(bag.xLeft).toBeLessThanOrEqual(60);
    });

    test('the band does NOT overlap the product below — its bottom sits at the product top', () => {
        const prodTop = Math.min(product.region.yLeftTop ?? product.region.yTop, product.region.yRightTop ?? product.region.yTop);
        const bagBottom = Math.max(bag.yLeftBottom ?? bag.yBottom, bag.yRightBottom ?? bag.yBottom);
        // bottom is clamped to the product's name-top (no overlap), within a small seam tolerance.
        expect(bagBottom).toBeLessThanOrEqual(prodTop + 1);
        // and it reaches down to that seam (flush tiling — covers the right-aligned price).
        expect(bagBottom).toBeGreaterThanOrEqual(prodTop - 60);
    });
});
