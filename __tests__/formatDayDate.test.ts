import { formatWeekday, formatMonthAbbr, formatDayNum, formatWeekdayDate } from '../utils/formatDayDate';

// Local-component date so getDay/getMonth are timezone-stable. 2026-07-16 is a Thursday.
const THU = new Date(2026, 6, 16);

describe('formatDayDate — badge + weekday formatters', () => {
    it('formatWeekday: full weekday name (LT / EN)', () => {
        expect(formatWeekday(THU, 'lt')).toBe('Ketvirtadienis');
        expect(formatWeekday(THU, 'en')).toBe('Thursday');
    });

    it('formatMonthAbbr: 3-letter month (LT "Lie", EN "Jul")', () => {
        expect(formatMonthAbbr(THU, 'lt')).toBe('Lie');
        expect(formatMonthAbbr(THU, 'en')).toBe('Jul');
    });

    it('formatDayNum: day of month', () => {
        expect(formatDayNum(THU)).toBe('16');
    });

    it('formatWeekdayDate: weekday + date, disambiguating (LT / EN)', () => {
        expect(formatWeekdayDate(THU, 'lt')).toBe('Ketvirtadienis, liepos 16');
        expect(formatWeekdayDate(THU, 'en')).toBe('Thursday, 16 Jul');
    });

    it('invalid / empty input → empty string', () => {
        for (const bad of [null, undefined, '', 'not-a-date']) {
            expect(formatWeekday(bad, 'lt')).toBe('');
            expect(formatMonthAbbr(bad, 'lt')).toBe('');
            expect(formatDayNum(bad)).toBe('');
            expect(formatWeekdayDate(bad, 'lt')).toBe('');
        }
    });
});
