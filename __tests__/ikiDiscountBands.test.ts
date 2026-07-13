import { parseIkiColumnar, type IkiLine, type IkiWord } from '../shared/parsers/ikiParser';

// Real receipt-91 word boxes (the case the user flagged): IKI prints each product's
// discount on its own row, and MLKit fuses that discount AMOUNT with the NEXT
// product's NAME onto one line ("-0,30 A 2EMAITI…"), dropping the name's own boxes.
const W = (text: string, xL: number, xR: number, yT: number, yB: number): IkiWord =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB });
const L = (text: string, xL: number, xR: number, yT: number, yB: number, words: IkiWord[]): IkiLine =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB, words });

const LINES: IkiLine[] = [
  L('ATLANT INĖS LAŠIS0S BE GAL', 81, 548, 411, 454, [
    W('ATLANT', 81, 191, 411, 454), W('INÉS', 197, 266, 413, 454),
    W('LAŠIS0S', 288, 417, 413, 456), W('BE', 438, 473, 415, 456), W('GAL', 495, 548, 415, 457),
  ]),
  L('1,068 kg 16 99 EUR/ kg', 119, 584, 450, 495, [
    W('1,068', 119, 194, 450, 495), W('kg', 232, 272, 450, 495), W('16', 349, 387, 450, 495),
    W('99', 410, 437, 450, 495), W('EUR/', 459, 535, 450, 495), W('kg', 558, 584, 450, 495),
  ]),
  L('18, 15 A', 744, 870, 457, 499, [W('18,', 744, 783, 460, 502), W('15', 800, 832, 458, 500), W('A', 852, 870, 457, 499)]),
  L('-7, 48 A NAMINIS 2, 5. PIENAS', 81, 870, 492, 567, [W('-7,', 742, 783, 492, 534), W('48', 796, 832, 492, 533), W('A', 853, 870, 492, 533)]),
  L('NUCLAIDA SU KOE', 81, 468, 558, 602, [W('NUCLAIDA', 81, 228, 558, 602), W('SU', 257, 294, 561, 603), W('KOE', 314, 468, 561, 605)]),
  L('1, 49 A', 773, 871, 530, 573, [W('1,', 773, 797, 530, 571), W('49', 796, 833, 530, 571), W('A', 854, 871, 530, 571)]),
  L('-0,30 A 2EMAITI JOS TEPAMAS SUL:', 91, 870, 565, 635, [W('-0,30', 742, 832, 566, 611), W('A', 852, 870, 566, 608)]),
  L('1,99 A', 761, 871, 604, 646, [W('1,99', 761, 833, 604, 646), W('A', 853, 871, 604, 646)]),
  L('LYDYTAS TEPAMAS SURIS SU', 79, 528, 631, 673, [W('LYDYTAS', 79, 222, 631, 673), W('TEPAMAS', 231, 366, 631, 673), W('SURIS', 384, 478, 631, 673), W('SU', 495, 528, 631, 673)]),
];

describe('IKI two-box bands — discount stays with its own product (receipt-91)', () => {
  const products = parseIkiColumnar(LINES, 0, LINES.length);
  const find = (re: RegExp) => products.find((p) => re.test(p.name));

  test('values still correct (salmon weighed, NAMINIS discounted)', () => {
    const salmon = find(/ATLANT|LA[ŠS]I[ŠS]/i)!;
    expect(salmon.unit).toBe('kg');
    expect(salmon.price).toBeCloseTo(16.99, 2);
    const naminis = find(/NAMINIS|PIENAS/i)!;
    expect(naminis.price).toBeCloseTo(1.49, 2);
    expect(naminis.promoPrice).toBeCloseTo(1.19, 2);     // 1.49 − 0.30
  });

  test('bands are flat (no two-box step) and NAMINIS tiles with the next product — no bleed', () => {
    const naminis = find(/NAMINIS|PIENAS/i)!;
    const zem = find(/EMAITI|TEPAMAS/i)!;
    // The two-box is collapsed to a single straight band (averaged borders).
    expect(naminis.region.xMid).toBeUndefined();
    expect(zem.region.xMid).toBeUndefined();
    // Adjacent bands share the seam EXACTLY → no overlap (no discount bleed) and no gap.
    expect(naminis.region.yLeftBottom!).toBeCloseTo(zem.region.yLeftTop!, 5);
    expect(naminis.region.yRightBottom!).toBeCloseTo(zem.region.yRightTop!, 5);
  });

  test("ŽEMAITIJOS's name is still recovered from the fused discount line", () => {
    expect(find(/EMAITI|TEPAMAS/i)).toBeTruthy();              // name recovered even though MLKit dropped its boxes
  });

  // receipt-92 regression: a heavily-scrambled receipt can sort a NON-discount product
  // between a discounted one and a claimed one, which used to two-box the wrong pair and
  // produce an INVERTED band (yLeftBottom above yLeftTop). No band — quad OR two-box —
  // may ever invert.
  test('no product band is inverted (every column: bottom at/below top)', () => {
    for (const p of products) {
      const r = p.region;
      expect(r.yLeftBottom!).toBeGreaterThanOrEqual(r.yLeftTop! - 0.5);
      expect(r.yRightBottom!).toBeGreaterThanOrEqual(r.yRightTop! - 0.5);
      if (r.yMidTop != null) expect(r.yMidBottom!).toBeGreaterThanOrEqual(r.yMidTop! - 0.5);
    }
  });
});
