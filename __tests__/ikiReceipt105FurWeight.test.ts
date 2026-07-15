import { parseIkiColumnar, type IkiLine, type IkiWord } from '../shared/parsers/ikiParser';

// Receipt-105 (IKI Šiauliai) word boxes, transcribed from the stored `wordsDump`.
// MLKit misread the "E" in "EUR" as "F" on TWO weighed lines (salmon + paprikos),
// e.g. "1,068 kg v 16 99 FUR/ kg" / "0, 470 kg X 3,49 FUR/ kg", while pomidorai +
// obuoliai kept "EUR" and parsed fine. T_EUR didn't tolerate the F, so those rows
// were never recognised as weight rows: the salmon's weight text leaked into its
// NAME and its price dropped to 0; paprikos lost its €/kg. NB: several lines kept
// ONLY the amount as word-boxes (the next product's NAME has no boxes — MLKit
// dropped them), which is the separate, unfixed "name = 0" / phantom-discount issue.
const W = (text: string, xL: number, xR: number, yT: number, yB: number): IkiWord =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB });
const L = (text: string, xL: number, xR: number, yT: number, yB: number, words: IkiWord[]): IkiLine =>
  ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB, words });

const LINES: IkiLine[] = [
  L('SKANĖJA RY 1SMl, 8', 77, 571, 230, 281, [W('SKANÉJA',77,215,230,275),W('RY',244,279,236,277),W('1SMl,',402,540,241,285),W('8',550,571,247,286)]),
  L('ATI 1INES ASISOS 8E GAL', 78, 567, 274, 326, [W('ATI',78,122,274,314),W('1INES',142,272,277,318),W('ASISOS',294,430,280,322),W('8E',452,488,285,323),W('GAL',511,567,286,326)]),
  L('3, 29 A', 789, 903, 256, 297, [W('3,',789,815,260,299),W('29',827,865,257,297),W('A',884,903,256,294)]),
  L('1,068 kg v 16 99 FUR/ kg', 112, 607, 316, 372, [W('1,068',112,202,316,359),W('kg',235,273,319,361),W('v',312,329,321,362),W('16',358,390,323,364),W('99',412,449,323,365),W('FUR/',470,549,325,368),W('kg',569,607,327,370)]),
  L('UOLAI DA S KORTSE', 104, 440, 350, 397, [W('UOLAI',104,203,350,394),W('DA',200,237,352,394),W('S',266,278,353,395),W('KORTSE',314,440,354,398)]),
  L('18, 15 A', 774, 903, 335, 380, [W('18,',774,813,337,380),W('15',831,863,336,379),W('A',885,903,336,379)]),
  L('-7, 48 A NAMINIS 2,5. PENAS', 76, 903, 371, 437, [W('-7,',771,813,373,414),W('48',826,864,372,414),W('A',885,903,371,412)]),
  L('NUQLAIDA SU KU E', 77, 449, 427, 471, [W('NUQLAIDA',77,234,427,474),W('SU',256,303,434,477),W('KU',319,356,436,478),W('E',431,449,440,481)]),
  L('1,49 A', 793, 904, 411, 459, [W('1,49',793,865,411,455),W('A',886,904,411,455)]),
  L('ZE MAITIJOS TEPAAS S.', 88, 583, 466, 522, [W('ZE',88,114,466,509),W('MAITIJOS',130,282,467,514),W('TEPAAS',299,433,472,517),W('S.',421,583,475,521)]),
  L('0, 30 A', 788, 904, 452, 497, [W('0,',788,815,452,494),W('30',828,865,452,494),W('A',886,904,452,494)]),
  L('LYDYTAS TEPAMAS SIS SU', 77, 546, 503, 558, [W('LYDYTAS',77,213,503,546),W('TEPAMAS',249,374,508,550),W('SIS',391,497,511,553),W('SU',511,546,514,555)]),
  L('1,99 A', 792, 904, 491, 533, [W('1,99',792,865,491,531),W('A',885,904,493,531)]),
  L('LIETUVISKI POMIDORAI', 82, 464, 543, 601, [W('LIETUVISKI',82,281,543,590),W('POMIDORAI',293,464,549,596)]),
  L('1,99 A', 792, 904, 531, 569, [W('1,99',792,865,531,566),W('A',885,904,531,566)]),
  L('0, 720 kg X 3,g0 EUR/ kg', 107, 587, 581, 636, [W('0,',107,133,581,622),W('720',145,200,583,623),W('kg',233,271,586,625),W('X',311,330,588,627),W('3,g0',353,429,590,631),W('EUR/',451,528,593,634),W('kg',549,587,596,635)]),
  L('NUOLAJ DA', 83, 230, 613, 659, [W('NUOLAJ',83,203,613,657),W('DA',191,230,619,659)]),
  L('2, 87 A', 793, 903, 604, 647, [W('2,',793,827,604,644),W('87',827,863,604,645),W('A',885,903,605,645)]),
  L('-0, 72 A RAUDONOSIOS PAPP1K0S', 75, 903, 645, 711, [W('-0,',769,813,645,680),W('72',827,863,646,680),W('A',885,903,647,681)]),
  L('0, 470 kg X 3,49 FUR/ kg', 112, 587, 693, 753, [W('0,',112,127,694,736),W('470',142,202,695,739),W('kg',231,270,698,742)]),
  L('NUOLAI DA ŠU KORTELL', 73, 447, 727, 793, [W('NUOLAI',73,187,727,778),W('DA',191,231,733,780),W('ŠU',265,306,736,783),W('KORTELL',310,447,738,789)]),
  L('1,64 A', 789, 903, 722, 765, [W('1,64',789,862,722,762),W('A',883,903,724,762)]),
  L('-0,23 A Fasuoti obuoli a1 IKI UKIS', 73, 902, 757, 836, [W('-0,23',767,863,757,799),W('A',883,902,760,800)]),
  L('2,090 kg X 1,85 EUR/ kg', 94, 586, 812, 876, [W('2,090',94,192,812,859),W('kg',218,271,817,861),W('X',309,329,821,864),W('1,85',352,428,822,867),W('EUR/',448,525,825,871),W('kg',547,586,830,873)]),
  L('KUPONAS', 101, 232, 843, 892, [W('KUPONAS',101,232,843,887)]),
  L('3. 87 A', 786, 903, 837, 883, [W('3.',786,813,837,879),W('87',825,862,838,880),W('A',882,903,841,882)]),
  L('xKUPONAS', 75, 232, 889, 938, [W('xKUPONAS',75,232,889,935)]),
  L('0,00 A', 785, 900, 876, 921, [W('0,00',785,862,876,919),W('A',882,900,878,919)]),
  L('MAISELIS PLASTIKINIS LENG', 73, 566, 926, 992, [W('MAISELIS',73,233,926,974),W('PLASTIKINIS',252,467,933,983),W('LENG',487,566,942,986)]),
  L('0, 00 A', 797, 901, 914, 960, [W('0,',797,824,914,958),W('00',824,862,914,958),W('A',882,901,914,958)]),
  L('IKI Taškais', 84, 291, 964, 1020, [W('IKI',84,145,964,1010),W('Taškais',154,291,967,1017)]),
  L('0,01 A', 799, 901, 952, 995, [W('0,01',799,869,952,992),W('A',881,901,954,993)]),
  L('-0,05 A', 765, 901, 989, 1033, [W('-0,05',765,861,989,1030),W('A',881,901,993,1031)]),
];

