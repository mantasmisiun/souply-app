import type { TFunction } from 'i18next';

/**
 * Level catalogue. `name` is the canonical Lithuanian name and doubles as
 * the i18n fallback if a translation is missing. Use `getLevelName(level, t)`
 * for display strings so the UI follows the user's language; keep direct
 * `getLevelData(level).name` reads for non-display use (analytics, tests).
 */
export const LEVELS: { name: string; emoji: string }[] = [
    { name: 'Svogūnas',    emoji: '🧅' },
    { name: 'Bulvė',       emoji: '🥔' },
    { name: 'Burokėlis',   emoji: '🫜' },
    { name: 'Morka',       emoji: '🥕' },
    { name: 'Česnakas',    emoji: '🧄' },
    { name: 'Agurkas',     emoji: '🥒' },
    { name: 'Pomidoras',   emoji: '🍅' },
    { name: 'Kukurūzas',   emoji: '🌽' },
    { name: 'Brokolis',    emoji: '🥦' },
    { name: 'Kiaušinis',   emoji: '🥚' },
    { name: 'Duona',       emoji: '🍞' },
    { name: 'Sviestas',    emoji: '🧈' },
    { name: 'Pienas',      emoji: '🥛' },
    { name: 'Sūris',       emoji: '🧀' },
    { name: 'Dešra',       emoji: '🍖' },
    { name: 'Vištiena',    emoji: '🍗' },
    { name: 'Jautiena',    emoji: '🥩' },
    { name: 'Silkė',       emoji: '🐟' },
    { name: 'Baklažanas',  emoji: '🍆' },
    { name: 'Persikas',    emoji: '🍑' },
    { name: 'Čili',        emoji: '🌶️' },
    { name: 'Bananas',     emoji: '🍌' },
    { name: 'Riešutas',    emoji: '🥜' },
    { name: 'Pica',        emoji: '🍕' },
    { name: 'Šokoladas',   emoji: '🍫' },
    { name: 'Lašiša',      emoji: '🍣' },
    { name: 'Braškė',      emoji: '🍓' },
    { name: 'Mėlynė',      emoji: '🫐' },
    { name: 'Avokadas',    emoji: '🥑' },
    { name: 'Vynas',       emoji: '🍷' },
    { name: 'Krevetė',     emoji: '🦐' },
    { name: 'Alyvuogė',    emoji: '🫒' },
    { name: 'Omaras',      emoji: '🦞' },
    { name: 'Krabas',      emoji: '🦀' },
    { name: 'Austrė',      emoji: '🦪' },
    { name: 'Sušis',       emoji: '🍱' },
    { name: 'Viskis',      emoji: '🥃' },
    { name: 'Kaštonas',    emoji: '🌰' },
    { name: 'Mangas',      emoji: '🥭' },
    { name: 'Grybas',      emoji: '🍄' },
];

export function getLevelData(level: number): { name: string; emoji: string } {
    const idx = Math.min(Math.max(level, 1), LEVELS.length) - 1;
    return LEVELS[idx];
}

/**
 * Display-name lookup. Reads `levels.<index>` from i18n with the LT name
 * baked into LEVELS as the defaultValue, so a missing translation key
 * silently falls back to LT instead of leaking "levels.7".
 */
export function getLevelName(level: number, t: TFunction): string {
    const idx = Math.min(Math.max(level, 1), LEVELS.length) - 1;
    return t(`levels.${idx}`, { defaultValue: LEVELS[idx].name });
}
