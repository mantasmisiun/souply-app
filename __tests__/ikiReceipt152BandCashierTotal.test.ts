import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';
import { detectCardMaskBands } from '../shared/parsers/cardMaskDetection';

// Receipt 152 (re-scan) surfaced three OCR-garble misses:
//   1. The last product's name "RAUDONOSIOS PAPRIKOS" fused onto product 6 (KOPUSTAI)'s discount
//      row ("-0, CO A RAUDONOSIOS PAPRIKOS"). Because the discount AMOUNT was garbled ("-0,CO"),
//      KOPUSTAI got no parsed promo, so the two-box seam (which gated on promoPrice) was skipped and
//      product 7's band rode up over KOPUSTAI's "NUOLAIDA SI KORTELE" label ("stealing" it). The
//      two-box now also engages when A simply OWNS a NUOLAIDA discount row -> the bands tile cleanly.
//   2. The cashier line OCR-split "Kasininkas" into "Kasini nkas" (a space), so CASHIER_LABEL missed
//      it and the cashier name went UNMASKED.
//   3. The to-pay total "Moketi 7,10" OCR'd as "7 10 Moket i" - amount BEFORE the keyword, comma
//      dropped to a space - which the existing (amount-after, comma-only) paths didn't catch.
const L = (t: string, x: [number, number], y: [number, number], ws: any[][]): IkiLine => ({
    text: t, xLeft: x[0], xRight: x[1], yTop: y[0], yBottom: y[1],
    words: ws.map(([wt, a, b, c, d]) => ({ text: wt, xLeft: a, xRight: b, yTop: c, yBottom: d })),
});

