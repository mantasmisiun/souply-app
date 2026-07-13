import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 151 (re-scan of 150) surfaced two OCR-garble misses:
//   1. The last product's name "RAUDONOSIOS PAPRIKOS" was fused onto the PRIOR product's discount
//      line, but the discount amount OCR'd as "-000" (comma dropped). The lead-discount splitter
//      required a well-formed "-N,NN", so the name never split off → the product was "?".
//   2. The date+time line OCR'd "2026-06-18" as "2026-06--18" (doubled hyphen). T_DATE_RE required
//      single hyphens, so the parser returned date="" and drew NO date band (only a time band).
// Both are now tolerant: a garbled-amount lead-discount split (mandatory VAT-letter anchor) recovers
// the name, and the date separator accepts a repeated hyphen/dot (never a slash/space).
const L = (t: string, x: [number, number], y: [number, number], ws: any[][]): IkiLine => ({
    text: t, xLeft: x[0], xRight: x[1], yTop: y[0], yBottom: y[1],
    words: ws.map(([wt, a, b, c, d]) => ({ text: wt, xLeft: a, xRight: b, yTop: c, yBottom: d })),
});

const lines: IkiLine[] = [
    L('PVM moketojo kodas LT101937219', [179, 837], [336, 404], [['PVM', 179, 245, 336, 382], ['kodas', 464, 575, 347, 394], ['LT101937219', 587, 837, 351, 404]]),
    L('TRUMPAVAISIAI AGURKAI', [59, 521], [422, 487], [['TRUMPAVAISIAI', 59, 347, 422, 475], ['AGURKAI', 368, 521, 428, 479]]),
    L('0, 245 k9 2,99 EUR/ kg', [85, 621], [464, 526], [['0,', 85, 114, 464, 513], ['245', 133, 189, 465, 515], ['k9', 208, 275, 468, 518], ['2,99', 371, 451, 473, 523], ['EUR/', 482, 562, 476, 526], ['kg', 577, 621, 479, 528]]),
    L('BILLA BI0 LINŲ SEMENŲ ALI', [50, 606], [502, 555], [['BĪLLA', 50, 157, 502, 556], ['BI0', 188, 258, 507, 558], ['LINŲ', 282, 365, 509, 562], ['SEMENŲ', 398, 522, 513, 567], ['ALI', 548, 606, 517, 570]]),
    L('0, 73 A', [858, 971], [486, 534], [['0,', 858, 886, 486, 532], ['73', 890, 943, 486, 532], ['A', 950, 971, 487, 533]]),
    L('NUOLAIDA SU KORTELE', [49, 468], [546, 597], [['NUOLAIDA', 49, 223, 546, 598], ['SU', 262, 304, 551, 599], ['KORTELE', 325, 468, 553, 604]]),
    L('3, 49 A', [844, 971], [528, 577], [['3,', 844, 873, 530, 577], ['49', 886, 927, 529, 576], ['A', 950, 971, 528, 575]]),
    L('-0, 70 A SALDŽIOSIOS BULVES', [51, 972], [572, 656], [['-0,', 830, 888, 572, 622], ['70', 888, 929, 572, 622], ['A', 952, 972, 572, 622]]),
    L('0, 475 kg X 2, 49 EUR/ kg', [93, 624], [630, 698], [['0,', 93, 111, 630, 680], ['475', 118, 187, 632, 683], ['kg', 224, 270, 636, 686], ['X', 311, 336, 640, 690], ['2,', 359, 391, 642, 692], ['49', 403, 448, 644, 694], ['EUR/', 469, 557, 647, 699], ['kg', 580, 624, 652, 702]]),
    L('PLAUILS MORKOS', [44, 368], [670, 739], [['PLAUILS', 44, 202, 670, 727], ['MORKOS', 233, 368, 678, 732]]),
    L('1, 18 A', [859, 973], [656, 713], [['1,', 859, 889, 657, 711], ['18', 891, 929, 657, 710], ['A', 953, 973, 657, 709]]),
    L('0,375 kg X 0,89 EUR/ kg', [68, 625], [715, 790], [['0,375', 68, 199, 715, 774], ['kg', 230, 278, 722, 777], ['X', 330, 347, 726, 779], ['0,89', 373, 461, 727, 784], ['EUR/', 470, 558, 731, 788], ['kg', 580, 625, 736, 790]]),
    L('BUROKĖLIAI CLEVER', [58, 426], [760, 829], [['BUROKĖLIAÍ', 58, 293, 760, 819], ['CLEVER', 294, 426, 768, 823]]),
    L('0,33 A', [846, 973], [748, 794], [['0,33', 846, 931, 748, 789], ['A', 954, 973, 748, 789]]),
    L('0, 410 kg X 0, 55 EUR/ kg', [89, 624], [805, 874], [['0,', 89, 105, 806, 856], ['410', 123, 194, 807, 859], ['kg', 225, 271, 810, 861], ['X', 334, 350, 814, 864], ['0,', 375, 406, 816, 867], ['55', 406, 450, 817, 867], ['EUR/', 472, 557, 819, 871], ['kg', 582, 624, 823, 874]]),
    L('SVIEZI KOPUSTAI', [56, 392], [844, 913], [['SVIEZI', 56, 193, 845, 904], ['KOPUSTAI', 204, 392, 850, 911]]),
    L('0, 23 A', [848, 975], [834, 880], [['0,', 848, 879, 834, 876], ['23', 893, 933, 834, 876], ['A', 957, 975, 834, 876]]),
    L('1, 250 kg X 1,39 EUR/ kg', [94, 625], [891, 960], [['1,', 94, 112, 891, 942], ['250', 115, 181, 892, 944], ['kg', 236, 280, 896, 947], ['X', 304, 342, 899, 950], ['1,39', 355, 451, 900, 953], ['EUR/', 472, 559, 904, 957], ['kg', 584, 625, 908, 959]]),
    L('NUOLAIDA SU KORTELE', [55, 480], [934, 1004], [['NUOLAIDA', 55, 229, 934, 990], ['SU', 261, 306, 941, 992], ['KORTELE', 328, 480, 943, 999]]),
    L('1, 74 A', [850, 978], [917, 961], [['1,', 850, 879, 917, 958], ['74', 892, 934, 918, 959], ['A', 958, 978, 920, 960]]),
    // The fused line: "-000 A" is KOPŪSTAI's (garbled) discount, "RAUDONOSIOS PAPRIKOS" is the
    // NEXT product's name — and OCR kept word boxes ONLY for the "-000"/"A" amount.
    L('-000 A RAUDONOSIOS PAPRIKOS', [47, 981], [947, 1035], [['-000', 832, 954, 947, 1001], ['A', 957, 981, 957, 1003]]),
    L('0, 245 kg X 3,49 EUR/ kg', [69, 626], [1017, 1080], [['0,', 69, 99, 1018, 1063], ['245', 114, 178, 1018, 1065], ['kg', 240, 279, 1020, 1065], ['X', 340, 353, 1022, 1067], ['3,49', 362, 447, 1022, 1069], ['EUR/', 472, 558, 1024, 1070], ['kg', 583, 626, 1025, 1071]]),
    L('NUOLAIDA ŠU KORTELE', [57, 473], [1057, 1123], [['NUOLAIDA', 57, 221, 1057, 1107], ['ŠU', 241, 291, 1060, 1107], ['KORTELE', 322, 473, 1061, 1110]]),
    L('0, 86 A', [851, 981], [1042, 1085], [['0,', 851, 882, 1042, 1084], ['86', 895, 937, 1044, 1085], ['A', 959, 981, 1046, 1086]]),
    L('-0,25 A', [828, 980], [1076, 1132], [['-0,25', 828, 938, 1076, 1132], ['A', 957, 980, 1086, 1135]]),
    L('IKI KORTELĖS NR. 999000111222', [76, 867], [1273, 1351], [['IKI', 76, 144, 1273, 1324], ['KORTELĖS', 158, 339, 1275, 1330], ['NR.', 362, 418, 1282, 1332], ['999000111222', 453, 867, 1285, 1347]]),
    L('Moketi 7, 10', [47, 984], [2552, 2599], [['Mokèti', 47, 173, 2552, 2593]]),
    L('Kvito Nr. 42/610/114559 Kasa 0022', [45, 784], [2824, 2879], [['Kvito', 45, 153, 2824, 2879], ['Nr.', 168, 223, 2824, 2879], ['42/610/114559', 260, 557, 2824, 2879], ['Kasa', 582, 672, 2824, 2879], ['0022', 695, 784, 2824, 2879]]),
    // The date+time line — note the DOUBLED hyphen "2026-06--18", plus a hyphenated receipt code
    // ("CR-000014698") on the same line that must NOT be mistaken for the date.
    L('2026-06--18 11:47:37 CR-000014698', [42, 974], [3092, 3147], [['2026-06--18', 559, 780, 3092, 3136], ['11:47:37', 805, 974, 3096, 3138]]),
    L('Kvito parašas gP02-3283-3FF5-4FBD', [45, 775], [3243, 3324], [['gP02-3283-3FF5-4FBD', 358, 775, 3243, 3300]]),
    L('Kvito kodas E35D-B318-B150-9631', [47, 727], [3288, 3364], [['E35D-B318-B150-9631', 317, 727, 3288, 3343]]),
];

describe('IKI receipt-151 — garbled fused name recovery + doubled-hyphen date', () => {
    const res: any = parseIkiReceipt(lines);

    test('7 products and the last one recovers its name "RAUDONOSIOS PAPRIKOS" (not "?")', () => {
        expect(res.products).toHaveLength(7);
        expect(res.products[6].name).toMatch(/RAUDONOSIOS PAPRIKOS/);
    });

    test('the recovered name is not lost from / duplicated across other products', () => {
        const names = res.products.map((p: any) => p.name);
        expect(names.filter((n: string) => /RAUDONOSIOS/.test(n))).toHaveLength(1);
        expect(names).not.toContain('?');
    });

    test('the date is recovered from the doubled-hyphen "2026-06--18"', () => {
        expect(res.footer.date).toBe('2026-06-18');
    });

    test('a date band is drawn (combined dateTime when it shares the time line)', () => {
        const dateBands = (res.footer.lineRegions || []).filter((r: any) => r.kind === 'date' || r.kind === 'dateTime');
        expect(dateBands.length).toBeGreaterThanOrEqual(1);
    });

    test('the hyphenated receipt code "CR-000014698" is NOT mistaken for the date', () => {
        expect(res.footer.date).not.toMatch(/0000|1469/);
    });
});
