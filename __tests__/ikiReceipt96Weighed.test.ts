import { parseIkiColumnar, type IkiLine, type IkiWord } from '../shared/parsers/ikiParser';

// Real receipt-96 word boxes for two weighed items that BOTH silently dropped to a unit price:
//  - POMIDORAI: its €/kg slot's "EUR" was OCR-garbled to "ÉUR" → the weight row wasn't
//    recognised → priced 0 (was a poisoning-guard drop). EUR-tolerance must fix it.
//  - RAUDONOSIOS: its weight is fused onto the NAME line, but MLKit kept ONLY the two name
//    words boxed — the weight text has no word-boxes, so the column engine never saw it →
//    priced 1 vnt. The line-text recovery must re-read the source line and recover it.
const W = (text: string, xL: number, xR: number, yT: number, yB: number): IkiWord =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB });
const L = (text: string, xL: number, xR: number, yT: number, yB: number, words: IkiWord[]): IkiLine =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB, words });

const LINES: IkiLine[] = [
  // POMIDORAI — €/kg "3, 9a ÉUR" (garbled E→É and the 2nd digit 9→9a)
  L('LIETUVISKI POMIDORAI', 30, 405, 557, 600, [W('LIETUVISKI', 30, 220, 557, 600), W('POMIDORAI', 239, 405, 557, 600)]),
  L('0, 720 kg X 3, 9a ÉUR/ kg', 58, 515, 593, 635, [W('0,', 58, 71, 593, 635), W('720', 86, 134, 593, 635), W('kg', 156, 208, 593, 635), W('X', 247, 269, 593, 635), W('3,', 280, 315, 593, 635), W('9a', 325, 360, 593, 635), W('ÉUR/', 383, 458, 593, 635), W('kg', 478, 515, 593, 635)]),
  L('2, 87 A', 714, 823, 596, 641, [W('2,', 714, 749, 598, 641), W('87', 748, 784, 596, 640), W('A', 805, 823, 596, 638)]),
  L('NUOLAIDA -0,72 A', 16, 823, 626, 675, [W('NUOLAIDA', 16, 168, 626, 669)]),
  // RAUDONOSIOS — weight fused on the NAME line; only RAUDONOSIOS + PAPRIKOS have word-boxes
  L('RAUDONOSIOS PAPRIKOS 0,470 kg X 3,49 EUR/ kg', 17, 515, 672, 744, [W('RAUDONOSIOS', 17, 225, 672, 706), W('PAPRIKOS', 247, 399, 672, 706)]),
  L('1, 64 A', 713, 822, 714, 751, [W('1,', 713, 736, 715, 751), W('64', 749, 783, 715, 750), W('A', 805, 822, 714, 749)]),
  L('NUOLAIDA SU KORTELe', 15, 379, 739, 791, [W('NUOLAIDA', 15, 167, 739, 786), W('SU', 189, 225, 743, 786), W('KORTELe', 246, 379, 743, 790)]),
  L('-0, 23 A', 692, 822, 748, 789, [W('-0,', 692, 736, 750, 790), W('23', 748, 783, 749, 788), W('A', 805, 822, 748, 788)]),
  // flush trigger
  L('Fasuoti obuoli ai IKI UKIS', 15, 494, 781, 821, [W('Fasuoti', 15, 141, 781, 821), W('obuoli', 174, 286, 782, 823), W('ai', 292, 325, 783, 824), W('IKI', 348, 396, 784, 824), W('UKIS', 420, 494, 785, 825)]),
];

describe('IKI receipt-96 weighed-item recovery (garbled EUR + dropped weight words)', () => {
  const products = parseIkiColumnar(LINES, 0, LINES.length);

  test('POMIDORAI (garbled "ÉUR") recovers as kg, not a 0 / unit price', () => {
    const p = products.find((x) => /POMIDOR/i.test(x.name))!;
    expect(p).toBeDefined();
    expect(p.unit).toBe('kg');
    expect(p.price).toBeCloseTo(3.99, 1);     // 2,87 ÷ 0,720
    expect(p.price).not.toBe(0);
    expect(p.quantity).toBeCloseTo(0.72, 2);
  });

  test('RAUDONOSIOS (weight word-boxes dropped) recovers as kg, not 1 vnt', () => {
    const p = products.find((x) => /PAPRIK/i.test(x.name))!;
    expect(p).toBeDefined();
    expect(p.unit).toBe('kg');
    expect(p.price).toBeCloseTo(3.49, 1);     // €/kg read from the source line text
    expect(p.quantity).toBeCloseTo(0.47, 2);
  });
});