const lines: IkiLine[] = [
    L('IKI Lietuva, UAB', [372, 728], [216, 281], [['IKI', 372, 430, 216, 262], ['Lietuva,', 456, 626, 221, 272], ['UAB', 661, 727, 232, 278]]),
    L('Vilniaus g. 220-1, Siaul iai', [244, 845], [256, 340], [['Vilniaus', 244, 422, 256, 310], ['g.', 447, 480, 266, 313], ['220-1,', 515, 638, 269, 320], ['Siaul', 673, 777, 277, 326], ['iai', 790, 844, 283, 330]]),
    L('PVM moketojo kodas LT101937219', [210, 885], [300, 373], [['PVM', 210, 277, 301, 345], ['moketojo', 299, 480, 304, 355], ['kodas', 504, 616, 314, 361], ['LT101937219', 639, 884, 320, 372]]),
    L('TRUMPAVAISIAI AGURKAI', [78, 546], [383, 450], [['TRUMPAVAISIAI', 78, 363, 383, 436], ['AGURKAI', 390, 546, 391, 440]]),
    L('0.245. k9 2,99 EUR/ kg', [123, 663], [426, 497], [['0.245.', 123, 232, 426, 480], ['k9', 263, 307, 431, 482], ['2,99', 393, 482, 436, 488], ['EUR/', 507, 594, 439, 492], ['kg', 620, 663, 443, 494]]),
    L('BILLA BIO LINŲ SEMENŲ ALI', [74, 641], [467, 524], [['BĪLLA', 74, 202, 467, 521], ['BIO', 209, 276, 472, 522], ['LÌNŲ', 308, 401, 476, 528], ['SEMENŲ', 416, 557, 480, 533], ['ALI', 584, 641, 486, 536]]),
    L('0, 73 A', [888, 1019], [464, 515], [['0,', 888, 918, 464, 511], ['73', 936, 976, 464, 511], ['A', 998, 1019, 464, 511]]),
    L('NUOLAIDA SU KORTELE', [74, 513], [505, 566], [['NUOLAIDA', 74, 253, 505, 561], ['SU', 286, 341, 514, 563], ['KÒRTELE', 344, 513, 517, 570]]),
    L('3, 49 A', [889, 1019], [503, 548], [['3,', 889, 918, 504, 544], ['49', 933, 975, 504, 545], ['A', 999, 1019, 505, 545]]),
    L('-0, 70 A SALDZ IOS IOS BULVĖS', [73, 1019], [546, 621], [['-0,', 869, 920, 546, 586], ['70', 934, 976, 546, 587], ['A', 999, 1019, 547, 587]]),
    L('0, 475 kg X 2, 49 EUR/ kg', [91, 667], [597, 662], [['0,', 91, 134, 597, 646], ['475', 140, 208, 599, 649], ['kg', 254, 301, 604, 654], ['X', 343, 370, 609, 656], ['2,', 394, 427, 611, 659], ['49', 438, 484, 613, 661], ['EUR/', 507, 596, 616, 667], ['kg', 621, 666, 621, 670]]),
    L('PLAU\'TLS MORKOS', [68, 393], [643, 705], [['PLAU\'TLS', 68, 231, 643, 693], ['MÖRKOS', 256, 393, 649, 698]]),
    L('1,18 A', [906, 1021], [632, 683], [['1,18', 906, 991, 632, 678], ['A', 1001, 1021, 632, 678]]),
    L('0,375 kg X0,89 EUR/ kg EUR/ Aa', [110, 666], [687, 764], [['0,375', 110, 216, 687, 744], ['kg', 238, 301, 693, 748], ['X0,89', 332, 485, 696, 755], ['EUR/', 508, 597, 704, 759], ['kg', 622, 665, 709, 763]]),
    L('BUROKĖLIAI CLEVER', [84, 463], [730, 802], [['BUROKĖLIAÍ', 84, 318, 730, 792], ['CLEVER', 341, 463, 738, 796]]),
    L('0,33 A', [893, 1022], [722, 764], [['0,33', 893, 978, 722, 764], ['A', 1002, 1022, 722, 764]]),
    L('0,410 kg X0, 55 EUR/ kg', [90, 661], [779, 845], [['0,410', 90, 205, 779, 828], ['kg', 255, 300, 784, 829], ['X0,', 351, 428, 788, 834], ['55', 451, 491, 790, 835], ['EUR/', 510, 598, 792, 839], ['kg', 622, 661, 795, 840]]),
    L('SVIEZI KOPUSTAI', [84, 414], [817, 884], [['SVÍEZI', 84, 223, 818, 874], ['KOPUSTAI', 233, 414, 823, 881]]),
    L('0,23 A', [894, 1022], [807, 852], [['0,23', 894, 978, 808, 850], ['A', 1002, 1022, 807, 848]]),
    L('1,250 kg X 1,39 EUR/ kg', [93, 664], [868, 930], [['1,250', 93, 209, 868, 914], ['kg', 255, 303, 873, 915], ['X', 348, 373, 876, 918], ['1,39', 398, 488, 877, 921], ['EUR/', 510, 598, 880, 926], ['kg', 625, 664, 884, 927]]),
    L('NUOLAIDA ŠI KORTELE', [66, 506], [905, 978], [['NUOLAIDA', 66, 261, 905, 961], ['ŠI', 297, 340, 915, 963], ['KORTELE', 348, 506, 916, 969]]),
    L('1, 74 A', [896, 1025], [893, 938], [['1,', 896, 925, 894, 935], ['74', 939, 981, 894, 935], ['A', 1004, 1025, 895, 936]]),
    L('-0, CO A RAUDONOSIOS PAPRIKOS', [67, 1026], [929, 1019], [['-0,', 874, 926, 929, 979], ['CO', 938, 982, 932, 980], ['A', 1003, 1026, 934, 982]]),
    L('0, 245 kg X 3,49 EUR/ kg', [106, 665], [996, 1054], [['0,', 106, 136, 997, 1045], ['245', 153, 209, 997, 1047], ['kg', 257, 312, 999, 1048], ['X', 348, 368, 1002, 1049], ['3,49', 394, 495, 1002, 1052], ['EUR/', 509, 598, 1004, 1053], ['kg', 624, 665, 1006, 1054]]),
    L('NUOLAIDA SU KORTELE', [65, 506], [1040, 1097], [['NUOLAIDA', 65, 250, 1040, 1088], ['SU', 295, 335, 1044, 1089], ['KORTELE', 349, 506, 1045, 1094]]),
    L('0, 86 A', [897, 1025], [1023, 1071], [['0,', 897, 927, 1023, 1069], ['86', 942, 982, 1023, 1069], ['A', 1006, 1025, 1023, 1069]]),
    L('-0, 35 A', [875, 1027], [1061, 1110], [['-0,', 875, 927, 1061, 1107], ['35', 941, 983, 1063, 1108], ['A', 1007, 1027, 1064, 1109]]),
    L('IKI KORIELĖS NR. 999000111222', [106, 914], [1261, 1324], [['IKI', 106, 168, 1261, 1307], ['KORIELÉS', 177, 371, 1262, 1311], ['NR.', 395, 450, 1267, 1312], ['999000111222', 490, 914, 1268, 1321]]),
    L('7 10 Mokėt i', [60, 1030], [2564, 2630], [['7', 883, 897, 2570, 2614], ['10', 951, 1030, 2563, 2611]]),
    L('PV sua Mokestis Suiua su PVM', [60, 1030], [2615, 2678], [['PV', 869, 904, 2615, 2658], ['sua', 945, 1030, 2615, 2658]]),
    L('1,23 5,97 7, 10 A 21,00 %', [56, 1028], [2658, 2722], [['1,23', 951, 1028, 2658, 2700]]),
    L(':0, 00 Gryniejı', [72, 1033], [2699, 2783], [[':0,', 932, 990, 2699, 2750], ['00', 992, 1033, 2699, 2750]]),
    L('2,90', [948, 1036], [2745, 2794], [['2,90', 948, 1036, 2745, 2794]]),
    L('Grąz?', [53, 169], [2784, 2828], [['Grąz?', 53, 169, 2784, 2825]]),
    L('Kvito Nr. 42/610/11459 Kasa 0022', [55, 823], [2853, 2929], [['Kvito', 55, 174, 2872, 2926], ['Nr.', 193, 251, 2870, 2922], ['42/610/11459', 277, 587, 2860, 2920], ['Kasa', 613, 705, 2856, 2910], ['0022', 730, 823, 2853, 2906]]),
    L('Kasini nkas (-e): SCO User2', [49, 658], [2912, 2961], [['Kasini', 49, 184, 2921, 2960], ['nkas', 199, 286, 2919, 2958], ['(-e):', 313, 413, 2916, 2955], ['SCO', 447, 515, 2915, 2953], ['User2', 543, 658, 2912, 2951]]),
    L('A. P. S/N SM22 J577 2026-06-18 11:47:37', [51, 1022], [3095, 3172], [['A.', 51, 89, 3120, 3160], ['P.', 101, 133, 3116, 3157], ['S/N', 170, 242, 3108, 3153], ['SM22', 268, 357, 3102, 3147], ['J577', 386, 476, 3095, 3139]]),
    L('CR-000014698 --- Informacija kvit0 patikr inimui VMI ---', [57, 1020], [3143, 3240], [['CR-000014698', 69, 339, 3143, 3198]]),
];

