import { parseIkiColumnar, type IkiLine, type IkiWord } from '../shared/parsers/ikiParser';

// Receipt-99 (IKI Šiauliai, re-scan) word boxes for the POMIDORAI → RAUDONOSIOS →
// FASUOTI section. On THIS scan MLKit fused each product's discount AMOUNT onto the
// TRAILING end of the NEXT product's NAME line ("Fasuoti … -0,23 A") and gave the
// amount NO word box — it survives only in the source line TEXT. The word-driven
// column engine therefore never saw the discount, so POMIDORAI and RAUDONOSIOS came
// back with promoPrice=null (their −0,72 / −0,23 dropped). The fix recovers a trailing
// text-only discount from the name row's source line and attributes it to the OPEN
// (previous) product. (An earlier scan, receipt-97, put the same discounts on their own
// rows and parsed promoPrice 2.99 / 3.00 — this restores parity.)
const W = (text: string, xL: number, xR: number, yT: number, yB: number): IkiWord =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB });
const L = (text: string, xL: number, xR: number, yT: number, yB: number, words: IkiWord[]): IkiLine =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB, words });

const LINES: IkiLine[] = [
  L('LIETUVISKI POMIDORAI', 71, 442, 563, 622, [W('LIETUVISKI', 71, 267, 563, 614), W('POMIDORAI', 273, 442, 573, 622)]),
  L('0, 720 kg X 3.ga EUR/ kg', 81, 562, 600, 664, [
    W('0,', 81, 109, 601, 641), W('720', 120, 177, 602, 645), W('kg', 214, 253, 607, 648),
    W('X', 311, 323, 612, 651), W('3.ga', 331, 407, 613, 656), W('EUR/', 427, 503, 618, 661), W('kg', 524, 561, 623, 664),
  ]),
  L('NUOLAIDA', 62, 213, 638, 688, [W('NUOLAIDA', 62, 213, 638, 683)]),
  L('2, 87 A', 769, 872, 637, 680, [W('2,', 769, 794, 637, 677), W('87', 796, 832, 638, 678), W('A', 853, 872, 640, 679)]),
  L('RAUDONOSIOS PAPR1KOS -0,72 A', 59, 873, 671, 732, [W('RAUDONOSIOS', 59, 273, 671, 716), W('PAPR1KOS', 289, 442, 680, 723)]),
  L('0, 470 kg X 3,49 EUR/ kg', 100, 562, 708, 780, [
    W('0,', 100, 115, 708, 750), W('470', 128, 188, 710, 754), W('kg', 212, 253, 716, 758),
    W('X', 289, 309, 721, 762), W('3,49', 330, 409, 723, 769), W('EUR/', 425, 502, 729, 774), W('kg', 522, 562, 736, 779),
  ]),
  L('NUOLAI DA SU KORTELL', 59, 428, 744, 818, [W('NUOLAI', 59, 173, 744, 794), W('DA', 174, 214, 752, 797), W('SU', 233, 272, 755, 801), W('KORTELL', 290, 428, 759, 811)]),
  L('1, 64 A', 759, 872, 753, 799, [W('1,', 759, 784, 753, 792), W('64', 796, 833, 754, 793), W('A', 853, 872, 756, 794)]),
  L('Fasuoti obuoli ai IKI UKIS -0, 23 A', 59, 873, 784, 855, [
    W('Fasuoti', 59, 188, 784, 834), W('obuoli', 227, 341, 794, 842), W('ai', 344, 371, 801, 844), W('IKI', 396, 457, 803, 849), W('ÜKIS', 466, 542, 808, 853),
  ]),
  L('2, 090 kg X 1,85 EUR/ kg', 88, 561, 822, 895, [
    W('2,', 88, 115, 822, 865), W('090', 126, 185, 825, 869), W('kg', 214, 253, 830, 873),
    W('X', 288, 311, 835, 877), W('1,85', 332, 406, 838, 884), W('EUR/', 425, 502, 844, 890), W('kg', 522, 561, 851, 894),
  ]),
  L('*KUPONAS', 62, 205, 862, 910, [W('*KUPONAS', 62, 205, 862, 901)]),
  L('3, 87 A', 757, 872, 866, 910, [W('3,', 757, 784, 866, 905), W('87', 796, 833, 868, 907), W('A', 852, 872, 871, 910)]),
];

describe('IKI receipt-99 — trailing text-only discount fused onto the NEXT name', () => {
  const products = parseIkiColumnar(LINES, 0, LINES.length);
  const find = (re: RegExp) => products.find((p) => re.test(p.name));

  test('POMIDORAI gets its −0,72 discount (fused onto RAUDONOSIOS\'s name line)', () => {
    const pom = find(/POMIDORAI/i)!;
    expect(pom).toBeDefined();
    expect(pom.unit).toBe('kg');
    expect(pom.price).toBeCloseTo(3.99, 1);          // €/kg recovered from total ÷ qty
    expect(pom.promoPrice).toBeCloseTo(2.99, 2);     // (2,87 − 0,72) ÷ 0,719
  });

  test('RAUDONOSIOS gets its −0,23 discount (fused onto FASUOTI\'s name line)', () => {
    const rau = find(/RAUDONOS|PAPR/i)!;
    expect(rau).toBeDefined();
    expect(rau.unit).toBe('kg');
    expect(rau.price).toBeCloseTo(3.49, 2);
    expect(rau.promoPrice).toBeCloseTo(3.0, 2);      // (1,64 − 0,23) ÷ 0,470
  });

  test('FASUOTI (no discount) keeps promoPrice null — the −0,23 went to the product above', () => {
    const fas = find(/Fasuoti|obuoli/i)!;
    expect(fas).toBeDefined();
    expect(fas.promoPrice == null).toBe(true);
    expect(fas.price).toBeCloseTo(1.85, 2);
  });
});
