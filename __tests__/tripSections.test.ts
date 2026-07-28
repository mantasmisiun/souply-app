/**
 * Recency bucketing for the Apsipirkimai trip sections (utils/tripSections):
 * today/yesterday precedence over the week buckets, Monday-based calendar
 * weeks, Sunday edges, month/year rollovers, DST, missing dates, future clamp,
 * and the grouping order the screen renders.
 *
 * Weekday fixtures (verified): 2026-07-27 Mon, 2026-07-29 Wed, 2026-07-26 Sun,
 * 2026-07-20 Mon, 2026-08-03 Mon, 2027-01-01 Fri, 2026-12-28 Mon.
 */
import {
    tripSectionFor, groupBySection, startOfWeekMonday, TRIP_SECTION_ORDER,
} from '../utils/tripSections';
import { parseLooseDate } from '../utils/receiptDots';

const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);
const WED = d(2026, 7, 29); // Wednesday "now" — this week Mon 07-27, last week Mon 07-20

describe('startOfWeekMonday', () => {
    it('maps every day of a week to its Monday, Sunday included', () => {
        for (let day = 27; day <= 31; day++) { // Mon..Fri
            expect(startOfWeekMonday(d(2026, 7, day))).toEqual(d(2026, 7, 27));
        }
        expect(startOfWeekMonday(d(2026, 8, 1))).toEqual(d(2026, 7, 27));  // Sat
        expect(startOfWeekMonday(d(2026, 8, 2))).toEqual(d(2026, 7, 27));  // Sun → SAME week
        expect(startOfWeekMonday(d(2026, 8, 3))).toEqual(d(2026, 8, 3));   // next Mon
    });

    it('crosses a month boundary (Wed 2026-04-01 → Mon 2026-03-30)', () => {
        expect(startOfWeekMonday(d(2026, 4, 1))).toEqual(d(2026, 3, 30));
    });
});

describe('tripSectionFor — precedence', () => {
    it('today beats thisWeek', () => {
        expect(tripSectionFor(d(2026, 7, 29), WED)).toBe('today');
    });

    it('yesterday beats thisWeek (Tue before a Wed now is in the same calendar week)', () => {
        expect(tripSectionFor(d(2026, 7, 28), WED)).toBe('yesterday');
    });

    it('yesterday beats lastWeek: Sunday before a Monday now', () => {
        const MON = d(2026, 7, 27);
        expect(tripSectionFor(d(2026, 7, 26), MON)).toBe('yesterday'); // Sun, previous calendar week
        expect(tripSectionFor(d(2026, 7, 25), MON)).toBe('lastWeek');  // Sat, two days ago
        expect(tripSectionFor(d(2026, 7, 27), MON)).toBe('today');
    });
});

describe('tripSectionFor — Monday week boundaries', () => {
    it('this week starts at Monday exactly', () => {
        expect(tripSectionFor(d(2026, 7, 27), WED)).toBe('thisWeek');  // Mon of this week
        expect(tripSectionFor(d(2026, 7, 26), WED)).toBe('lastWeek');  // Sun before it
    });

    it('last week spans its Monday..Sunday, older falls out', () => {
        expect(tripSectionFor(d(2026, 7, 20), WED)).toBe('lastWeek');  // Mon of last week
        expect(tripSectionFor(d(2026, 7, 19), WED)).toBe('earlier');   // Sun before last week
        expect(tripSectionFor(d(2026, 7, 1), WED)).toBe('earlier');
    });

    it('a Sunday trip lands in ITS Monday-based week, not the next one', () => {
        // Sun 07-26 seen from Wed 07-29: 3 days ago but PREVIOUS calendar week.
        expect(tripSectionFor(d(2026, 7, 26), WED)).toBe('lastWeek');
        // Sun 08-02 is the tail of the CURRENT week (future) → thisWeek.
        expect(tripSectionFor(d(2026, 8, 2), WED)).toBe('thisWeek');
    });
});

