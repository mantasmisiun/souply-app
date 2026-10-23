/**
 * Human day-date for basket/trip cards: EN "Thu 17 Jul" · LT "Ket liepos 17".
 * Lithuanian uses the genitive month (as dates are spoken) and a 3-letter
 * weekday; English is weekday + day + short month.
 */
const LT_WEEKDAYS = ['Sek', 'Pir', 'Ant', 'Tre', 'Ket', 'Pen', 'Šeš'];
const LT_MONTHS_GENITIVE = [
    'sausio', 'vasario', 'kovo', 'balandžio', 'gegužės', 'birželio',
    'liepos', 'rugpjūčio', 'rugsėjo', 'spalio', 'lapkričio', 'gruodžio',
];

// Full weekday (title) + a 3-letter month for the compact calendar badge.
const LT_WEEKDAYS_FULL = [
    'Sekmadienis', 'Pirmadienis', 'Antradienis', 'Trečiadienis',
    'Ketvirtadienis', 'Penktadienis', 'Šeštadienis',
];
const LT_MONTHS_ABBR = ['Sau', 'Vas', 'Kov', 'Bal', 'Geg', 'Bir', 'Lie', 'Rgp', 'Rgs', 'Spa', 'Lap', 'Grd'];

function toDate(input: string | Date | null | undefined): Date | null {
    if (!input) return null;
    const d = input instanceof Date ? input : new Date(input);
    return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDayDate(input: string | Date | null | undefined, lang: string): string {
    const d = toDate(input);
    if (!d) return '';
    if (lang.toLowerCase().startsWith('lt')) {
        return `${LT_WEEKDAYS[d.getDay()]} ${LT_MONTHS_GENITIVE[d.getMonth()]} ${d.getDate()}`;
    }
    const wd = new Intl.DateTimeFormat('en', { weekday: 'short' }).format(d);
    const mon = new Intl.DateTimeFormat('en', { month: 'short' }).format(d);
    return `${wd} ${d.getDate()} ${mon}`;
}

/**
 * Full weekday + date, for compact list rows that show a title but no calendar
 * badge and still need the day to disambiguate (LT "Ketvirtadienis, liepos 16",
 * EN "Thursday, 17 Jul").
 */
export function formatWeekdayDate(input: string | Date | null | undefined, lang: string): string {
    const d = toDate(input);
    if (!d) return '';
    if (lang.toLowerCase().startsWith('lt')) {
        return `${LT_WEEKDAYS_FULL[d.getDay()]}, ${LT_MONTHS_GENITIVE[d.getMonth()]} ${d.getDate()}`;
    }
    const wd = new Intl.DateTimeFormat('en', { weekday: 'long' }).format(d);
    const mon = new Intl.DateTimeFormat('en', { month: 'short' }).format(d);
    return `${wd}, ${d.getDate()} ${mon}`;
}

/** Full weekday name for the auto-named basket title (LT "Ketvirtadienis"). */
export function formatWeekday(input: string | Date | null | undefined, lang: string): string {
    const d = toDate(input);
    if (!d) return '';
    if (lang.toLowerCase().startsWith('lt')) return LT_WEEKDAYS_FULL[d.getDay()];
    return new Intl.DateTimeFormat('en', { weekday: 'long' }).format(d);
}

/** 3-letter month for the calendar badge (LT "Lie", EN "Jul"). */
export function formatMonthAbbr(input: string | Date | null | undefined, lang: string): string {
    const d = toDate(input);
    if (!d) return '';
    if (lang.toLowerCase().startsWith('lt')) return LT_MONTHS_ABBR[d.getMonth()];
    return new Intl.DateTimeFormat('en', { month: 'short' }).format(d);
}

/** Day-of-month for the calendar badge, '' when the date is invalid. */
export function formatDayNum(input: string | Date | null | undefined): string {
    const d = toDate(input);
    return d ? String(d.getDate()) : '';
}
