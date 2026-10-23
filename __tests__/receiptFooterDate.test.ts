import { receiptFooterDateStr } from '../utils/receiptFooterDate';

describe('receiptFooterDateStr — explicit field first, blob fallback', () => {
    it('prefers the explicit receiptFooterDate from the slimmed endpoint', () => {
        expect(receiptFooterDateStr({
            receiptFooterDate: '2026-07-20',
            parsedData: { footer: { date: '1999-01-01' } },
        })).toBe('2026-07-20');
    });

    it('falls back to parsedData.footer.date against an un-updated server (object blob)', () => {
        expect(receiptFooterDateStr({
            parsedData: { footer: { date: '2026-07-19' } },
        })).toBe('2026-07-19');
    });

    it('falls back to parsedData.footer.date when the blob is a JSON string', () => {
        expect(receiptFooterDateStr({
            parsedData: JSON.stringify({ footer: { date: '2026-07-18' } }),
        })).toBe('2026-07-18');
    });

    it('uses the legacy top-level parsedData.date when footer.date is absent', () => {
        expect(receiptFooterDateStr({ parsedData: { date: '2026-07-17' } })).toBe('2026-07-17');
    });

    it('ignores an empty/whitespace explicit field and still falls back', () => {
        expect(receiptFooterDateStr({
            receiptFooterDate: '   ',
            parsedData: { footer: { date: '2026-07-16' } },
        })).toBe('2026-07-16');
        expect(receiptFooterDateStr({ receiptFooterDate: null, parsedData: null })).toBeNull();
    });

    it('returns null for missing blob, malformed JSON, or non-string dates', () => {
        expect(receiptFooterDateStr({})).toBeNull();
        expect(receiptFooterDateStr({ parsedData: '{not json' })).toBeNull();
        expect(receiptFooterDateStr({ parsedData: { footer: { date: 20260715 } } })).toBeNull();
        expect(receiptFooterDateStr({ parsedData: { footer: {} } })).toBeNull();
    });
});
