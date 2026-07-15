import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 154 — a heavily-compressed receipt tail where overlapping OCR boxes merge several print-
// rows. The fixes: (A) a discount row that ALSO carries its product's positive total ("… -0,50 1,99
// A A") keeps the total (SUNOKE was vanishing); (B) a "N vnt. X P EUR/Vr" unit-calc is a CALC not a
// NAME, carries its total + unit count; (C) the per-unit price = total/count (2,98/2 = 1,49); and a
// SANITY GATE: a discount can't exceed the line total -> no negative "promo" (cukinijos had 0,01
// price absorbing a -1,80 discount = -1,79 promo, impossible). The 0,01 bag is dropped as a penny.
const L = (t: string, x: [number, number], y: [number, number], ws: any[][]): IkiLine => ({
    text: t, xLeft: x[0], xRight: x[1], yTop: y[0], yBottom: y[1],
    words: ws.map(([wt, a, b, c, d]) => ({ text: wt, xLeft: a, xRight: b, yTop: c, yBottom: d })),
});

const lines: IkiLine[] = [
    L('LAVAZZA QUALITA ORO MALTA', [31, 505], [377, 426], [['LAVAZZA', 31, 164, 377, 417], ['QUALITA', 184, 317, 381, 422], ['ORO', 346, 406, 385, 423], ['MALTA', 413, 505, 387, 426]]),
    L('NUOLAIDA SU KORTELE', [30, 393], [415, 467], [['NUOLAIDA', 30, 183, 415, 460], ['SU', 196, 245, 420, 461], ['KORTELE', 261, 393, 421, 466]]),
    L('9,99 A', [719, 832], [393, 436], [['9,99', 719, 793, 393, 434], ['A', 814, 832, 395, 434]]),
    L('-4, 50 A DVARO GRIETINĖ 30% RIEBUM', [31, 831], [428, 492], [['-4,', 702, 746, 429, 471], ['50', 758, 793, 429, 470], ['A', 814, 831, 429, 470]]),
    L('NUOLAIDA SU KORTELE', [41, 405], [489, 543], [['NUOLAIDA', 41, 194, 489, 536], ['SU', 213, 251, 492, 536], ['KORTELE', 270, 405, 493, 540]]),
    L('2,79 A', [722, 831], [464, 509], [['2,79', 722, 793, 464, 508], ['A', 814, 831, 464, 506]]),
    L('-0, 84 A', [713, 833], [497, 540], [['-0,', 713, 759, 497, 538], ['84', 759, 795, 498, 539], ['A', 814, 833, 500, 540]]),
    L('MAGIJA GLAISTYTAS VANILIN', [32, 508], [529, 575], [['MAGIJA', 32, 147, 529, 566], ['GLAISTYTAS', 168, 355, 531, 569], ['VANILIN', 379, 508, 535, 573]]),
    L('NUOLAIDA SU KORTELE', [33, 396], [563, 614], [['NUOLAIDA', 33, 186, 563, 608], ['SU', 206, 243, 567, 609], ['KORTELE', 252, 396, 567, 612]]),
    L('0, 65 A', [743, 834], [536, 580], [['0,', 743, 757, 536, 578], ['65', 760, 796, 536, 579], ['A', 815, 834, 537, 579]]),
    L('-0, 26 A MAGIJA GLAISTYTAS VANILIN', [34, 836], [574, 644], [['-0,', 704, 749, 574, 617], ['26', 762, 798, 574, 617], ['A', 818, 836, 574, 617]]),
    L('NUOLAI DA SU KORTELE', [35, 396], [636, 682], [['NUOLAI', 35, 146, 636, 682], ['DA', 151, 203, 638, 683], ['SU', 208, 243, 638, 683], ['KORTELE', 265, 396, 639, 684]]),
    L('0, 65 A', [724, 835], [610, 654], [['0,', 724, 749, 610, 654], ['65', 762, 797, 610, 653], ['A', 818, 835, 610, 653]]),
    L('-0,26 A KETO LENGVAI DUONA SU SEK', [36, 837], [646, 722], [['-0,26', 706, 799, 646, 691], ['A', 819, 837, 646, 691]]),
    L('KETO LENGVAI DUONA SU SEK', [37, 513], [712, 757], [['KETO', 37, 117, 712, 757], ['LENGVAI', 126, 270, 712, 757], ['DUONA', 285, 378, 712, 757], ['SU', 401, 436, 712, 757], ['SEK', 458, 513, 712, 757]]),
    L('2,59 A', [725, 838], [684, 727], [['2,59', 725, 799, 684, 727], ['A', 819, 838, 684, 727]]),
    L('DŽIOVINTOS SLYVOS', [37, 358], [748, 789], [['DŽIOVINTOS', 37, 225, 748, 789], ['SLYVOS', 247, 358, 748, 789]]),
    L('2, 59 A', [726, 838], [722, 760], [['2,', 726, 752, 722, 760], ['59', 764, 800, 722, 760], ['A', 821, 838, 722, 760]]),
    L('0,355 kg X 8,99 EUR/ kg', [73, 531], [783, 826], [['0,355', 73, 157, 783, 826], ['kg', 177, 230, 783, 826], ['X', 241, 282, 783, 826], ['8,99', 292, 379, 783, 826], ['EUR/', 399, 474, 783, 826], ['kg', 496, 531, 783, 826]]),
    L('NUOLAIDA ŠU KORTĖLE', [37, 391], [819, 859], [['NUOLAIDA', 37, 194, 819, 859], ['ŠU', 202, 246, 819, 859], ['KORTĒLE', 265, 391, 819, 859]]),
    L('3, 19 A', [727, 839], [798, 838], [['3,', 727, 753, 798, 838], ['19', 767, 801, 798, 838], ['A', 822, 839, 798, 838]]),
    L('-0, 80 A SUNOKE AVOKADAI', [34, 840], [830, 897], [['-0,', 708, 754, 830, 870], ['80', 767, 802, 831, 871], ['A', 823, 840, 832, 871]]),
    L('NUOLAIDA SU KORTELE', [41, 393], [883, 948], [['NUOLAIDA', 41, 195, 883, 929], ['SU', 208, 248, 888, 930], ['KORTELE', 260, 393, 889, 934]]),
    L('1,99 A', [729, 843], [867, 911], [['1,99', 729, 803, 867, 909], ['A', 822, 843, 871, 911]]),
    L('-0,50 A Zaliosios cukinijos', [32, 843], [902, 978], [['-0,50', 711, 804, 902, 944], ['A', 824, 843, 907, 945]]),
    L('2 vnt. X 1,49 EUR/ Vr', [63, 489], [955, 1008], [['2', 63, 75, 956, 995], ['vnt.', 108, 179, 957, 999], ['X', 209, 245, 960, 1000], ['1,49', 278, 349, 962, 1004], ['EUR/', 373, 439, 965, 1006], ['Vr', 460, 489, 968, 1008]]),
    L('NUOLAIDA SU KORTELE', [29, 405], [983, 1040], [['NUOLAIDÀ', 29, 187, 983, 1028], ['SU', 213, 258, 989, 1031], ['KORTELE', 264, 405, 990, 1035]]),
    L('2,98 A', [732, 845], [978, 1023], [['2,98', 732, 807, 978, 1020], ['A', 826, 845, 981, 1021]]),
    L('-1, 80 A MAISELIS PLASTIKINIS LENG', [28, 842], [1012, 1078], [['-1,', 723, 771, 1013, 1055], ['80', 769, 805, 1014, 1056], ['A', 824, 842, 1015, 1057]]),
    L('0,01 A', [729, 840], [1054, 1093], [['0,01', 729, 798, 1054, 1091], ['A', 822, 840, 1054, 1091]]),
    L('IKI KORTELĖS NR. 999000111222', [58, 736], [1220, 1277], [['IKI', 58, 108, 1220, 1259], ['KORTELĖS', 132, 285, 1222, 1264], ['NR.', 305, 351, 1227, 1266], ['999000111222', 382, 736, 1230, 1277]]),
    L('Moketi', [27, 134], [2911, 2946], [['Mokèti', 27, 134, 2911, 2946]]),
    L('18, 47 Apvalinimo suma -0, 02', [27, 831], [2944, 3009], [['18,', 738, 782, 2944, 2976], ['47', 792, 831, 2944, 2976]]),
    L('Moketi suapval inus 18, 45', [28, 825], [2979, 3039], [['Mokèti', 28, 137, 2979, 3016], ['suapval', 162, 289, 2984, 3020], ['inus', 300, 370, 2988, 3023]]),
    L('Mokestis Suma su PVM PVM suma', [41, 824], [3011, 3061], [['Mokestịs', 41, 189, 3011, 3045], ['Suma', 220, 295, 3016, 3047], ['su', 315, 353, 3018, 3049], ['PVM', 372, 427, 3019, 3050]]),
    L('A 21, 00 % J8, 47 3, 21', [31, 819], [3042, 3085], [['A', 31, 51, 3042, 3077], ['21,', 81, 123, 3042, 3077], ['00', 141, 172, 3042, 3077], ['%', 174, 202, 3042, 3077]]),
    L('Grynieji EUR 20, 00', [32, 824], [3075, 3126], [['Grynieji', 32, 177, 3075, 3115], ['EUR', 201, 258, 3075, 3115]]),
    L('Graža 1,55', [33, 824], [3113, 3163], [['Graža', 33, 125, 3113, 3150]]),
    L('Kvito Nr. 71/612/114973 Kasa 0022', [34, 656], [3189, 3232], [['Kvito', 34, 126, 3189, 3232], ['Nr.', 147, 193, 3189, 3232], ['71/612/114973', 224, 467, 3189, 3232], ['Kasa', 487, 560, 3189, 3232], ['0022', 581, 656, 3189, 3232]]),
    L('Kasininkas [•••]', [33, 825], [3221, 3272], [['Kasininkas', 33, 220, 3225, 3270]]),
    L('CR-000014698 2026-06-20 12:20:35', [33, 825], [3441, 3485], [['CR-000014698', 33, 261, 3441, 3482]]),
];

