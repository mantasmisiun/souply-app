import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';
const L = (t: string, x: [number, number], y: [number, number], ws: any[][]): IkiLine => ({
    text: t, xLeft: x[0], xRight: x[1], yTop: y[0], yBottom: y[1],
    words: ws.map(([wt, a, b, c, d]) => ({ text: wt, xLeft: a, xRight: b, yTop: c, yBottom: d })),
});

// Receipt 161 — real MLKit word boxes for the DZIOVINTOS SLYVOS (weighed) and Žaliosios cukinijos
// (per-unit) regions, where a tight print + band-merge scattered each product's total/discount
// across the wrong bands. Both lost data before these fixes:
//   • DZIOVINTOS SLYVOS: the discount "-0,80" rode the weight calc row ("0,355 kg X8,99 -0,80 A")
//     whose weigh-branch classification didn't extract it → promo dropped. Now the weigh branch
//     captures the negative and the assembler keeps the product weighed.
//   • Žaliosios cukinijos: "2 vnt X 1,49 EUR/vr = 2,98" lost its count, its total's VAT letter
//     OCR-misread to "F" (not [ABC]), AND its "-1,80" discount band-merged onto the MAIŠELIS bag
//     (skip) row. Now a unit-calc fallback recovers the total + derives the count (so the per-UNIT
//     price 1,49 is stored, not the 2,98 line total), and the discPending signal pulls the
//     mis-clustered -1,80 back off the bag row.
describe('IKI receipt 161 — weighed discount on the calc row + scrambled per-unit calc', () => {
    const lines: IkiLine[] = [
        L('DZIOVINTOS SLYVOS 0,355 kg X8,99 EUR/ kg', [75, 556], [695, 782], [
            ['DZIOVINTOS', 75, 263, 699, 748], ['SLYVOS', 289, 391, 695, 740], ['0,355', 109, 190, 739, 782],
            ['kg', 234, 259, 736, 776], ['X8,99', 303, 407, 729, 773], ['EUR/', 426, 498, 725, 767], ['kg', 518, 555, 722, 763],
        ]),
        L('3, 19 A', [742, 852], [725, 767], [['3,', 742, 767, 727, 767], ['19', 781, 814, 726, 765], ['A', 832, 852, 725, 763]]),
        L('-0, 80 A', [726, 852], [757, 804], [['-0,', 726, 768, 760, 804], ['80', 779, 815, 758, 801], ['A', 832, 852, 757, 799]]),
        L('1,99 A', [746, 852], [794, 837], [['1,99', 746, 816, 795, 837], ['A', 834, 852, 794, 834]]),
        L('SUNOKE AVOKADAI', [81, 356], [797, 844], [['SUNOKE', 81, 188, 802, 844], ['AVOKADAI', 203, 356, 797, 840]]),
        L('-0, 50 NUOLAT DA SU KORTELE', [84, 825], [830, 872], [
            ['NUOLAT', 84, 187, 834, 872], ['DA', 189, 229, 833, 871], ['SU', 239, 275, 832, 870], ['KORTELE', 293, 424, 830, 870],
            ['-0,', 729, 777, 830, 870], ['50', 791, 825, 830, 870],
        ]),
        L('Zaliosi os cukin jos', [68, 430], [862, 905], [
            ['Zaliosi', 68, 192, 866, 905], ['os', 201, 235, 866, 903], ['cukin', 269, 354, 864, 901], ['jos', 373, 430, 862, 900],
        ]),
        L('Vnt. X 1,49 EUR/ yr 2,98 F NUOLAIDA SU KORTELE', [63, 852], [895, 960], [
            ['NUOLAIDA', 63, 215, 916, 957], ['Vnt.', 153, 214, 895, 931], ['SU', 234, 273, 919, 958], ['X', 239, 275, 895, 931],
            ['KORTELE', 296, 429, 920, 960], ['1,49', 300, 372, 895, 931], ['EUR/', 395, 467, 895, 931], ['yr', 485, 511, 895, 931],
            ['2,98', 746, 820, 896, 937], ['F', 839, 852, 899, 937],
        ]),
        L('-1,80 4 MAISELIS PLASTIKINIS LENG', [64, 852], [933, 1002], [
            ['MAISELIS', 64, 216, 954, 996], ['PLASTIKINIS', 237, 444, 956, 1000], ['LENG', 466, 538, 960, 1002],
            ['-1,80', 729, 818, 933, 974], ['4', 840, 852, 933, 974],
        ]),
        L('0,01 A', [755, 852], [968, 1013], [['0,01', 755, 824, 968, 1012], ['A', 834, 852, 970, 1013]]),
        L('IKI KORTELĖS NR. 999000111222', [101, 753], [1145, 1201], [['IKI', 101, 152, 1145, 1191], ['999000111222', 409, 753, 1149, 1197]]),
    ];
    const res: any = parseIkiReceipt(lines);

    test('DZIOVINTOS SLYVOS stays ONE weighed product with its discount applied (promo €6,73/kg)', () => {
        const d = res.products.filter((p: any) => /SLYVOS|DZIOV/.test(p.name));
        expect(d).toHaveLength(1);
        expect(d[0].unit).toBe('kg');
        expect(d[0].price).toBeCloseTo(8.99, 2);
        expect(d[0].quantity).toBeCloseTo(0.355, 3);
        expect(d[0].promoPrice).toBeCloseTo(6.73, 2);
        expect(d[0].name).not.toMatch(/EUR/);            // the weight-calc tail no longer leaks into the name
    });

    test('Žaliosios cukinijos recovers per-unit price 1,49 ×2 AND the -1,80 discount (promo 0,59)', () => {
        const z = res.products.find((p: any) => /cukin/i.test(p.name));
        expect(z).toBeTruthy();
        expect(z.quantity).toBe(2);
        expect(z.price).toBeCloseTo(1.49, 2);            // the per-UNIT price, NOT the 2,98 line total
        expect(z.promoPrice).toBeCloseTo(0.59, 2);
    });

    test('the MAIŠELIS plastic bag is not emitted as a product', () => {
        expect(res.products.some((p: any) => /MAISEL|PLASTIK/i.test(p.name))).toBe(false);
    });
});

