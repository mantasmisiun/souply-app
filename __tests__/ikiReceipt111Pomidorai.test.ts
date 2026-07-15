import { parseIkiColumnar, type IkiLine, type IkiWord } from '../shared/parsers/ikiParser';

// Receipt-111 (IKI Šiauliai): the LIETUVISKI POMIDORAI weighed line lost its calc.
// OCR mangled the €/kg to an unreadable "3.ga" AND the quantity unit "kg"→"ka", so the
// per-kg number couldn't be read. Before the fix the calc row was mistaken for a clean
// total and fused into the NAME ("LIETUVISKI POMIDORAI 0,720 ka X 3.ga EUR/kg"), and the
// item dropped to a per-vnt price (2.87 for 1 vnt) instead of a weighed €/kg. The fix:
// a leading 3-decimal kg quantity + an "EUR/kg" MARKER on the line ⇒ a weighed item even
// when the €/kg digits are garbled; the €/kg is then recovered from total ÷ qty.
const W = (text: string, xL: number, xR: number, yT: number, yB: number): IkiWord =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB });
const L = (text: string, xL: number, xR: number, yT: number, yB: number, words: IkiWord[]): IkiLine =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB, words });

const LINES: IkiLine[] = [
  L('LIETUVISKI POMIDORAI', 51, 440, 589, 641, [
    W('LIETUVISKI', 51, 249, 591, 638), W('POMIDORAI', 272, 440, 588, 635),
  ]),
  // Weighed calc row: garbled €/kg "3.ga", unit "ka", with the total "2,87" clustered in.
  L('0. 720 ka X 3.ga EUR/ kg', 92, 558, 624, 672, [
    W('0.', 92, 103, 632, 671), W('720', 124, 174, 632, 671), W('ka', 192, 243, 631, 670),
    W('X', 284, 308, 630, 668), W('3.ga', 320, 400, 628, 668), W('EUR/', 422, 497, 628, 667), W('kg', 520, 558, 627, 666),
  ]),
  L('2, 87 A', 770, 873, 624, 672, [W('2,', 770, 793, 628, 669), W('87', 796, 834, 626, 668), W('A', 854, 873, 625, 666)]),
  // Card discount −0,72 on its own row below.
  L('-0, 72 A NUOLAIDA', 739, 871, 700, 742, [W('-0,', 739, 783, 702, 740), W('72', 797, 833, 702, 740), W('A', 854, 871, 702, 739)]),
];

describe('IKI receipt-111 — weighed item recovered despite a garbled €/kg ("3.ga") + "ka"', () => {
  const products = parseIkiColumnar(LINES, 0, LINES.length);
  const pom = products.find((p) => /POMIDOR/i.test(p.name))!;

  test('POMIDORAI stays weighed; €/kg recovered from total ÷ qty', () => {
    expect(pom).toBeDefined();
    expect(pom.unit).toBe('kg');
    expect(pom.price).toBeCloseTo(3.99, 1);          // 2,87 ÷ 0,720
    expect(pom.name).not.toMatch(/EUR|720|3\.ga/i);  // calc NOT fused into the name
  });

  test('a weighed line is flagged isWeighable so the server keeps a weighable catalog SP', () => {
    // Root cause of the receipt-112 orphan capture: a null isWeighable made the
    // server resolver treat the weighable catalog SP as a form mismatch and fall
    // through to a garbled same-name orphan. The parser must flag weighed rows.
    expect(pom.isWeighable).toBe(true);
  });

  test('the −0,72 card discount gives a per-kg promo, not a per-vnt total', () => {
    expect(pom.promoPrice).toBeCloseTo(2.99, 1);     // (2,87 − 0,72) ÷ 0,720
  });
});
