import { parseIkiColumnar, type IkiLine, type IkiWord } from '../shared/parsers/ikiParser';

// Real receipt-93 word boxes for the interleaved region: NAMINIS (discounted) → 2EMAITIJOS
// (no discount) → LYDYTAS (name DROPPED by MLKit + fused onto NAMINIS's discount row). The
// stored output had 2EMAITIJOS as an INVERTED near-empty sliver and LYDYTAS spanning two
// products. The degenerate-band fallback must turn every band into a clean, non-inverted one.
const W = (text: string, xL: number, xR: number, yT: number, yB: number): IkiWord =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB });
const L = (text: string, xL: number, xR: number, yT: number, yB: number, words: IkiWord[]): IkiLine =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB, words });

const LINES: IkiLine[] = [
  L('NAMINIS 2,5%. PIENAS', 91, 447, 438, 508, [W('NAMINIS', 91, 224, 438, 489), W('2,5%.', 252, 318, 452, 497), W('PIENAS', 329, 447, 457, 508)]),
  L('1,49 A', 762, 870, 491, 532, [W('1,49', 762, 834, 491, 532), W('A', 852, 870, 495, 532)]),
  L('-0,30 A LYDYTAS TEPAMAS SURIS SU', 98, 870, 528, 614, [W('-0,30', 746, 833, 528, 567), W('A', 852, 870, 532, 567)]),
  L('2EMAITIJOS TEPAMAS SUPLI', 91, 552, 508, 588, [W('2EMAITIJOS', 91, 279, 508, 564), W('TEPAMAS', 296, 430, 525, 578), W('SUPLI', 445, 552, 538, 588)]),
  L('1,99 A', 763, 869, 565, 609, [W('1,99', 763, 833, 565, 602), W('A', 852, 869, 567, 602)]),
  L('1,99 A', 762, 870, 598, 642, [W('1,99', 762, 833, 598, 635), W('A', 852, 870, 600, 635)]),
  L('LIETUVISKI POMIDORAI', 90, 465, 581, 648, [W('LIETUVISKI', 90, 276, 581, 636), W('POMIDORAI', 295, 465, 596, 650)]),
  L('2, 87 A', 760, 871, 670, 715, [W('2,', 760, 787, 671, 708), W('87', 797, 833, 672, 710), W('A', 851, 871, 674, 711)]),
];

describe('IKI receipt-93 interleave — degenerate-band fallback', () => {
  const products = parseIkiColumnar(LINES, 0, LINES.length);

  test('reproduces the products', () => {
     
    console.log('PRODUCTS:', products.map((p) => ({
      name: p.name,
      yT: Math.round(p.region.yTop), yB: Math.round(p.region.yBottom),
      hL: Math.round((p.region.yLeftBottom ?? p.region.yBottom) - (p.region.yLeftTop ?? p.region.yTop)),
      hR: Math.round((p.region.yRightBottom ?? p.region.yBottom) - (p.region.yRightTop ?? p.region.yTop)),
    })));
    expect(products.length).toBeGreaterThan(0);
  });

  test('NO band is inverted or a sliver (every column ≥ 3px, bottom ≥ top)', () => {
    for (const p of products) {
      const r = p.region;
      const hL = (r.yLeftBottom ?? r.yBottom) - (r.yLeftTop ?? r.yTop);
      const hR = (r.yRightBottom ?? r.yBottom) - (r.yRightTop ?? r.yTop);
      expect(hL).toBeGreaterThanOrEqual(3);
      expect(hR).toBeGreaterThanOrEqual(3);
    }
  });
});
