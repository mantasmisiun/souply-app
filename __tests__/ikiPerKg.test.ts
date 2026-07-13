import { extractPerKg, parseIkiColumnar, type IkiLine, type IkiWord } from '../shared/parsers/ikiParser';

// €/kg extraction — the unit-level fix.
describe('IKI €/kg extraction (OCR comma-drop tolerance)', () => {
  test('recovers €/kg when OCR dropped the decimal comma: "16 99 EUR" → 16.99', () => {
    expect(extractPerKg('1,068 kg 16 99 EUR/ kg')).toBeCloseTo(16.99, 2);
  });
  test('still reads the normal comma forms', () => {
    expect(extractPerKg('1,068 kg X 16,99 EUR/ kg')).toBeCloseTo(16.99, 2);
    expect(extractPerKg('0, 720 kg X 3,9 EUR/ kg')).toBeCloseTo(3.9, 2);
    expect(extractPerKg('0,470 kg X 3,49 EUR/ kg')).toBeCloseTo(3.49, 2);
  });
  test('returns null when there is no €/kg slot', () => {
    expect(extractPerKg('NAMINIS 2, 5. PIENAS')).toBeNull();
    expect(extractPerKg('18, 15 A')).toBeNull();
  });
});

// End-to-end: the salmon row from receipt-91, where OCR dropped BOTH the "X"
// multiplier and the comma in "16,99" ("1,068 kg 16 99 EUR/ kg"). Before the fix
// the whole weight row fell into the name and the product was priced as 1 vnt;
// now it must resolve as a weighed item (1.068 kg × 16.99 €/kg = 18.15).
const W = (text: string, xL: number, xR: number, yT: number, yB: number): IkiWord =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB });
const L = (text: string, xL: number, xR: number, yT: number, yB: number, words: IkiWord[]): IkiLine =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB, words });

describe('IKI column engine — weighed salmon with OCR-mangled €/kg', () => {
  test('recognises the amount × €/kg calculation', () => {
    const lines: IkiLine[] = [
      L('ATLANT INĖS LAŠIS0S BE GAL', 81, 548, 411, 454, [
        W('ATLANT', 81, 191, 411, 454), W('INÉS', 197, 266, 413, 454),
        W('LAŠIS0S', 288, 417, 413, 456), W('BE', 438, 473, 415, 456), W('GAL', 495, 548, 415, 457),
      ]),
      L('1,068 kg 16 99 EUR/ kg', 119, 584, 450, 495, [
        W('1,068', 119, 194, 450, 495), W('kg', 232, 272, 450, 495), W('16', 349, 387, 450, 495),
        W('99', 410, 437, 450, 495), W('EUR/', 459, 535, 450, 495), W('kg', 558, 584, 450, 495),
      ]),
      L('18, 15 A', 744, 870, 457, 499, [W('18,', 744, 783, 460, 502), W('15', 800, 832, 458, 500), W('A', 852, 870, 457, 499)]),
      // discount for salmon fused with the NEXT product's name — flushes salmon.
      L('-7, 48 A NAMINIS 2, 5. PIENAS', 81, 870, 492, 567, [W('-7,', 742, 783, 492, 534), W('48', 796, 832, 492, 533), W('A', 853, 870, 492, 533)]),
      L('1, 49 A', 773, 871, 530, 573, [W('1,', 773, 797, 530, 571), W('49', 796, 833, 530, 571), W('A', 854, 871, 530, 571)]),
    ];
    const products = parseIkiColumnar(lines, 0, lines.length);
    const salmon = products.find((p) => /ATLANT|LA[ŠS]I[ŠS]/i.test(p.name));
    expect(salmon).toBeDefined();
    expect(salmon!.unit).toBe('kg');
    expect(salmon!.quantity).toBeCloseTo(1.068, 2);
    expect(salmon!.price).toBeCloseTo(16.99, 2);            // €/kg, not the 18.15 line total
    // the weight text must NOT have leaked into the name
    expect(salmon!.name).not.toMatch(/kg|EUR/i);
  });
});

