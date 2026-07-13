import { extractReceiptNo, type LidlLine } from '../shared/parsers/lidlParser';

const toLines = (raw: string): LidlLine[] =>
    raw.split('\n').map((text, i) => ({ text, yTop: i * 30, yBottom: i * 30 + 24, xLeft: 0, xRight: 400 }));

describe('Lidl receipt-number extraction (multi-source, self-healing)', () => {
    test('recovers the value when MLKit splits "Dokumento numeris:" onto two lines', () => {
        // receipt-73 footer fragment — the old same-line regex returned null here
        const lines = toLines([
            'F: 86/581',
            '00094717',
            'SM-000022355',
            'R-000152976',
            'KVITO PATIKRINIMUI VMI',
            'Dokumento numeris:',
            '94717',
            'Saugos modulio numeris:',
        ].join('\n'));
        expect(extractReceiptNo(lines)?.value).toBe('94717');
    });

    test('handles the other pasted receipts (74, 75)', () => {
        expect(extractReceiptNo(toLines('Dokumento numeris:\n143786'))?.value).toBe('143786');
        expect(extractReceiptNo(toLines('Dokumento numeris:\n151269'))?.value).toBe('151269');
    });

    test('outvotes a garbled zero-padded read (80151269 is ignored → 151269)', () => {
        const lines = toLines([
            '00151269',
            'SM-000022342',
            '80151269',            // OCR misread of 00151269 — must not win
            'Dokumento numeris:',
            '151269',
        ].join('\n'));
        expect(extractReceiptNo(lines)?.value).toBe('151269');
    });

    test('ignores the 10-digit merchant number', () => {
        const lines = toLines([
            'Prekybininko Nr.',
            '0017300621',           // merchant id — too long to be the doc number
            'Dokumento numeris:',
            '94717',
        ].join('\n'));
        expect(extractReceiptNo(lines)?.value).toBe('94717');
    });

    test('header fallback: "Kvitas NNNNN/NN" + "#00NNNNN"', () => {
        expect(extractReceiptNo(toLines('Kvitas 94717/581\n#00094717'))?.value).toBe('94717');
    });

    test('header fallback: split "Kvitas" then "NNNNN/NN"', () => {
        expect(extractReceiptNo(toLines('Kvitas\n151269/584\n#00151269'))?.value).toBe('151269');
    });

    test('returns null when no number source is present', () => {
        expect(extractReceiptNo(toLines('Ačiū, kad pirkote!\nParduotuvės informacija'))).toBeNull();
    });
});
