import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 138 — heavily damaged IKI receipt (1 product: AKVILĖ GAZ sparkling water). The VAT
// line OCR'd to a stub "PVM 7219" (from "PVM mokėtojo kodas LT101937219") so the header
// boundary was never found → pStart=0. That cascaded: (a) the header lines "Saulè"(address
// fragment) + "PVM" folded into the product NAME ("Saule PVM AKVILĖ GAZ."), (b) the address
// scan ran down to the product PRICE and grabbed "0, 65 A" as the store address (the SAME datum
// used twice — once as the item price, once as the address), and (c) the band was drawn below
// the name (on NUOLAIDA/DEPOZITAS). Detecting the stub "PVM …" line advances pStart past the
// header and fixes all three; the bare-price guard stops "0,65 A" being read as an address.
const D = (t: string, x: [number, number], y: [number, number], ws: any[][]): IkiLine => ({
    text: t, xLeft: x[0], xRight: x[1], yTop: y[0], yBottom: y[1],
    words: ws.map(([wt, a, b, c, d]) => ({ text: wt, xLeft: a, xRight: b, yTop: c, yBottom: d })),
});

const lines: IkiLine[] = [
    D('Saule Inius', [242, 924], [294, 354], [['Saulè', 242, 353, 294, 341]]),
    D('PVM 7219', [230, 924], [347, 398], [['PVM', 230, 297, 347, 385]]),
    D('AKVILĖ GAZ.', [86, 330], [430, 484], [['AKVILĖ', 86, 224, 430, 475], ['GAZ.', 251, 330, 436, 478]]),
    D('0, 65 A', [926, 1066], [436, 488], [['0,', 926, 958, 442, 490], ['65', 972, 1017, 438, 487], ['A', 1042, 1066, 436, 483]]),
    D('NUOLAI DA SU K -0,33 A', [87, 1066], [475, 537], [['NUOLAI', 87, 221, 475, 525], ['DA', 228, 273, 480, 527], ['SU', 298, 343, 482, 528], ['K', 367, 383, 484, 529]]),
    D('DEPOZI TAS 0, 10', [87, 1020], [519, 579], [['DEPOZI', 87, 221, 519, 565], ['TAS', 229, 296, 524, 566]]),
    D('Prekiautojo ID 15', [87, 516], [607, 667], [['Prekiautojo', 87, 342, 607, 659], ['ID', 373, 411, 612, 660]]),
    D('Data 2026-06-10 9:15', [87, 1066], [653, 704], [['Data', 87, 177, 653, 697], ['2026-06-10', 204, 435, 654, 699]]),
];

describe('IKI receipt-138 — garbled "PVM" stub header must not fold into the product', () => {
    const res: any = parseIkiReceipt(lines);
    const products = res.products;

    test('the product name is the real name — no header (Saulè / PVM) folded in', () => {
        expect(products).toHaveLength(1);
        expect(products[0].name).toMatch(/AKVIL/i);
        expect(products[0].name).not.toMatch(/Saul|PVM/i);
    });

    test('price + 50%-off-style discount still resolve (0,65 → 0,32 after −0,33)', () => {
        expect(products[0].price).toBeCloseTo(0.65, 2);
        expect(products[0].promoPrice).toBeCloseTo(0.32, 2);
    });

    test('the band starts at the NAME, not below it on the discount/deposit rows', () => {
        const r = products[0].region;
        expect(r.yTop).toBeLessThanOrEqual(470); // name top ≈ 430; was ≈ 494 (below the name)
    });

    test('the store address is NOT the product price "0, 65 A" (a datum is never used twice)', () => {
        const addr = String(res.header?.storeAddress ?? '');
        expect(addr).not.toMatch(/^-?\d{1,4}[.,]\s?\d{2}\s*[ABC]?\s*$/); // not a bare price
    });
});