describe('tripSectionFor — rollovers', () => {
    it('month rollover: Fri Jul 31 seen from Mon Aug 3 is lastWeek', () => {
        const MON_AUG3 = d(2026, 8, 3);
        expect(tripSectionFor(d(2026, 8, 2), MON_AUG3)).toBe('yesterday'); // Sun Aug 2
        expect(tripSectionFor(d(2026, 7, 31), MON_AUG3)).toBe('lastWeek'); // Fri Jul 31
        expect(tripSectionFor(d(2026, 7, 27), MON_AUG3)).toBe('lastWeek'); // Mon Jul 27
        expect(tripSectionFor(d(2026, 7, 26), MON_AUG3)).toBe('earlier');  // Sun Jul 26
    });

    it('year rollover: New Year Friday still sees December correctly', () => {
        const FRI_JAN1 = d(2027, 1, 1); // this week Mon 2026-12-28, last week Mon 12-21
        expect(tripSectionFor(d(2027, 1, 1), FRI_JAN1)).toBe('today');
        expect(tripSectionFor(d(2026, 12, 31), FRI_JAN1)).toBe('yesterday');
        expect(tripSectionFor(d(2026, 12, 28), FRI_JAN1)).toBe('thisWeek');
        expect(tripSectionFor(d(2026, 12, 27), FRI_JAN1)).toBe('lastWeek');
        expect(tripSectionFor(d(2026, 12, 21), FRI_JAN1)).toBe('lastWeek');
        expect(tripSectionFor(d(2026, 12, 20), FRI_JAN1)).toBe('earlier');
    });

    it('DST spring-forward day (LT 2026-03-29) still counts as exactly yesterday', () => {
        expect(tripSectionFor(d(2026, 3, 29), d(2026, 3, 30))).toBe('yesterday');
    });
});

describe('tripSectionFor — missing/unparseable/future', () => {
    it('null, undefined and NaN dates sink to earlier', () => {
        expect(tripSectionFor(null, WED)).toBe('earlier');
        expect(tripSectionFor(undefined, WED)).toBe('earlier');
        expect(tripSectionFor(new Date(NaN), WED)).toBe('earlier');
    });

    it('parseLooseDate feeds it as the screen does', () => {
        expect(tripSectionFor(parseLooseDate('2026-07-29 14:32'), WED)).toBe('today');
        expect(tripSectionFor(parseLooseDate('2026.07.28'), WED)).toBe('yesterday');
        expect(tripSectionFor(parseLooseDate(null), WED)).toBe('earlier');
    });

    it('future dates clamp into thisWeek (no "later" bucket)', () => {
        expect(tripSectionFor(d(2026, 7, 30), WED)).toBe('thisWeek');  // tomorrow
        expect(tripSectionFor(d(2026, 9, 15), WED)).toBe('thisWeek');  // far future
    });
});

describe('groupBySection', () => {
    type T = { id: number; date: string | null };
    const dateOf = (t: T) => parseLooseDate(t.date);

    it('emits non-empty buckets in render order, input order kept inside', () => {
        const items: T[] = [
            { id: 1, date: '2026-07-19' }, // earlier
            { id: 2, date: '2026-07-29' }, // today
            { id: 3, date: '2026-07-26' }, // lastWeek (Sunday)
            { id: 4, date: '2026-07-28' }, // yesterday
            { id: 5, date: '2026-07-29' }, // today
            { id: 6, date: null },         // earlier
        ];
        const groups = groupBySection(items, dateOf, WED);
        expect(groups.map(g => g.section)).toEqual(['today', 'yesterday', 'lastWeek', 'earlier']);
        expect(groups[0].items.map(i => i.id)).toEqual([2, 5]);
        expect(groups[3].items.map(i => i.id)).toEqual([1, 6]);
    });

    it('empty input → no buckets at all (no empty outlined boxes)', () => {
        expect(groupBySection([], dateOf, WED)).toEqual([]);
    });

    it('order constant covers every section exactly once', () => {
        expect([...TRIP_SECTION_ORDER].sort()).toEqual(
            ['earlier', 'lastWeek', 'thisWeek', 'today', 'yesterday'].sort());
    });
});