// receipt-92 POMIDORAI: the €/kg "3,99" came through as "3,9a" (2nd digit OCR'd as a
// letter), so extractPerKg gives up. The whole weight calc was then lost and the item
// was priced as 1 vnt × €2.87 (the LINE TOTAL — poisoning the per-kg reference price).
// It must instead recover €/kg = total ÷ printed qty (2.87 ÷ 0.720 = 3.99) and stay weighed.
describe('IKI weighed item — garbled €/kg recovery + poisoning guard', () => {
  test('garbled €/kg (3,9a) → recovered from total ÷ qty → priced per kg, NOT the line total', () => {
    const lines: IkiLine[] = [
      L('LIETUVISKI POMIDORAI', 80, 430, 100, 124, [W('LIETUVISKI', 80, 250, 100, 124), W('POMIDORAI', 260, 430, 100, 124)]),
      L('0,720 kg X 3,9a EUR/ kg', 80, 460, 140, 184, [
        W('0,720', 80, 160, 140, 184), W('kg', 170, 205, 140, 184), W('X', 210, 230, 140, 184),
        W('3,9a', 240, 300, 140, 184), W('EUR/', 310, 390, 140, 184), W('kg', 400, 435, 140, 184),
      ]),
      L('2,87 A', 740, 870, 147, 189, [W('2,87', 740, 832, 147, 189), W('A', 852, 870, 147, 189)]),
      L('NUOLAIDA -0,72 A', 80, 870, 190, 232, [W('NUOLAIDA', 80, 250, 190, 232), W('-0,72', 740, 832, 190, 232), W('A', 852, 870, 190, 232)]),
      // next product flushes POMIDORAI
      L('NAMINIS 2,5%', 80, 300, 240, 282, [W('NAMINIS', 80, 200, 240, 282), W('2,5%', 210, 300, 240, 282)]),
      L('1,49 A', 740, 870, 240, 282, [W('1,49', 740, 832, 240, 282), W('A', 852, 870, 240, 282)]),
    ];
    const products = parseIkiColumnar(lines, 0, lines.length);
    const pom = products.find((p) => /POMIDOR/i.test(p.name));
    expect(pom).toBeDefined();
    expect(pom!.unit).toBe('kg');
    expect(pom!.price).toBeCloseTo(3.99, 1);                // €/kg recovered, NOT 2.87
    expect(pom!.price).not.toBeCloseTo(2.87, 1);
    expect(pom!.quantity).toBeCloseTo(0.72, 2);
    expect(pom!.promoPrice).toBeCloseTo(2.99, 1);           // per-kg discount: (2.87 − 0.72) ÷ 0.72
  });

  test('€/kg AND qty both unreadable → item is SHOWN (unit kg) but priced 0, so the server skips it (never the line total)', () => {
    const lines: IkiLine[] = [
      L('SVOGUNAI BALTIEJI', 80, 430, 100, 124, [W('SVOGUNAI', 80, 250, 100, 124), W('BALTIEJI', 260, 430, 100, 124)]),
      // qty OCR'd as a bare "0" (decimals dropped) AND €/kg garbled → nothing to divide by
      L('0 kg X 3,a EUR/ kg', 80, 460, 140, 184, [
        W('0', 80, 110, 140, 184), W('kg', 120, 155, 140, 184), W('X', 160, 180, 140, 184),
        W('3,a', 190, 240, 140, 184), W('EUR/', 250, 330, 140, 184), W('kg', 340, 375, 140, 184),
      ]),
      L('1,64 A', 740, 870, 147, 189, [W('1,64', 740, 832, 147, 189), W('A', 852, 870, 147, 189)]),
      L('NAMINIS 2,5%', 80, 300, 240, 282, [W('NAMINIS', 80, 200, 240, 282), W('2,5%', 210, 300, 240, 282)]),
      L('1,49 A', 740, 870, 240, 282, [W('1,49', 740, 832, 240, 282), W('A', 852, 870, 240, 282)]),
    ];
    const products = parseIkiColumnar(lines, 0, lines.length);
    const onion = products.find((p) => /SVOGUN/i.test(p.name));
    expect(onion).toBeDefined();                            // SHOWN, not dropped
    expect(onion!.unit).toBe('kg');
    expect(onion!.price).toBe(0);                           // → server's `item.price <= 0` skip → no reference write
    expect(onion!.pricePerUnit).toBeNull();
    expect(onion!.price).not.toBeCloseTo(1.64, 1);          // did NOT absorb the line total as a unit price
  });
});
