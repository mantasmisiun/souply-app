import { parseIkiColumnar, type IkiLine, type IkiWord } from '../shared/parsers/ikiParser';

// Receipt 119: the receipt's AGGREGATE savings total ("sutaupėte 2,50 EUR") OCR-fused
// onto a stray RE-PRINT of an already-bought product's name, producing a row whose TEXT
// is "CLEVER SVIESI RAIKYTA DUO -2, 50 A" but whose only word boxes are the NAME (the
// "-2,50" has no box). Untreated this both (a) attaches the 2,50 to the open product as a
// phantom discount and (b) mints a duplicate "CLEVER" product. The parser must recognise
// the word-boxless trailing negative on a DUPLICATE name and drop the whole row.
const W = (text: string, xL: number, xR: number, yT: number, yB: number): IkiWord =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB });
const L = (text: string, xL: number, xR: number, yT: number, yB: number, words: IkiWord[]): IkiLine =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB, words });

const LINES: IkiLine[] = [
  // 1) bread — name + clean total on one row
  L('CLEVER SVIESI RAIKYTA DUO 0, 45 A', 80, 870, 100, 145, [
    W('CLEVER', 80, 200, 100, 145), W('SVIESI', 210, 320, 100, 145),
    W('RAIKYTA', 330, 470, 100, 145), W('DUO', 480, 545, 100, 145),
    W('0,', 744, 783, 100, 145), W('45', 800, 832, 100, 145), W('A', 852, 870, 100, 145),
  ]),
  // 2) varškė — name + total (the product the phantom discount would poison)
  L('ZEMAITIJOS VARSKE 6, 49 A', 80, 870, 200, 245, [
    W('ZEMAITIJOS', 80, 260, 200, 245), W('VARSKE', 270, 400, 200, 245),
    W('6,', 744, 783, 200, 245), W('49', 800, 832, 200, 245), W('A', 852, 870, 200, 245),
  ]),
  // 3) the aggregate-savings line: full TEXT carries "-2, 50 A", but only the NAME has
  //    word boxes → trailDisc=2.50, word-boxless, on a DUPLICATE of bought-bread (1).
  L('CLEVER SVIESI RAIKYTA DUO -2, 50 A', 80, 870, 300, 345, [
    W('CLEVER', 80, 200, 300, 345), W('SVIESI', 210, 320, 300, 345),
    W('RAIKYTA', 330, 470, 300, 345), W('DUO', 480, 545, 300, 345),
  ]),
  // 4) agurkai — name + total
  L('LIETUVISKI AGURKAI 0, 99 A', 80, 870, 400, 445, [
    W('LIETUVISKI', 80, 250, 400, 445), W('AGURKAI', 260, 410, 400, 445),
    W('0,', 744, 783, 400, 445), W('99', 800, 832, 400, 445), W('A', 852, 870, 400, 445),
  ]),
  // 5) a GENUINE word-boxed discount for agurkai — must still apply (negative IS boxed)
  L('NUOLAIDA -0, 40 A', 80, 870, 500, 545, [
    W('NUOLAIDA', 80, 260, 500, 545), W('-0,', 744, 800, 500, 545),
    W('40', 810, 840, 500, 545), W('A', 852, 870, 500, 545),
  ]),
];

describe('IKI aggregate-savings line fused onto a re-printed name (receipt 119)', () => {
  const products = parseIkiColumnar(LINES, 0, LINES.length);
  const find = (re: RegExp) => products.find((p) => re.test(p.name));

  test('does NOT mint a phantom duplicate product', () => {
    expect(products.length).toBe(3);
    const breads = products.filter((p) => /CLEVER|RAIKYTA/i.test(p.name));
    expect(breads.length).toBe(1);
  });

  test('the open product (varškė) is NOT poisoned by the 2,50 aggregate discount', () => {
    const varske = find(/VARSKE|VARŠKE/i)!;
    expect(varske).toBeTruthy();
    expect(varske.price).toBeCloseTo(6.49, 2);
    // 6.49 − 2.50 = 3.99 would be the poisoned promo — there must be NO such promo.
    expect(varske.promoPrice == null || varske.promoPrice >= 6.48).toBe(true);
  });

  test('a GENUINE word-boxed discount on another product still applies', () => {
    const agurkai = find(/AGURKAI/i)!;
    expect(agurkai).toBeTruthy();
    expect(agurkai.price).toBeCloseTo(0.99, 2);
    expect(agurkai.promoPrice).toBeCloseTo(0.59, 2);   // 0.99 − 0.40
  });
});