// Guard for the discPending discount recovery: it must fire ONLY for a BAG skip row (which never
// owns a negative). A coupon/points skip line carrying its OWN negative ("IKI Taškais -0,05 A"),
// appearing where the bag row was, must NOT have that amount stolen as the unit-calc product's
// discount. (Adversarial false positive caught during verification of receipt-161.) Reuses the
// real row context above (swapping the MAIŠELIS bag row for the points line) so the band
// clustering is faithful — only the skip row's identity differs.
describe('IKI — a points/coupon negative is NOT stolen as the unit-calc product discount', () => {
    const pts: IkiLine[] = [
        L('Vnt. X 1,49 EUR/ yr 2,98 F NUOLAIDA SU KORTELE', [63, 852], [895, 960], [
            ['NUOLAIDA', 63, 215, 916, 957], ['Vnt.', 153, 214, 895, 931], ['SU', 234, 273, 919, 958], ['X', 239, 275, 895, 931],
            ['KORTELE', 296, 429, 920, 960], ['1,49', 300, 372, 895, 931], ['EUR/', 395, 467, 895, 931], ['yr', 485, 511, 895, 931],
            ['2,98', 746, 820, 896, 937], ['F', 839, 852, 899, 937],
        ]),
        L('Zaliosi os cukin jos', [68, 430], [862, 905], [
            ['Zaliosi', 68, 192, 866, 905], ['os', 201, 235, 866, 903], ['cukin', 269, 354, 864, 901], ['jos', 373, 430, 862, 900],
        ]),
        // the bag row, replaced by a POINTS line carrying its OWN -0,05
        L('IKI Taškais -0,05 A', [64, 852], [933, 1002], [['IKI', 64, 120, 954, 996], ['Taškais', 140, 360, 956, 1000], ['-0,05', 729, 818, 933, 974], ['A', 840, 852, 933, 974]]),
        L('IKI KORTELĖS NR. 999000111222', [101, 753], [1145, 1201], [['IKI', 101, 152, 1145, 1191], ['999000111222', 409, 753, 1149, 1197]]),
    ];
    // Prepend the same DZIOVINTOS/SUNOKE rows as the main fixture so lineH + column split match.
    const ctx: IkiLine[] = [
        L('DZIOVINTOS SLYVOS 0,355 kg X8,99 EUR/ kg', [75, 556], [695, 782], [
            ['DZIOVINTOS', 75, 263, 699, 748], ['SLYVOS', 289, 391, 695, 740], ['0,355', 109, 190, 739, 782],
            ['kg', 234, 259, 736, 776], ['X8,99', 303, 407, 729, 773], ['EUR/', 426, 498, 725, 767], ['kg', 518, 555, 722, 763],
        ]),
        L('3, 19 A', [742, 852], [725, 767], [['3,', 742, 767, 727, 767], ['19', 781, 814, 726, 765], ['A', 832, 852, 725, 763]]),
        L('-0, 80 A', [726, 852], [757, 804], [['-0,', 726, 768, 760, 804], ['80', 779, 815, 758, 801], ['A', 832, 852, 757, 799]]),
        L('1,99 A', [746, 852], [794, 837], [['1,99', 746, 816, 795, 837], ['A', 834, 852, 794, 834]]),
        L('SUNOKE AVOKADAI', [81, 356], [797, 844], [['SUNOKE', 81, 188, 802, 844], ['AVOKADAI', 203, 356, 797, 840]]),
        L('-0, 50 NUOLAT DA SU KORTELE', [84, 825], [830, 872], [
            ['NUOLAT', 84, 187, 834, 872], ['DA', 189, 229, 833, 871], ['SU', 239, 275, 832, 870], ['KORTELE', 293, 424, 830, 870],
            ['-0,', 729, 777, 830, 870], ['50', 791, 825, 830, 870],
        ]),
    ];
    const res: any = parseIkiReceipt([...ctx, ...pts]);

    test('the unit-calc product keeps its 1,49 price and gets NO promo from the points line', () => {
        const z = res.products.find((p: any) => /cukin/i.test(p.name));
        expect(z.price).toBeCloseTo(1.49, 2);
        expect(z.promoPrice).toBeNull();   // the -0,05 belongs to the points line, not the product
    });
});
