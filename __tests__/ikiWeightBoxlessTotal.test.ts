import { parseIkiColumnar, type IkiLine, type IkiWord } from '../shared/parsers/ikiParser';

// GAP A (red-team completeness critic). A WEIGHED item where MLKit dropped the line-total's
// word box (the total "2,87 A" survives only in the weight line's SOURCE TEXT) AND the €/kg
// is garbled ("3,9a" → unreadable). Before the fix the weight branch read the total from the
// word text only, found none, so total=null; with no total the assembler could not recover
// €/kg = total ÷ qty and the price-poisoning guard zeroed the item. The weight branch must now
// fall back to the source line for the trailing total, restoring the per-kg price.
const W = (text: string, xL: number, xR: number, yT: number, yB: number): IkiWord =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB });
const L = (text: string, xL: number, xR: number, yT: number, yB: number, words: IkiWord[]): IkiLine =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB, words });

describe('IKI weighed item — word-boxless line total + garbled €/kg', () => {
  const lines: IkiLine[] = [
    L('LIETUVISKI POMIDORAI', 80, 430, 100, 124, [W('LIETUVISKI', 80, 250, 100, 124), W('POMIDORAI', 260, 430, 100, 124)]),
    // weight row: "2,87 A" is in the source TEXT but has NO word box (dropped), and "3,9a" €/kg
    // is unreadable. Only the kg quantity + the EUR/kg marker survive as boxes.
    L('0,720 kg X 3,9a EUR/ kg 2,87 A', 80, 870, 140, 184, [
      W('0,720', 80, 160, 140, 184), W('kg', 170, 205, 140, 184), W('X', 210, 230, 140, 184),
      W('3,9a', 240, 300, 140, 184), W('EUR/', 310, 390, 140, 184), W('kg', 400, 435, 140, 184),
    ]),
    // next product flushes POMIDORAI
    L('NAMINIS 2,5%', 80, 300, 240, 282, [W('NAMINIS', 80, 200, 240, 282), W('2,5%', 210, 300, 240, 282)]),
    L('1,49 A', 740, 870, 240, 282, [W('1,49', 740, 832, 240, 282), W('A', 852, 870, 240, 282)]),
  ];
  const products = parseIkiColumnar(lines, 0, lines.length);
  const pom = products.find((p) => /POMIDOR/i.test(p.name));

  test('recovers €/kg = total ÷ qty (2,87 ÷ 0,720 ≈ 3,99), priced per kg — NOT 0, NOT the line total', () => {
    expect(pom).toBeDefined();
    expect(pom!.unit).toBe('kg');
    expect(pom!.quantity).toBeCloseTo(0.72, 2);
    expect(pom!.price).toBeCloseTo(3.99, 1);     // recovered €/kg
    expect(pom!.price).not.toBe(0);              // the poisoning guard did NOT zero it
    expect(pom!.price).not.toBeCloseTo(2.87, 1); // did NOT absorb the line total as a unit price
  });

  test('the weight text did not leak into the name', () => {
    expect(pom!.name).not.toMatch(/kg|EUR/i);
  });
});

// Red-team (GAP A): if the NEXT product's total is fused onto the weight calc line's source
// text ("…EUR/ kg 2,87 A 1,49 A", both boxless) AND the €/kg is garbled, the $-anchored match
// must NOT grab the FOREIGN 1,49 and write €/kg = 1,49 ÷ 0,720 = 2,07 as a per-kg reference
// price. Two VAT-lettered amounts ⇒ ambiguous ⇒ recover nothing ⇒ the poisoning guard zeroes it.
describe('IKI weighed item — next-product total bled onto the weight line must NOT be grabbed', () => {
  // OWN total "2,87 A" AND a foreign "1,49 A" both fused boxless onto the weight calc line's
  // source text; €/kg garbled. The naive `?? firstSrc.match` (no count guard) would grab the
  // $-anchored LAST amount (1,49) → €/kg = 1,49 ÷ 0,720 = 2,07 written confidently as a per-kg
  // REFERENCE price. The count guard sees TWO VAT amounts → refuses → the item is shown priced 0.
  const lines: IkiLine[] = [
    L('LIETUVISKI POMIDORAI', 80, 430, 100, 124, [W('LIETUVISKI', 80, 250, 100, 124), W('POMIDORAI', 260, 430, 100, 124)]),
    L('0,720 kg X 3,9a EUR/ kg 2,87 A 1,49 A', 80, 870, 140, 184, [
      W('0,720', 80, 160, 140, 184), W('kg', 170, 205, 140, 184), W('X', 210, 230, 140, 184),
      W('3,9a', 240, 300, 140, 184), W('EUR/', 310, 390, 140, 184), W('kg', 400, 435, 140, 184),
    ]),
  ];
  const products = parseIkiColumnar(lines, 0, lines.length);
  const pom = products.find((p) => /POMIDOR/i.test(p.name));

  test('does not write the foreign 1,49 as a per-kg price (2,07); shown but priced 0', () => {
    expect(pom).toBeDefined();
    expect(pom!.unit).toBe('kg');
    expect(pom!.price).not.toBeCloseTo(2.07, 1); // the foreign-value bug
    expect(pom!.price).toBe(0);                  // poisoning guard fired honestly
    expect(pom!.pricePerUnit).toBeNull();
  });
});
