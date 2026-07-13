import { parseIkiColumnar, type IkiLine, type IkiWord } from '../shared/parsers/ikiParser';

// Receipt 122 pattern: TWO identical "CLEVER … DUO" loaves (you bought two; only one is
// 50% off). OCR drops the 2nd loaf's name boxes — its name survives only as the LEAD of the
// varškė discount line "-2,50 A CLEVER SVIESI RAIKYTA DUO" (only the -2,50/A are word-boxed).
// The 2nd loaf must still be recovered as "CLEVER …", not left as "?", even though the 1st
// loaf already owns that name.
const W = (text: string, xL: number, xR: number, yT: number, yB: number): IkiWord =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB });
const L = (text: string, xL: number, xR: number, yT: number, yB: number, words: IkiWord[]): IkiLine =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB, words });

const LINES: IkiLine[] = [
  // loaf #1 — name + total
  L('CLEVER SVIESI RAIKYTA DUO 0,45 A', 60, 975, 100, 145, [
    W('CLEVER', 60, 200, 100, 145), W('SVIESI', 210, 340, 100, 145), W('RAIKYTA', 350, 520, 100, 145),
    W('DUO', 530, 600, 100, 145), W('0,45', 840, 920, 100, 145), W('A', 950, 975, 100, 145),
  ]),
  // loaf #1 — 50% discount
  L('50% NUOLAIDA -0,22 A', 60, 975, 160, 205, [
    W('50%', 60, 130, 160, 205), W('NUOLAIDA', 140, 320, 160, 205), W('-0,22', 840, 940, 160, 205), W('A', 950, 975, 160, 205),
  ]),
  // varškė — name + total
  L('ZEMAITIJOS VARSKE 6,49 A', 60, 975, 220, 265, [
    W('ZEMAITIJOS', 60, 280, 220, 265), W('VARSKE', 290, 440, 220, 265), W('6,49', 840, 920, 220, 265), W('A', 950, 975, 220, 265),
  ]),
  // varškė discount (-2,50 word-boxed) FUSED with loaf #2's name (NO boxes for the name)
  L('-2,50 A CLEVER SVIESI RAIKYTA DUO', 60, 975, 280, 325, [
    W('-2,50', 840, 940, 280, 325), W('A', 950, 975, 280, 325),
  ]),
  // loaf #2 — total only (its name was the lead of the line above)
  L('0,45 A', 840, 975, 340, 385, [W('0,45', 840, 920, 340, 385), W('A', 950, 975, 340, 385)]),
];

describe('IKI duplicate-name recovery (receipt 122 — two CLEVER loaves)', () => {
  const products = parseIkiColumnar(LINES, 0, LINES.length);
  const breads = products.filter((p) => /CLEVER|RAIKYTA/i.test(p.name));

  test('BOTH loaves are named — the 2nd is not left as "?"', () => {
    expect(breads.length).toBe(2);
    expect(products.some((p) => p.name === '?' || p.name === '')).toBe(false);
  });

  test('varškė is present (the discount line did not consume it)', () => {
    expect(products.some((p) => /VARSKE|VARŠKE|EMAITIJOS/i.test(p.name))).toBe(true);
  });
});
