import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 129 regression (mechanism test with clean spacing). A product's NUOLAIDA discount
// can be OCR-fused onto the trader/footer BOUNDARY line ("-0,40 A Prekiautojo ID 15132001"),
// where only "-0,40 A" carries word boxes and the trader text is unboxed. The product-section
// boundary used to exclude that whole line, dropping the discount (promoPrice stayed null).
// The boundary must KEEP a line whose boxed words are a bare leading discount so the engine
// attaches it to the open last product.
//
// (Real receipt-129 coordinates can't be replayed verbatim — the stored wordsDump is RAW MLKit
//  output, while the parser receives pipeline-transformed coords, so clustering differs. This
//  uses clean, well-separated coordinates to isolate the boundary/discount behaviour.)
const W = (text: string, xL: number, xR: number, yT: number, yB: number) => ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB });
const L = (text: string, xL: number, xR: number, yT: number, yB: number, words: any[]): IkiLine => ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB, words });

const baseLines = (traderLine: IkiLine): IkiLine[] => [
    L('IKI Lietuva, UAB', 60, 360, 20, 50, [W('IKI', 60, 110, 20, 50), W('Lietuva,', 120, 260, 20, 50), W('UAB', 270, 360, 20, 50)]),
    L('PVM mokėtojo kodas LT101937219', 60, 600, 100, 130, [W('PVM', 60, 130, 100, 130), W('mokėtojo', 140, 320, 100, 130), W('kodas', 330, 440, 100, 130), W('LT101937219', 450, 600, 100, 130)]),
    // a normal earlier product so the cucumber is genuinely the LAST one
    L('PIENAS DVARO 2,5%', 60, 420, 200, 240, [W('PIENAS', 60, 200, 200, 240), W('DVARO', 210, 330, 200, 240), W('2,5%', 340, 420, 200, 240)]),
    L('1,29 A', 800, 940, 200, 240, [W('1,29', 800, 890, 200, 240), W('A', 910, 940, 200, 240)]),
    // the LAST product: name + total on one row
    L('LIETUVISKI ILGAVAISIAI AG', 60, 520, 300, 340, [W('LIETUVISKI', 60, 250, 300, 340), W('ILGAVAISIAI', 260, 470, 300, 340), W('AG', 480, 520, 300, 340)]),
    L('0, 99 A', 800, 940, 300, 340, [W('0,', 800, 830, 300, 340), W('99', 840, 890, 300, 340), W('A', 910, 940, 300, 340)]),
    // its NUOLAIDA label (amount-less)
    L('NUOLAIDA', 60, 230, 360, 400, [W('NUOLAIDA', 60, 230, 360, 400)]),
    // ...and the discount amount fused onto the trader/footer boundary line (only "-0,40 A" boxed)
    traderLine,
    L('Pardavimas SUMA', 60, 600, 460, 500, [W('Pardavimas', 60, 280, 460, 500), W('SUMA', 400, 600, 460, 500)]),
];

const traderWithDiscount = L('-0, 40 A Prekiautojo ID 15132001', 60, 940, 400, 440, [
    W('-0,', 800, 840, 400, 440), W('40', 850, 890, 400, 440), W('A', 910, 940, 400, 440),
]);
const traderPlain = L('Prekiautojo ID 15132001', 60, 520, 400, 440, [
    W('Prekiautojo', 60, 260, 400, 440), W('ID', 270, 310, 400, 440), W('15132001', 320, 520, 400, 440),
]);

describe('IKI — last product discount fused onto the trader/footer boundary line', () => {
    test('the boxed leading discount is kept and applied → price 0,99, promo 0,59', () => {
        const { products } = parseIkiReceipt(baseLines(traderWithDiscount));
        const cuke = products.find((p) => /LIETUVISKI|ILGAVAISIAI/i.test(p.name));
        expect(cuke).toBeDefined();
        expect(cuke!.price).toBeCloseTo(0.99, 2);
        expect(cuke!.promoPrice).toBeCloseTo(0.59, 2); // 0,99 − 0,40
        // the trader text never becomes a product
        expect(products.some((p) => /Prekiautojo/i.test(p.name))).toBe(false);
    });

    test('control: a PLAIN trader line (no discount) is still excluded — no phantom, no discount', () => {
        const { products } = parseIkiReceipt(baseLines(traderPlain));
        expect(products.some((p) => /Prekiautojo/i.test(p.name))).toBe(false);
        const cuke = products.find((p) => /LIETUVISKI|ILGAVAISIAI/i.test(p.name));
        expect(cuke).toBeDefined();
        expect(cuke!.promoPrice).toBeNull(); // no discount line in range
    });
});
