import { parseIkiColumnar, type IkiLine, type IkiWord } from '../shared/parsers/ikiParser';

// Receipt-109 (IKI Šiauliai): the Atlantic-salmon line loses its −7,48 card discount.
// DISTINCT from receipt-99: here the salmon's discount AMOUNT (−7,48) fused — text-only,
// no word box — onto the NEXT product's (NAMINIS milk) NAME line, AND that name row ALSO
// carries NAMINIS's OWN positive total 1,49 (its right-column box clustered onto the name
// by Y). The clean positive total made ikiClassifyRow take the "a clean positive decimal
// is always a TOTAL" early return, which — before the fix — bypassed the trailing-discount
// recovery, so the −7,48 was dropped from BOTH products. The fix computes the trailing
// text-only discount BEFORE the early return and attaches it to the open PREVIOUS product
// (the salmon), guarded by the non-negative-net plausibility rule: NAMINIS's 1,49 − 7,48
// would go negative so it can't own the discount; the salmon's 18,15 − 7,48 = 10,67 can.
const W = (text: string, xL: number, xR: number, yT: number, yB: number): IkiWord =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB });
const L = (text: string, xL: number, xR: number, yT: number, yB: number, words: IkiWord[]): IkiLine =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB, words });

const LINES: IkiLine[] = [
  L('AT! ANTINĖS LASIŠ0S BE GAL', 81, 573, 380, 430, [
    W('AT!', 81, 115, 380, 425), W('ANTINĖS', 137, 284, 382, 428), W('LASIŠ0S', 289, 433, 384, 430),
    W('BE', 452, 494, 385, 428), W('GAL', 513, 572, 386, 429),
  ]),
  L('1,068 kg X 16,99 EUR/ kg', 66, 614, 445, 495, [
    W('1,068', 66, 205, 445, 490), W('kg', 239, 282, 448, 492), W('X', 308, 329, 450, 493),
    W('16,99', 356, 453, 452, 495), W('EUR/', 472, 553, 454, 495), W('kg', 574, 614, 455, 495),
  ]),
  L('18, 15 A', 786, 916, 510, 555, [W('18,', 786, 840, 510, 552), W('15', 842, 877, 510, 552), W('A', 898, 916, 510, 552)]),
  L('NUOLAJDA SU KORTELE', 63, 449, 565, 605, [W('NUOLAJDA', 63, 235, 565, 600), W('SU', 241, 290, 568, 602), W('KORTELE', 312, 448, 570, 605)]),
  // The fused row: source TEXT carries "-7, 48 A" but the word boxes are ONLY the name
  // tokens — the −7,48 has no box. NAMINIS's own 1,49 total (next line) sits at the same Y
  // so it clusters into this name row, triggering the clean-positive-total early return.
  L('NAMINIS 2,5: PIENAS -7, 48 A', 63, 916, 650, 700, [
    W('NAMINIS', 63, 213, 650, 695), W('2,5:', 241, 306, 652, 698), W('PIENAS', 327, 453, 655, 700),
  ]),
  L('1,49 A', 803, 917, 652, 698, [W('1,49', 803, 876, 652, 696), W('A', 898, 917, 654, 698)]),
];

describe('IKI receipt-109 — discount fused onto a next-name row that ALSO carries its own total', () => {
  const products = parseIkiColumnar(LINES, 0, LINES.length);
  const find = (re: RegExp) => products.find((p) => re.test(p.name));

  test('salmon recovers its −7,48 discount → promoPrice ≈ 9.99/kg', () => {
    const salmon = find(/ANTIN|LASI[ŠS]/i)!;
    expect(salmon).toBeDefined();
    expect(salmon.unit).toBe('kg');
    expect(salmon.price).toBeCloseTo(16.99, 2);        // €/kg
    expect(salmon.promoPrice).toBeCloseTo(9.99, 2);    // (18.15 − 7.48) ÷ 1.068
  });

  test('NAMINIS keeps its own 1,49 total and is NOT charged the salmon’s 7,48', () => {
    const nam = find(/NAMINIS/i)!;
    expect(nam).toBeDefined();
    expect(nam.price).toBeCloseTo(1.49, 2);
    expect(nam.promoPrice == null).toBe(true);
  });
});
