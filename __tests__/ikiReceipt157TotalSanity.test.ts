import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 157 — a garbled payment block: the real to-pay (10,10/10,11) is unreadable and the only
// thing the Mokėti handler could latch onto was "Mokėti suapvalinus -0,01" (a rounding DELTA), which
// it read as a 0,01 total. Two guards: (1) the Mokėti handler now takes the first POSITIVE amount
// (a -0,01 delta is skipped), and (2) a SANITY backstop — when the parsed total is null/implausibly
// small versus the items' summed paid amounts, fall back to that sum (= 10,11 here).
const L = (t: string, x: [number, number], y: [number, number], ws: any[][]): IkiLine => ({
    text: t, xLeft: x[0], xRight: x[1], yTop: y[0], yBottom: y[1],
    words: ws.map(([wt, a, b, c, d]) => ({ text: wt, xLeft: a, xRight: b, yTop: c, yBottom: d })),
});

const lines: IkiLine[] = [
    L('PUM mokėėtojo kodas LI101937219', [188, 818], [331, 387], [['PUM', 188, 248, 340, 385], ['kodas', 460, 562, 335, 380], ['LI101937219', 578, 818, 331, 379]]),
    L('ROKISKI0 NAMINE GRIETINE', [61, 560], [413, 467], [['ROKISKI0', 61, 228, 413, 458], ['NAMINE', 248, 372, 417, 461], ['GRIETINẾ', 396, 560, 421, 466]]),
    L('2,99 A', [823, 952], [415, 466], [['2,99', 823, 908, 417, 466], ['A', 929, 952, 415, 461]]),
    L('NUOLAIDA SU KORTELE -0, 60 A', [59, 950], [455, 507], [['NUOLAIDA', 59, 226, 455, 501], ['SU', 250, 290, 461, 503], ['KORTELE', 312, 455, 462, 507]]),
    L('KETO LENGVAI DUONA SU SEK', [59, 576], [494, 540], [['KETO', 59, 142, 494, 540], ['LENGVAI', 164, 316, 497, 544], ['DUONA', 338, 441, 500, 546], ['SU', 466, 505, 503, 548], ['SEK', 523, 576, 504, 549]]),
    L('KETO LENGVAI DUONA SU SĖK', [59, 581], [531, 576], [['KETO', 59, 142, 531, 576], ['LENGVAÍ', 170, 324, 535, 582], ['DUONA', 332, 438, 541, 586], ['SU', 459, 501, 545, 588], ['SÉK', 523, 581, 547, 591]]),
    L('2, 59 A', [824, 951], [502, 552], [['2,', 824, 853, 502, 549], ['59', 868, 908, 502, 549], ['A', 931, 951, 502, 549]]),
    L('SUNOKE AVOKADA', [57, 354], [567, 619], [['SUNOKE', 57, 203, 567, 616], ['AVOKADA', 206, 354, 576, 625]]),
    L('2, 59 A', [823, 948], [543, 594], [['2,', 823, 852, 545, 592], ['59', 866, 907, 544, 591], ['A', 929, 948, 543, 590]]),
    L('NUOLAIDA SU KORTELE', [58, 458], [614, 672], [['NUOLAÍDA', 58, 227, 614, 668], ['SU', 248, 290, 624, 671], ['KORTELE', 310, 458, 626, 680]]),
    L('1,99 A', [827, 949], [587, 635], [['1,99', 827, 905, 588, 631], ['A', 929, 949, 587, 628]]),
    L('-0, 40 A TRUMPAVAISIAI AGURKAI', [59, 949], [627, 734], [['-0,', 801, 850, 628, 676], ['40', 868, 922, 628, 675], ['A', 929, 949, 627, 673]]),
    L('0,485 kg X 2,99 EUR/ kg', [94, 606], [698, 775], [['0,485', 94, 186, 698, 750], ['kg', 232, 274, 704, 754], ['X', 308, 332, 709, 757], ['2,99', 361, 439, 711, 762], ['EUR/', 459, 549, 715, 767], ['kg', 562, 605, 721, 770]]),
    L('NUOLAI DA SU KORTELE', [66, 459], [734, 790], [['NUOLAI', 66, 193, 734, 786], ['DA', 184, 228, 741, 788], ['SU', 249, 292, 745, 791], ['KORTELE', 310, 458, 749, 801]]),
    L('1,45 A', [825, 948], [716, 764], [['1,45', 825, 905, 717, 759], ['A', 927, 948, 716, 756]]),
    L('-0, 50 A', [801, 946], [752, 799], [['-0,', 801, 849, 755, 800], ['50', 863, 905, 753, 798], ['A', 926, 946, 753, 796]]),
    L('IKI KORTELĖS NR. 999000111222', [91, 837], [945, 1014], [['IKI', 91, 151, 946, 991], ['KORTELÉS', 163, 333, 947, 997], ['NR.', 351, 405, 955, 1000], ['999000111222', 438, 837, 958, 1015]]),
    L('9370', [46, 128], [2735, 2776], [['9370', 46, 128, 2735, 2773]]),
    L('0429/0024/804', [613, 894], [2766, 2834], [['0429/0024/804', 613, 894, 2766, 2824]]),
    L('Mokėti', [46, 166], [2811, 2860], [['Mokėti', 46, 166, 2811, 2853]]),
    L('Apvalinimo suma 10, 11', [47, 929], [2853, 2915], [['Apvalinimo', 47, 257, 2853, 2896], ['suma', 279, 360, 2863, 2899]]),
    L('Moket i suapvalinus -0, 01', [61, 928], [2888, 2951], [['Moket', 61, 147, 2888, 2929], ['i', 162, 174, 2892, 2929], ['suapvalinus', 194, 421, 2893, 2939]]),
    L('Mokest is Suma su PVM 10, 1o', [63, 930], [2925, 2987], [['Mokest', 63, 172, 2925, 2967], ['is', 189, 223, 2931, 2968], ['Suma', 257, 340, 2934, 2974], ['su', 361, 402, 2939, 2977], ['PVM', 423, 486, 2942, 2981]]),
    L('Be PVM A 21,00 % PVM 10, 11', [48, 824], [2959, 3015], [['Be', 571, 612, 2959, 2999], ['PVM', 635, 696, 2959, 2999]]),
    L('Suma Gryniej i EUR 8, 36 1, 75', [52, 931], [2991, 3064], [['Suma', 846, 929, 2991, 3021]]),
    L('Grąža 20, 00', [52, 929], [3038, 3100], [['Grąža', 52, 152, 3038, 3077]]),
    L('9, 90 Kvito Nr. 24/618/126231 Kasa\\0024', [49, 929], [3089, 3202], [['9,', 858, 885, 3090, 3133], ['90', 885, 929, 3091, 3136]]),
    L('Kasininkas [•••]', [49, 596], [3150, 3239], [['Kasininkas', 49, 258, 3150, 3206]]),
    L('CR-000014706 2026-06-27 09:15:23', [50, 931], [3393, 3517], [['CR-000014706', 50, 298, 3393, 3444]]),
    L('Kvito numeris 126231', [49, 460], [3484, 3552], [['Kvito', 49, 151, 3484, 3529], ['numeris', 174, 319, 3488, 3534], ['126231', 343, 460, 3493, 3538]]),
];

describe('IKI receipt-157 — garbled total falls back to the item sum, not a rounding delta', () => {
    const res: any = parseIkiReceipt(lines);

    test('the 5 products parse', () => { expect(res.products).toHaveLength(5); });

    test('the total is the item sum ~10.11, NOT the 0,01 rounding delta', () => {
        expect(res.footer.total).toBeGreaterThan(9.5);
        expect(res.footer.total).toBeLessThan(10.5);
    });

    test('the total is within 5% of the summed item paid amounts', () => {
        const sum = res.products.reduce((s: number, p: any) => s + (p.promoPrice != null ? p.promoPrice : p.price) * (p.quantity || 1), 0);
        expect(Math.abs(res.footer.total - sum)).toBeLessThan(sum * 0.05);
    });
});
