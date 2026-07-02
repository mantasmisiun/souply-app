import { parseLidlReceipt, type LidlLine } from '../shared/parsers/lidlParser';

const toLines = (raw: string): LidlLine[] =>
    raw.split('\n').map((text, i) => ({ text, yTop: i * 30, yBottom: i * 30 + 24, xLeft: 0, xRight: 400 }));

// Lidl unit-price contract: `price` must ALWAYS be the PER-UNIT price. When the
// unit line's ppu number is OCR-dropped ("x 2 €/vnt." instead of "1,49 x 2 €/vnt.")
// the anchor total used to be emitted as-is with quantity 2 — the server then wrote
// the multi-buy LINE TOTAL as the SP's reference price. The parser now derives
// unit = total ÷ qty for that case (audit finding, parsers-consistency HIGH).
describe('Lidl multi-buy unit-price contract', () => {
    test('OCR-dropped ppu: price is derived as total ÷ qty, never the line total', () => {
        const res = parseLidlReceipt(toLines([
            'Kvitas 12345/58',
            '#0012345',
            'Žaliosios cukinijos',
            'x 2 €/vnt.',        // ppu dropped by OCR — qty survived
            '2,98 A',            // anchor = LINE TOTAL
            'Tarpinė suma',
            '2,98',
            'Mokėti',
            '2,98',
            'Dokumento numeris:',
            '12345',
        ].join('\n')));

        const p = res.products.find((x) => /cukinij/i.test(x.name));
        expect(p).toBeTruthy();
        expect(p!.quantity).toBe(2);
        expect(p!.price).toBeCloseTo(1.49, 2);          // 2.98 ÷ 2 — NOT 2.98
        expect(p!.pricePerUnit).toBeCloseTo(1.49, 2);
    });

    test('control: ppu present keeps the existing normalization (price = ppu)', () => {
        const res = parseLidlReceipt(toLines([
            'Kvitas 12345/58',
            '#0012345',
            'Žaliosios cukinijos',
            '1,49 x 2 €/vnt.',
            '2,98 A',
            'Tarpinė suma',
            '2,98',
            'Mokėti',
            '2,98',
            'Dokumento numeris:',
            '12345',
        ].join('\n')));

        const p = res.products.find((x) => /cukinij/i.test(x.name));
        expect(p).toBeTruthy();
        expect(p!.quantity).toBe(2);
        expect(p!.price).toBeCloseTo(1.49, 2);
    });

    test('single-qty product is untouched (price stays the anchor value)', () => {
        const res = parseLidlReceipt(toLines([
            'Kvitas 12345/58',
            '#0012345',
            'Pienas rinktinis',
            '1,09 A',
            'Tarpinė suma',
            '1,09',
            'Mokėti',
            '1,09',
            'Dokumento numeris:',
            '12345',
        ].join('\n')));

        const p = res.products.find((x) => /pienas/i.test(x.name));
        expect(p).toBeTruthy();
        expect(p!.quantity).toBe(1);
        expect(p!.price).toBeCloseTo(1.09, 2);
    });
});
