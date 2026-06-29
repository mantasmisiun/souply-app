import { parseIkiColumnar, type IkiLine, type IkiWord } from '../shared/parsers/ikiParser';

// Receipt-100 (IKI Šiauliai) word boxes: MLKit split the plastic-bag word "MAIŠELIS"
// into "MAISEL IS", so the old skip stem `MAI[SŠ]ELIS` (contiguous) missed it and the
// bag "MAISEL IS PLASTIKINIS LENG" was parsed as a 0,01 product. The split/char-tolerant
// stem + the distinctive PLASTIKIN anchor now skip it, while a real product survives.
const W = (text: string, xL: number, xR: number, yT: number, yB: number): IkiWord =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB });
const L = (text: string, xL: number, xR: number, yT: number, yB: number, words: IkiWord[]): IkiLine =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB, words });

const LINES: IkiLine[] = [
  L('RAUDONOSIOS PAPRIKOS', 22, 405, 583, 628, [W('RAUDONOSIOS', 22, 232, 586, 626), W('PAPRIKOS', 254, 404, 583, 621)]),
  L('0, 470 kg X 3,49 EUR/ kg', 59, 521, 617, 665, [
    W('0,', 59, 72, 617, 658), W('470', 86, 142, 617, 658), W('kg', 161, 214, 617, 658),
    W('X', 254, 274, 617, 658), W('3,49', 294, 371, 617, 658), W('EUR/', 389, 464, 617, 658), W('kg', 484, 521, 617, 658),
  ]),
  L('1, 64 A', 727, 822, 616, 656, [W('1,', 727, 748, 618, 657), W('64', 749, 784, 617, 656), W('A', 803, 822, 617, 655)]),
  L('MAISEL IS PLASTIKINIS LENG', 21, 502, 843, 884, [
    W('MAISEL', 21, 134, 847, 883), W('IS', 142, 174, 847, 881), W('PLASTIKINIS', 197, 405, 844, 881), W('LENG', 428, 502, 843, 879),
  ]),
  L('0, 01 A', 714, 823, 835, 876, [W('0,', 714, 739, 838, 876), W('01', 751, 783, 837, 875), W('A', 806, 823, 836, 874)]),
];

describe('IKI receipt-100 — OCR-split plastic bag is skipped, not a product', () => {
  const products = parseIkiColumnar(LINES, 0, LINES.length);

  test('the real product survives', () => {
    expect(products.some((p) => /PAPRIK|RAUDONOS/i.test(p.name))).toBe(true);
  });

  test('the bag (MAISEL IS PLASTIKINIS LENG) is NOT parsed as a product', () => {
    expect(products.some((p) => /PLASTIKIN|MAI[SŠ]EL/i.test(p.name))).toBe(false);
  });
});
