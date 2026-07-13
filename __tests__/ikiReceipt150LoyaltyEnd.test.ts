import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';
import { detectCardMaskBands } from '../shared/parsers/cardMaskDetection';

// Receipt 150 — OCR misread the IKI loyalty-card label "KORTELĖS" → "KORIELĖS" (T→I). That broke
// BOTH places that key off "KORTEL…":
//   1. the product-section-end marker ("KORTEL\S* NR") → the loyalty line "IKI KORIELĖS NR. <num>"
//      slipped past the end gate and became a PHANTOM product (and the prior product spilled into it),
//   2. the loyalty-number mask ("kortel\w* nr") → the full card number was left UNMASKED.
// Both now use the OCR-tolerant "KOR?EL … NR" stem. Separately, the to-pay total "Mokėti 7,10" was
// OCR'd as "Mokėti 7 10" (comma → space) and the comma-only amount regex rejected it.
const L = (t: string, x: [number, number], y: [number, number], ws: any[][]): IkiLine => ({
    text: t, xLeft: x[0], xRight: x[1], yTop: y[0], yBottom: y[1],
    words: ws.map(([wt, a, b, c, d]) => ({ text: wt, xLeft: a, xRight: b, yTop: c, yBottom: d })),
});

const lines: IkiLine[] = [
    L('PVM moketojo kodas LT101937219', [145, 757], [304, 358], [['PVM', 145, 204, 304, 346], ['kodas', 408, 511, 309, 351], ['LT101937219', 523, 757, 312, 356]]),
    L('TRUMPAVAISIAI AGURKAL', [33, 446], [382, 437], [['TRUMPAVAISIAI', 33, 295, 382, 431], ['AGURKAL', 307, 446, 385, 433]]),
    L('0, 245 k9 2,99 EUR/ kg', [44, 552], [423, 480], [['0,', 44, 73, 423, 468], ['245', 86, 160, 424, 470], ['k9', 191, 230, 426, 471]]),
    L('BILLA BI0 LINŲ SEMENŲ ALI', [24, 543], [454, 517], [['BILLA', 24, 139, 454, 503], ['BI0', 142, 221, 458, 505]]),
    L('0,73 A', [762, 884], [444, 491], [['0,73', 762, 842, 444, 488], ['A', 865, 884, 444, 488]]),
    L('NUOLAIDA SU KORTELE', [25, 402], [499, 553], [['NUOLAIDA', 25, 183, 499, 542], ['SU', 206, 246, 504, 544]]),
    L('3,49 A', [762, 884], [479, 529], [['3,49', 762, 842, 479, 526], ['A', 864, 884, 481, 527]]),
    L('-0, 70 A SALDZ IOS IOS BULVES', [25, 885], [522, 598], [['-0,', 743, 792, 522, 570], ['70', 815, 857, 522, 570]]),
    L('0,475 kg X 2,49 EUR/ kg', [29, 557], [574, 647], [['0,475', 29, 144, 574, 623], ['kg', 186, 228, 581, 627]]),
    L('PLAUI LS MORKOS', [21, 309], [615, 681], [['PLAUI', 21, 125, 615, 668], ['LS', 126, 165, 619, 668]]),
    L('1,18 A', [764, 887], [601, 648], [['1,18', 764, 845, 601, 643], ['A', 865, 887, 605, 645]]),
    L('0,375 kg X 0,89 EUR/ kg', [42, 557], [660, 721], [['0,375', 42, 145, 660, 706], ['kg', 186, 227, 666, 710]]),
    L('BUROKĖLIAI CLEVER', [32, 379], [692, 762], [['BUROKĚLIAÍ', 32, 244, 692, 748], ['CLEVER', 249, 379, 700, 752]]),
    L('0,33 A', [766, 887], [688, 733], [['0,33', 766, 845, 688, 728], ['A', 868, 887, 688, 728]]),
    L('0,410 kg X 0,55 EUR/ kg', [57, 558], [739, 812], [['0,410', 57, 163, 739, 791], ['kg', 195, 237, 745, 794]]),
    L('SVIEZI KOPUSTAI', [29, 340], [775, 839], [['SVIEZI', 29, 160, 775, 829], ['KOPUSTAI', 182, 340, 782, 836]]),
    L('0,23 A', [765, 887], [767, 813], [['0,23', 765, 847, 767, 807], ['A', 868, 887, 767, 807]]),
    L('1,250 kg X 1,39 EUR/ ko', [38, 557], [819, 886], [['1,250', 38, 162, 819, 871], ['kg', 197, 240, 824, 873]]),
    L('NUOLAIDA SU KORTELE', [23, 415], [858, 916], [['NUOLAIDA', 23, 191, 858, 903], ['SU', 210, 251, 864, 904]]),
    L('1, 74 A', [769, 889], [845, 888], [['1,', 769, 797, 845, 885], ['74', 808, 847, 846, 885]]),
    L('-0,CO A RAUDONGSIOS PAPRIKOS', [21, 890], [880, 950], [['-0,CO', 751, 848, 880, 927], ['A', 870, 890, 885, 928]]),
    L('0,245 kg X 3,49 EUR/ kg', [62, 557], [936, 995], [['0,245', 62, 149, 936, 983], ['kg', 188, 247, 939, 985]]),
    L('NUOLAIDA ŠU KORTELE', [21, 413], [971, 1032], [['NUOLAIDA', 21, 185, 971, 1019], ['ŠU', 224, 263, 977, 1022]]),
    L('0, 86 A', [782, 891], [961, 1007], [['0,', 782, 808, 961, 1004], ['86', 810, 849, 961, 1005]]),
    L('-0,26 A', [748, 893], [997, 1047], [['-0,26', 748, 850, 997, 1046], ['A', 870, 893, 1005, 1048]]),
    // The loyalty-card line — OCR read KORTELĖS as "KORIELĖS". Must END the product section AND mask the number.
    L('IKI KORIELĖS NR. 9440006300214432954', [49, 782], [1166, 1253], [['IKI', 49, 115, 1166, 1216], ['KORIELĖS', 122, 290, 1170, 1224], ['NR.', 311, 364, 1178, 1228], ['9440006300214432954', 395, 782, 1182, 1247]]),
    L('FVM sąskaitos-fakturos išrašnmos', [145, 805], [1261, 1333], [['FVM', 145, 208, 1261, 1304]]),
    // Cash payment block — "Mokėti 7,10" OCR'd as "Mokėti 7 10".
    L('Mokėti 7 10', [17, 891], [2353, 2421], [['Mokėti', 17, 136, 2353, 2393]]),
    L('Mokestis Suaa su PVM PV sua', [16, 890], [2393, 2469], [['Mokestis', 16, 185, 2393, 2439]]),
    L('A 21,00 $ 7, 10 5,97', [34, 643], [2432, 2501], [['A', 34, 51, 2432, 2481], ['21,00', 56, 163, 2433, 2487]]),
    L('1,23 Gryniejı', [12, 893], [2462, 2528], [['1,23', 814, 893, 2462, 2512]]),
    L('10,00 Graza', [11, 893], [2505, 2571], [['10,00', 793, 893, 2505, 2551]]),
    L('2,90', [814, 896], [2548, 2595], [['2,90', 814, 896, 2548, 2592]]),
    L('Kvito Nr. 42/610/114559 Kasa 0022', [10, 705], [2603, 2682], [['Kvito', 10, 124, 2603, 2654], ['Nr.', 145, 189, 2608, 2656], ['42/610/114559', 208, 491, 2611, 2669]]),
    L('CR-000614698 2026-06-18 11:47:37', [9, 884], [2873, 2951], [['CR-000614698', 9, 260, 2873, 2919]]),
];

describe('IKI receipt-150 — loyalty line (KORIELĖS, T→I) ends products + masks, "Mokėti 7 10" total', () => {
    const res: any = parseIkiReceipt(lines);

    test('exactly the 7 real products — the loyalty card line is NOT a phantom product', () => {
        expect(res.products).toHaveLength(7);
    });

    test('no product is the loyalty card line (name or the raw card number)', () => {
        const isLoyalty = (p: any) => /KORIEL|KORTEL/i.test(p.name) || /9440006300214432954/.test(p.rawLines.join(' '));
        expect(res.products.some(isLoyalty)).toBe(false);
    });

    test('the to-pay total is recovered from "Mokėti 7 10" (comma dropped to a space → 7,10)', () => {
        expect(res.footer.total).toBeCloseTo(7.1, 2);
    });

    test('the loyalty card number is masked despite the KORTELĖS→KORIELĖS misread', () => {
        const loyalty = detectCardMaskBands(lines as any).filter((b: any) => b.kind === 'loyalty');
        expect(loyalty.length).toBeGreaterThanOrEqual(1);
    });
});
