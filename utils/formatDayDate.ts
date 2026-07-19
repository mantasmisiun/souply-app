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

export function formatDayDate(input: string | Date | null | undefined, lang: string): string {
    if (!input) return '';
    const d = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(d.getTime())) return '';
    if (lang.toLowerCase().startsWith('lt')) {
        return `${LT_WEEKDAYS[d.getDay()]} ${LT_MONTHS_GENITIVE[d.getMonth()]} ${d.getDate()}`;
    }
    const wd = new Intl.DateTimeFormat('en', { weekday: 'short' }).format(d);
    const mon = new Intl.DateTimeFormat('en', { month: 'short' }).format(d);
    return `${wd} ${d.getDate()} ${mon}`;
}
