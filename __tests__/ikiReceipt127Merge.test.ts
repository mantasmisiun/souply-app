import { parseIkiColumnar, type IkiLine, type IkiWord } from '../shared/parsers/ikiParser';

// Receipt 127 regression. The 2nd CLEVER loaf prints its NAME and its TOTAL on ONE line
// ("CLEVER SVIESI RAIKY TA DUO 0, 45 A"), but MLKit kept "0, 45 A" only in the line TEXT
// and dropped its right-column word boxes — so the column engine saw a NAME-ONLY row with
// no total. With nothing to anchor it, the assembler then merged the FOLLOWING product
// (LIETUVIŠKI AGURKAI, 0,99) into the loaf: one bogus product
// "CLEVER SVIESI RAIKY TA DUO LIETUVISKI TLGAVAISIAI AG" priced 0,99, and the 0,45 loaf lost.
// The classifier must recover the word-boxless trailing total from the source line so the
// loaf anchors its own product and the cucumber stays separate.
const W = (text: string, xL: number, xR: number, yT: number, yB: number): IkiWord =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB });
const L = (text: string, xL: number, xR: number, yT: number, yB: number, words: IkiWord[]): IkiLine =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB, words });

// Real coordinates lifted verbatim from receipt-127 wordsDump (bottom product block).
const LINES: IkiLine[] = [
  // curd — name + total (6,49 word-boxed)
  L('7EMAITIJOS VARSKĖ, 9% RIE', 90, 599, 624, 679, [
    W('7EMAITIJOS', 90, 293, 624, 675), W('VARSKÉ,', 320, 448, 632, 679),
    W('9%', 474, 516, 638, 682), W('RIE', 536, 599, 640, 685),
  ]),
  L('6, 49 A', 836, 963, 641, 688, [W('6,', 836, 864, 641, 687), W('49', 878, 919, 641, 687), W('A', 942, 963, 642, 688)]),
  // curd — discount (NUOLAIDA SU KORTELE word-boxed, -2,50 only in line text)
  L('NUOLAIDA SU KORTELE -2, 50 A', 92, 963, 672, 736, [
    W('NUOLAIDA', 92, 247, 672, 722), W('SU', 270, 311, 675, 722), W('KORTELE', 316, 472, 675, 726),
  ]),
  // 2nd CLEVER loaf — NAME + TOTAL on one line, but "0, 45 A" dropped from the word boxes
  L('CLEVER SVIESI RAIKY TA DUO 0, 45 A', 80, 975, 709, 772, [
    W('CLEVER', 80, 214, 709, 758), W('SVIESI', 225, 347, 712, 760), W('RAIKY', 387, 486, 716, 765),
    W('TA', 478, 517, 719, 765), W('DUO', 536, 598, 720, 767),
  ]),
  // cucumbers — name (price 0,99 sits on its own boxed cluster just below)
  L('LIETUVISKI TLGAVAISIAI AG', 80, 601, 747, 794, [
    W('LIETUVISKI', 80, 304, 747, 797), W('TLGAVAISIAI', 313, 536, 755, 804), W('AG', 559, 601, 763, 806),
  ]),
  L('0,99 A', 835, 962, 766, 813, [W('0,99', 835, 919, 766, 813), W('A', 942, 962, 766, 813)]),
  // cucumbers — discount (NUOLAIDA + -0,40 both word-boxed)
  L('NUOLAIDA', 80, 242, 795, 837, [W('NUOLAIDA', 80, 242, 795, 837)]),
  L('-0, 40 A', 814, 962, 806, 851, [W('-0,', 814, 864, 806, 851), W('40', 877, 919, 806, 851), W('A', 942, 962, 806, 851)]),
];

describe('IKI receipt-127 — word-boxless trailing total must not merge the next product', () => {
  const products = parseIkiColumnar(LINES, 0, LINES.length);
  const has = (re: RegExp) => products.filter((p) => re.test(p.name));

  test('no product fuses the loaf name with the cucumber name', () => {
    const merged = products.find((p) => /RAIKY/i.test(p.name) && /LIETUVISKI|TLGAVAISIAI/i.test(p.name));
    expect(merged).toBeUndefined();
  });

  test('the 2nd CLEVER loaf is its own product priced 0,45', () => {
    const loaf = has(/RAIKY/i);
    expect(loaf.length).toBe(1);
    expect(loaf[0].price).toBeCloseTo(0.45, 2);
  });

  test('the cucumbers are their own product priced 0,99 with the -0,40 discount', () => {
    const cuke = has(/LIETUVISKI|TLGAVAISIAI/i);
    expect(cuke.length).toBe(1);
    expect(cuke[0].price).toBeCloseTo(0.99, 2);
    expect(cuke[0].promoPrice).toBeCloseTo(0.59, 2); // 0,99 − 0,40
  });

  test('the curd survives intact at 6,49 (the loaf split did not disturb it)', () => {
    const curd = has(/EMAITIJOS|VARSK/i);
    expect(curd.length).toBe(1);
    expect(curd[0].price).toBeCloseTo(6.49, 2);
  });
});
