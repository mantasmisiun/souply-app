/**
 * Recency bucketing for the Apsipirkimai trip list: Today / Yesterday /
 * This week / Last week / Earlier. Pure date arithmetic — the screen feeds it
 * `parseLooseDate(trip.anchorDate)` and renders one sliced-border section per
 * non-empty bucket (same per-row border slicing as the Archyvas box).
 *
 * Rules:
 * - Local time throughout; weeks are CALENDAR weeks starting Monday (LT).
 * - Today/Yesterday take precedence over the week buckets — yesterday never
 *   also shows under "this week" even though it usually falls inside it.
 * - Missing/unparseable dates sink to 'earlier': with no evidence of recency
 *   the only honest claim is the bottom bucket.
 * - Future dates (a trip planned ahead) clamp into 'thisWeek' — the topmost
 *   week bucket — rather than minting a "later" section for a rare edge.
 */

export type TripSection = 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'earlier';

/** Render order of the buckets, top to bottom. */
export const TRIP_SECTION_ORDER: readonly TripSection[] = [
    'today', 'yesterday', 'thisWeek', 'lastWeek', 'earlier',
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local midnight of d. */
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Monday 00:00 (local) of the calendar week containing d. */
export function startOfWeekMonday(d: Date): Date {
    const s = dayStart(d);
    const mondayOffset = (s.getDay() + 6) % 7; // Mon=0 … Sun=6
    return new Date(s.getFullYear(), s.getMonth(), s.getDate() - mondayOffset);
}

/** Bucket one date. `now` is injectable for tests; defaults to the real clock. */
export function tripSectionFor(date: Date | null | undefined, now: Date = new Date()): TripSection {
    if (!date || Number.isNaN(date.getTime())) return 'earlier';
    const today = dayStart(now);
    const day = dayStart(date);
    // Round, not truncate: a DST-shifted 23/25-hour day still counts as 1.
    const daysAgo = Math.round((today.getTime() - day.getTime()) / DAY_MS);
    if (daysAgo === 0) return 'today';
    if (daysAgo === 1) return 'yesterday';
    const thisMonday = startOfWeekMonday(today);
    if (day.getTime() >= thisMonday.getTime()) return 'thisWeek'; // incl. future clamp
    const lastMonday = new Date(
        thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - 7);
    if (day.getTime() >= lastMonday.getTime()) return 'lastWeek';
    return 'earlier';
}

/** Group items into non-empty buckets, bucket render order, input order kept
 *  within a bucket. Empty buckets are simply absent — no empty boxes. */
export function groupBySection<T>(
    items: readonly T[],
    dateOf: (item: T) => Date | null | undefined,
    now: Date = new Date(),
): { section: TripSection; items: T[] }[] {
    const buckets = new Map<TripSection, T[]>();
    for (const item of items) {
        const section = tripSectionFor(dateOf(item), now);
        const arr = buckets.get(section);
        if (arr) arr.push(item); else buckets.set(section, [item]);
    }
    return TRIP_SECTION_ORDER
        .filter(s => buckets.has(s))
        .map(s => ({ section: s, items: buckets.get(s)! }));
}
