import { parseIkiColumnar, type IkiLine, type IkiWord } from '../shared/parsers/ikiParser';

// Guards on the receipt-127 word-boxless-total recovery (trailTotal). The adversarial
// red-team proved two ways the naive recovery misfired; these lock the fixes.
const W = (text: string, xL: number, xR: number, yT: number, yB: number): IkiWord =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB });
const L = (text: string, xL: number, xR: number, yT: number, yB: number, words: IkiWord[]): IkiLine =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB, words });

describe('trailTotal must NOT fire on a name-CONTINUATION row (wrapped name)', () => {
  // A long product name wraps across two OCR lines BEFORE its price. MLKit leaks an
  // unrelated "0,99 A" into the continuation line's TEXT (no word box). The real total
  // (1,89) sits on its own right-column row well below. The recovered 0,99 must be ignored
  // on the continuation — else the product splits into a phantom "…@0,99" + an orphan "?".
  const LINES: IkiLine[] = [
    L('JUODA DUONA', 60, 360, 100, 145, [W('JUODA', 60, 200, 100, 145), W('DUONA', 210, 360, 100, 145)]),
    // continuation: pure name, but the source text leaked "0,99 A" with no box
    L('SAULEGRAZOMIS 0,99 A', 60, 975, 155, 200, [W('SAULEGRAZOMIS', 60, 360, 155, 200)]),
    // the REAL total on its own row, ~3 line-heights down so it does not cluster onto the name
    L('1,89 A', 840, 975, 305, 350, [W('1,89', 840, 920, 305, 350), W('A', 950, 975, 305, 350)]),
  ];
  const products = parseIkiColumnar(LINES, 0, LINES.length);

  test('stays ONE product with the real total, no phantom 0,99, no orphan "?"', () => {
    expect(products.some((p) => p.name === '?' || p.name === '')).toBe(false);
    expect(products.some((p) => Math.abs(p.price - 0.99) < 0.005)).toBe(false);
    const main = products.find((p) => /JUODA|DUONA|SAULEGRAZOMIS/i.test(p.name));
    expect(main).toBeDefined();
    expect(main!.price).toBeCloseTo(1.89, 2);
    expect(/JUODA/i.test(main!.name) && /SAULEGRAZOMIS/i.test(main!.name)).toBe(true);
  });
});

describe('a 2-space-minus boxless discount must not flip into a positive total', () => {
  // "PIENAS 1,49" then a discount with a NON-NUOLAIDA label whose minus is TWO spaces from
  // the number and whose amount is dropped from the word boxes ("RABATAS -  0,40 A", boxless).
  // The single-space sign guard let trailTotal read the 0,40 as a positive total → a phantom
  // +0,40 product, dropping the real discount. The relaxed `-\s*` guards must treat it as a
  // discount on the milk instead.
  const LINES: IkiLine[] = [
    L('PIENAS 1,49 A', 60, 975, 100, 145, [
      W('PIENAS', 60, 240, 100, 145), W('1,49', 840, 920, 100, 145), W('A', 950, 975, 100, 145),
    ]),
    // discount: amount lives ONLY in the source text, minus two spaces off the number
    L('RABATAS -  0,40 A', 60, 975, 155, 200, [W('RABATAS', 60, 280, 155, 200)]),
  ];
  const products = parseIkiColumnar(LINES, 0, LINES.length);

  test('no product is priced 0,40 (the discount did not become a positive total)', () => {
    expect(products.some((p) => Math.abs(p.price - 0.40) < 0.005)).toBe(false);
  });

  test('PIENAS keeps its 0,40 discount (promo 1,09)', () => {
    const milk = products.find((p) => /PIENAS/i.test(p.name));
    expect(milk).toBeDefined();
    expect(milk!.price).toBeCloseTo(1.49, 2);
    expect(milk!.promoPrice).toBeCloseTo(1.09, 2); // 1,49 − 0,40
  });
});
