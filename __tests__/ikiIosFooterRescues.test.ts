import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// iOS (Apple Vision) footer-scramble regressions — mechanism tests with clean
// spacing, shapes lifted verbatim from the 2026-07-12 iOS batch:
//   387 — the VAT rate line lost its '%' glyph AND the payment table scattered;
//         the identity lane must fire on the "A 21,00" letter+rate form.
//   393 — the VAT value (2,24) drifted onto the scrambled column-header row
//         where the Suma-su-PVM lane used to adopt it as the total; the
//         identity (cross-line v) must win with 12,90.
//   391/android — the OPPOSITE arbitration: the header row carries the DRIFTED
//         TRUE total (2,35) on a deposits receipt where the identity's 2,13 is
//         only the goods-class subtotal; the suspect must win.
//   383/393/394 — Vision splits the printed id row into id + label boxes and
//         the merge interleaves them id-FIRST ("… Kaca 0022 Kvito Nr.").
//   387 — "Kxito numeris" (v→x) must still feed the VMI last-group splice.
//   402 — "Data 2022-03-U4" (0→U) must still parse as a date.

const W = (text: string, xL: number, xR: number, yT: number, yB: number) => ({ text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB });
const L = (text: string, xL: number, xR: number, yT: number, yB: number): IkiLine => {
    const parts = text.split(/\s+/);
    const step = Math.max(20, Math.floor((xR - xL) / parts.length));
    return {
        text, xLeft: xL, xRight: xR, yTop: yT, yBottom: yB,
        words: parts.map((w, i) => W(w, xL + i * step, xL + i * step + step - 8, yT, yB)),
    };
};

const receiptWith = (trailer: string[], price = '7,10'): IkiLine[] => [
    L('IKI Lietuva, UAB', 60, 360, 20, 50),
    L('PVM mokėtojo kodas LT101937219', 60, 600, 100, 130),
    L('PIENAS DVARO 2,5%', 60, 420, 200, 240),
    L(`${price} A`, 800, 940, 200, 240),
    L('Pardavimas SUMA', 60, 600, 460, 500),
].concat(trailer.map((t, i) => L(t, 60, 700, 600 + i * 60, 640 + i * 60)));

describe('IKI iOS payment-table scramble — total recovery', () => {
    test('387: VAT identity fires without the % glyph ("A 21,00 7, 10 5,37 1,23")', () => {
        const { footer } = parseIkiReceipt(receiptWith([
            'Mokėti',
            'Eo PVM PVP Mokestis Suma su PVM suma',
            'A 21,00 7, 10 5,37 1,23',
        ]));
        expect(footer.total).toBeCloseTo(7.10, 2);
    });

    test('393: identity beats the scrambled-header suspect it EXPLAINS (v on the neighbour line)', () => {
        const { footer } = parseIkiReceipt(receiptWith([
            'Mokėti',
            'Be PVM suma Suma su PVM Mokestis 2,24',
            '10, 66 12,90 A 21,00 % 20,00',
        ]));
        expect(footer.total).toBeCloseTo(12.90, 2);
    });

    test('391/android shape: the drifted TRUE total on the header row beats an unrelated identity', () => {
        const { footer } = parseIkiReceipt(receiptWith([
            'Mokėti',
            'Mokestis 2, 35 a Suma su PVM Be PVM PVM suma',
            'A 21,00 % 2, 13 1, 76 0, 37',
        ], '2,35'));
        expect(footer.total).toBeCloseTo(2.35, 2);
    });

    test('clean "Suma su PVM 12,90" total line still adopts immediately', () => {
        const { footer } = parseIkiReceipt(receiptWith([
            'Suma su PVM 12,90',
        ]));
        expect(footer.total).toBeCloseTo(12.90, 2);
    });
});

describe('IKI iOS receipt-id row interleave (id before label)', () => {
    test('394: "27/616/115706 Kaca 0022 Kvito Nr." captures the id', () => {
        const { footer } = parseIkiReceipt(receiptWith([
            '27/616/115706 Kaca 0022 Kvito Nr.',
            '2026-06-24 11:38:32',
        ]));
        expect(footer.receiptNo).toBe('27/616/115706');
    });

    test('387: "Kxito numeris" VMI print splices the unreadable last group', () => {
        const { footer } = parseIkiReceipt(receiptWith([
            'Kvito Nr. 42/610/1145j0 Kasa 0022',
            '2026-06-18 11:47:37',
            'Kxito numeris 114559',
        ]));
        expect(footer.receiptNo).toBe('42/610/114559');
    });

    test('a lone kasa number before the label can never become the id', () => {
        const { footer } = parseIkiReceipt(receiptWith([
            '0022 Kvito Nr.',
            '2026-06-24 11:38:32',
        ]));
        expect(footer.receiptNo).not.toBe('0022');
    });
});

describe('IKI iOS date digit-rot (0→U)', () => {
    test('402: "Data 2022-03-U4" parses as 2022-03-04', () => {
        const { footer } = parseIkiReceipt(receiptWith([
            'Laikas 16:40:32',
            'Data 2022-03-U4',
        ]));
        expect(footer.date).toBe('2022-03-04');
    });

    test('promo-period ranges (space separators) still never parse as the date', () => {
        const { footer } = parseIkiReceipt(receiptWith([
            '2022 01 03 - 2022 12 31.',
        ]));
        expect(footer.date).toBe('');
    });
});
