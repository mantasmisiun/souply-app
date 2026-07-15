import { formatMonthKey, formatMonthRange, monthAbbr, monthLong, parseMonthKey } from '../utils/monthNames';

describe('monthNames — language-aware ordering', () => {
    test('single-month label: year-first in LT, month-first in EN', () => {
        expect(formatMonthKey('2026-07', 'lt')).toBe('2026 liepa');
        expect(formatMonthKey('2026-07', 'en')).toBe('July 2026');
    });

    test('same-year range: LT puts the year first, EN puts it last', () => {
        expect(formatMonthRange('2026-04', '2026-07', 'lt')).toBe('2026 bal–lie');
        expect(formatMonthRange('2026-04', '2026-07', 'en')).toBe('Apr–Jul 2026');
    });

    test('cross-year range keeps each year with its month, order per locale', () => {
        expect(formatMonthRange('2025-12', '2026-01', 'lt')).toBe('2025 grd – 2026 sau');
        expect(formatMonthRange('2025-12', '2026-01', 'en')).toBe('Dec 2025 – Jan 2026');
    });

    test('range collapses to a single month when start === end', () => {
        expect(formatMonthRange('2026-07', '2026-07', 'lt')).toBe('2026 lie');
        expect(formatMonthRange('2026-07', '2026-07', 'en')).toBe('Jul 2026');
    });

    test('abbreviations + full names are localized (not LT-only)', () => {
        expect(monthAbbr(7, 'en')).toBe('Jul');
        expect(monthAbbr(7, 'lt')).toBe('lie');
        expect(monthLong(1, 'en')).toBe('January');
        expect(monthLong(1, 'lt')).toBe('sausis');
    });

    test('malformed keys degrade gracefully', () => {
        expect(parseMonthKey('nope')).toBeNull();
        expect(formatMonthKey('nope', 'lt')).toBe('nope');
        expect(formatMonthRange('', '', 'en')).toBe('');
    });
});