describe('IKI receipt-152 - fused-name band tiling, split-cashier mask, reversed Moketi total', () => {
    const res: any = parseIkiReceipt(lines);

    test('7 products incl. the recovered "RAUDONOSIOS PAPRIKOS"', () => {
        expect(res.products).toHaveLength(7);
        expect(res.products[6].name).toMatch(/RAUDONOSIOS PAPRIKOS/);
    });

    test('product 7 no longer steals product 6 NUOLAIDA SI KORTELE label (band starts below its top y905)', () => {
        const p7 = res.products[6].region;
        expect(Math.min(p7.yLeftTop, p7.yRightTop)).toBeGreaterThan(905);
    });

    test('product 6 and product 7 bands tile (no overlap): P7 top ~= P6 bottom on both edges', () => {
        const p6 = res.products[5].region, p7 = res.products[6].region;
        expect(Math.abs(p7.yLeftTop - p6.yLeftBottom)).toBeLessThanOrEqual(1);
        expect(Math.abs(p7.yRightTop - p6.yRightBottom)).toBeLessThanOrEqual(1);
    });

    test('the to-pay total is recovered from "7 10 Moket i" (amount before keyword, space decimal)', () => {
        expect(res.footer.total).toBeCloseTo(7.1, 2);
        expect((res.footer.lineRegions || []).some((r: any) => r.kind === 'total')).toBe(true);
    });

    test('the OCR-split cashier "Kasini nkas" is detected and the name is masked', () => {
        const cashier = detectCardMaskBands(lines as any).filter((b: any) => b.kind === 'cashier');
        expect(cashier.length).toBe(1);
        expect(cashier[0].xRight).toBeGreaterThan(600);
    });
});