describe('IKI receipt-105 — FUR-misread weighed items parse weighed, not as name/price-0', () => {
  const products = parseIkiColumnar(LINES, 0, LINES.length);

  it('DUMP current parse', () => {
    // Visibility aid while iterating — not an assertion.
     
    console.log('PRODUCTS:\n' + products.map((p, i) =>
      `#${i + 1} name=${JSON.stringify(p.name)} price=${p.price} ppu=${p.pricePerUnit} unit=${p.unit} q=${p.quantity}`,
    ).join('\n'));
  });

  const salmon = products.find((p) => /ATI|ASISOS|\bGAL\b/i.test(p.name));

  it('salmon (FUR €/kg) is WEIGHED, not price 0', () => {
    expect(salmon).toBeTruthy();
    expect(salmon!.unit).toBe('kg');
    // €/kg recovered from "16 99 FUR" → 16,99 (not a 0 price).
    expect(salmon!.pricePerUnit).toBeGreaterThan(15);
    expect(salmon!.pricePerUnit).toBeLessThan(18);
  });

  it('salmon name does NOT absorb the weight/calc line', () => {
    expect(salmon!.name).not.toMatch(/kg|FUR|EUR/i);
  });

  // NB: this 33-line slice (no dispatcher context) merges the lower items differently
  // than the full receipt, so paprikos doesn't separate out HERE — its price recovery
  // is proven in isolation below (same FUR €/kg, comma intact, so an even easier case).
});

describe('IKI receipt-105 — paprikos FUR weight line recovers €/kg (isolated)', () => {
  // The paprikos weight line "0, 470 kg X 3,49 FUR/ kg" kept ONLY "0, 470 kg" as word
  // boxes (the "X 3,49 FUR/ kg" tail had none — it's only in the line text), so the
  // €/kg must be recovered from the SOURCE line. With F now in T_EUR, "3,49 FUR" reads
  // as 3,49. Here the name HAS boxes, proving the real-receipt "0" name is purely the
  // dropped-box problem, NOT the FUR issue.
  const LINES2: IkiLine[] = [
    L('RAUDONOSIOS PAPRIKOS', 22, 405, 583, 628, [W('RAUDONOSIOS',22,232,586,626),W('PAPRIKOS',254,404,583,621)]),
    L('0, 470 kg X 3,49 FUR/ kg', 112, 587, 693, 753, [W('0,',112,127,694,736),W('470',142,202,695,739),W('kg',231,270,698,742)]),
    L('1,64 A', 789, 903, 722, 765, [W('1,64',789,862,722,762),W('A',883,903,724,762)]),
  ];
  const products = parseIkiColumnar(LINES2, 0, LINES2.length);
  const paprika = products.find((p) => /PAPRIK|RAUDONOS/i.test(p.name));

  it('parses ONE weighed product with €/kg ≈ 3,49 (not a unit price = the 1,64 line total)', () => {
    expect(paprika).toBeTruthy();
    expect(paprika!.unit).toBe('kg');
    expect(paprika!.pricePerUnit).toBeGreaterThan(3.2);
    expect(paprika!.pricePerUnit).toBeLessThan(3.7);
    expect(paprika!.quantity).toBeCloseTo(0.47, 2);
  });
});
