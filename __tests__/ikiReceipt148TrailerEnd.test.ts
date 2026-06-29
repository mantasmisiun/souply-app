import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 148 — a CASH IKI receipt with NO "Prekiautojo ID" trader line and a garbled payment
// block at the very bottom, so the only product-section-end marker that used to match was "Moketi"
// (in "PVM suma Moketi Be PVM") far below the trailer. That pulled the whole IKI loyalty/VAT
// trailer into the product list: the last real product (OHO) absorbed "IKI KORTELĖS NR.", and a
// phantom product ate the rest. The loyalty card line + the "sąskaitos-faktūros" VAT notice now end
// the product section, so only the 3 real products survive.
const L = (t: string, x: [number, number], y: [number, number], ws: any[][]): IkiLine => ({
    text: t, xLeft: x[0], xRight: x[1], yTop: y[0], yBottom: y[1],
    words: ws.map(([wt, a, b, c, d]) => ({ text: wt, xLeft: a, xRight: b, yTop: c, yBottom: d })),
});

const lines: IkiLine[] = [
    L('IKI Lietuva, UAB', [377, 750], [321, 393], [['IKI', 377, 437, 333, 388], ['Lietuva,', 467, 642, 326, 385]]),
    L('PVM mokėtojo kodas LT101937219', [210, 915], [407, 494], [['PVM', 210, 278, 435, 486], ['kodas', 516, 634, 419, 472], ['LT101937219', 658, 915, 407, 466]]),
    L('ESTRELLA SHAPES SONINĖS S', [81, 657], [511, 586], [['ESTRELLA', 81, 276, 526, 587], ['SHAPES', 283, 421, 520, 579], ['SONINÉS', 448, 609, 513, 572], ['S', 635, 656, 511, 564]]),
    L('2, 09 A', [917, 1056], [499, 550], [['2,', 917, 950, 504, 550], ['09', 964, 1010, 501, 547], ['A', 1033, 1056, 499, 545]]),
    L('-0, 52 A NUOLAIDA SU KORTELE', [81, 1054], [543, 639], [['-0,', 896, 948, 546, 598], ['52', 963, 1008, 545, 595], ['A', 1032, 1054, 544, 593]]),
    L('BITUTĖ ASTRUS POMIDORŲ PA', [86, 655], [602, 680], [['BITUTĖ', 86, 217, 620, 679], ['ASTRUS', 236, 376, 613, 673], ['POMIDORŲ', 390, 587, 605, 667], ['PA', 612, 655, 603, 657]]),
    L('1, 49 A', [932, 1054], [587, 645], [['1,', 932, 963, 591, 645], ['49', 962, 1008, 589, 643], ['A', 1031, 1054, 587, 641]]),
    L('OHO ! BULVIŲ TRAŠKUČIAI', [77, 606], [653, 733], [['OHO', 77, 144, 671, 724], ['!', 175, 184, 669, 720], ['BULVIŲ', 216, 356, 662, 719], ['TRAŠKUČIẢI', 380, 606, 654, 712]]),
    L('0, 89 A', [916, 1053], [636, 691], [['0,', 916, 947, 641, 690], ['89', 963, 1008, 638, 688], ['A', 1031, 1053, 636, 685]]),
    L('IKI KORTELES NR. [•••]', [120, 952], [871, 964], [['IKI', 120, 184, 898, 946], ['KORTELES', 192, 377, 891, 943], ['NR.', 402, 456, 887, 935], ['[•••]', 497, 952, 870, 933]]),
    L('PVM saskaitos-fakturos išrašomos', [217, 953], [967, 1045], [['PVM', 217, 284, 988, 1040], ['saskaitos-faktüros', 320, 723, 974, 1037]]),
    L('sutaupėte 0.52 EUR', [142, 564], [1207, 1269], [['sutaupėte', 142, 353, 1216, 1267], ['0.52', 378, 471, 1210, 1257]]),
    // Scrambled cash-receipt VAT/payment block: the to-pay amount "3, 95" sits on the line ABOVE
    // the "Mokėti" column header, and the total/SUMA never prints a clean "… EUR".
    L('3, 95', [867, 1049], [2180, 2246], [['3,', 867, 933, 2189, 2239], ['95', 961, 1048, 2180, 2231]]),
    L('PVM suma Moketi Be PVM', [51, 1051], [2229, 2309], [['PVM', 866, 935, 2237, 2291], ['suma', 961, 1051, 2229, 2285]]),
    L('Mokestis Suma su PVM 0, 69 3, 26', [50, 1055], [2265, 2349], [['Mokestis', 50, 237, 2282, 2339], ['Suma', 288, 382, 2274, 2327]]),
    L('6, 05 6,05 Grynieji EUR', [66, 1059], [2361, 2434], [['6,', 963, 997, 2366, 2418], ['05', 1009, 1056, 2361, 2414]]),
    L('Graža', [51, 168], [2432, 2480], [['Graža', 51, 168, 2432, 2476]]),
    L('Kvito Nr. 538/636/334416 Kasa 0001', [58, 854], [2470, 2578], [['Kvito', 58, 178, 2515, 2573], ['Nr.', 186, 245, 2511, 2565], ['Kasa', 644, 738, 2477, 2533], ['0001', 764, 854, 2470, 2525]]),
    L('Kvito numeris 334416 Saugos modulio numeris SM-000014991', [51, 881], [2907, 3058], [['Kvito', 51, 168, 2934, 2991], ['numeris', 193, 363, 2920, 2980], ['334416', 384, 528, 2907, 2966]]),
];

describe('IKI receipt-148 — cash receipt, loyalty/VAT trailer must not become products', () => {
    const res: any = parseIkiReceipt(lines);

    test('exactly the 3 real products — no phantom trailer product', () => {
        expect(res.products).toHaveLength(3);
        expect(res.products.map((p: any) => p.name)).toEqual([
            expect.stringMatching(/ESTRELLA/),
            expect.stringMatching(/BITUTĖ/),
            expect.stringMatching(/OHO/),
        ]);
    });

    test('the last product does NOT absorb the "IKI KORTELĖS NR." loyalty line', () => {
        const oho = res.products[2];
        expect(oho.rawLines.join(' ')).not.toMatch(/KORTEL/);
    });

    test('no product name is the loyalty/VAT trailer text', () => {
        expect(res.products.some((p: any) => /sąskaitos|saskaitos|sutaup|informacijos/i.test(p.name))).toBe(false);
    });

    test('the receipt number is still extracted (footer scans the whole receipt)', () => {
        expect(res.footer.receiptNos).toContain('538/636/334416');
    });

    test('the total is recovered from the "Mokėti" header via the amount on the line above (3,95)', () => {
        expect(res.footer.total).toBeCloseTo(3.95, 2);
    });
});