describe('IKI receipt-154 — merged-row total recovery, unit-calc, negative-promo gate', () => {
    const res: any = parseIkiReceipt(lines);
    const byName = (re: RegExp) => res.products.find((p: any) => re.test(p.name));

    test('SUNOKE AVOKADAI survives the merged discount row with its real 1,99 price', () => {
        const p = byName(/SUNOKE/);
        expect(p).toBeTruthy();
        expect(p.price).toBeCloseTo(1.99, 2);
        expect(p.promoPrice).toBeCloseTo(1.49, 2);
    });

    test('Zaliosios cukinijos = 2 vnt x 1,49 (not the 0,01 bag), promo 0,59', () => {
        const p = byName(/cukinijos/);
        expect(p).toBeTruthy();
        expect(p.quantity).toBe(2);
        expect(p.price).toBeCloseTo(1.49, 2);
        expect(p.promoPrice).toBeCloseTo(0.59, 2);
    });

    test('the unit-calc "2 vnt. X 1,49 EUR/ Vr" is NOT a product name', () => {
        expect(res.products.some((p: any) => /vnt.s*X/i.test(p.name))).toBe(false);
    });

    test('no product has a NEGATIVE promo price (discount cannot exceed the total)', () => {
        expect(res.products.every((p: any) => p.promoPrice == null || p.promoPrice >= 0)).toBe(true);
    });

    test('the 0,01 plastic-bag penny is not a phantom product', () => {
        expect(res.products.some((p: any) => p.price > 0 && p.price <= 0.02 && (p.name === '?' || p.name === ''))).toBe(false);
    });
});
