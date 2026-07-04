import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt-242 re-scan: the printed "Data 2026-06-18" read with a 0→1 thermal confusion
// ("2026-16-18") — the impossible month sailed through to MySQL and the save 500-looped.
// The parser now (a) rescues month 13-19 back to 0X when the day is valid, and (b) drops
// a still-implausible date and keeps scanning (the VMI CR- trailer usually has a clean one).
const line = (text: string, y: number): IkiLine => ({
    text, xLeft: 60, xRight: 900, yTop: y, yBottom: y + 40,
    words: text.split(' ').map((w, i) => ({ text: w, xLeft: 60 + i * 90, xRight: 140 + i * 90, yTop: y, yBottom: y + 40 })),
});

const receipt = (dateLine: string, trailerDate?: string): IkiLine[] => [
    line('IKI Lietuva, UAB', 0),
    line('PVM mokėtojo kodas LT101937219', 50),
    line('MORKOS', 120), line('0, 89 A', 122),
    line('Prekiautojo ID 15027037', 200),
    line(dateLine, 250),
    line('SUMA 0,89 EUR', 300),
    ...(trailerDate ? [line(trailerDate, 400)] : []),
    line('Kvito numeris 104148', 450),
];

describe('IKI thermal date capture — garbled-month handling', () => {
    test('month 16 with a valid day is the 0→1 confusion → rescued to 06', () => {
        const res: any = parseIkiReceipt(receipt('Data 2026-16-18 Laikas 11:47:00'));
        expect(res.footer.date).toBe('2026-06-18');
        expect(res.footer.time).toBe('11:47');
    });

    test('a clean date is untouched', () => {
        const res: any = parseIkiReceipt(receipt('Data 2026-06-18 Laikas 11:47:00'));
        expect(res.footer.date).toBe('2026-06-18');
    });

    test('an unrescuable date is dropped and the scan takes the next candidate (CR- trailer)', () => {
        // month 26 is not the 1X-for-0X confusion → drop, fall through to the trailer date.
        const res: any = parseIkiReceipt(receipt('Data 2026-26-18 Laikas 11:47:00', 'CR-000015913 2026-06-18 11:48:06'));
        expect(res.footer.date).toBe('2026-06-18');
    });

    test('no plausible date anywhere → date stays empty (server falls back, never 500s)', () => {
        const res: any = parseIkiReceipt(receipt('Data 2026-26-38 Laikas 11:47:00'));
        expect(res.footer.date ?? '').toBe('');
    });
});
