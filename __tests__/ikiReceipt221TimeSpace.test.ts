import { parseIkiReceipt, type IkiLine } from '../shared/parsers/ikiParser';

// Receipt 221: the timestamp line was OCR'd "2026-05-19 19:36: 13" — a SPACE after the second
// colon ("36: 13"). T_TIME_RE required the seconds' two digits immediately after the colon, so
// it matched nothing and the time was lost (footer.time=""), while an unspaced receipt (220,
// "11:47:37") parsed fine. The fix tolerates whitespace around the separators while keeping the
// last separator a literal ':' so a DATE ("2026-05-19", '-' seps) is never mis-read as a time.
const toLines = (raw: string): IkiLine[] =>
    raw.split('\n').map((text, i) => ({ text, xLeft: 0, xRight: 400, yTop: i * 30, yBottom: i * 30 + 24 }));

// Minimal IKI receipt shell whose only variable is the date/time line.
const shell = (dateTimeLine: string) => toLines([
    'IKI Lietuva, UAB',
    'Vilniaus 9, Šiauliai',
    'BANANAI BON VIA',
    '1,19 A',
    'SUMA 1,19 EUR',
    `Kvito Nr. 42/610/11459 Kasa 0022`,
    dateTimeLine,
].join('\n'));

describe('IKI time extraction tolerates OCR spaces around colons', () => {
    test('receipt-221: "19:36: 13" (space after 2nd colon) → time 19:36', () => {
        const res: any = parseIkiReceipt(shell('2026-05-19 19:36: 13 CR-000015543'));
        expect(res.footer.time).toBe('19:36');
        expect(res.footer.date).toBe('2026-05-19');
    });

    test('receipt-220 baseline: "11:47:37" still → 11:47', () => {
        const res: any = parseIkiReceipt(shell('2026-06-18 11:47:37 CR-000: 14598'));
        expect(res.footer.time).toBe('11:47');
    });

    test('a date-only line does NOT produce a phantom time', () => {
        const res: any = parseIkiReceipt(shell('Data 2026-05-19'));
        expect(res.footer.time).toBe('');
    });
});
