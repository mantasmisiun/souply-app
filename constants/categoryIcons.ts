/**
 * L1 category → emoji, keyed by the CANONICAL Lithuanian `Category.name`
 * (the server's `nameKey` field — stable across UI locales). Single source
 * for every surface that shows an L1 emoji (Naršyti's category list, the
 * discounts screen's category filter), so the two can never drift.
 *
 * Not to be confused with `categoryEmojis.ts` — the legacy per-LEAF-category
 * map used by the spending breakdown.
 */
export const CATEGORY_ICONS: Record<string, string> = {
    'Daržovės ir vaisiai': '🫜',
    'Pieno gaminiai, kiaušiniai ir majonezas': '🥛',
    'Duonos gaminiai ir konditerija': '🍞',
    'Mėsa, žuvis ir kulinarija': '🥩',
    'Bakalėja': '🫙',
    'Šaldytas maistas': '🧊',
    'Gėrimai': '🥤',
    'Kūdikių ir vaikų prekės': '🍼',
    'Kosmetika ir higiena': '🧴',
    'Švaros ir gyvūnų prekės': '🧹',
    'Namai ir laisvalaikis': '🏠',
};

/** The browse list's exact lookup rule: canonical key first, 📦 fallback. */
export const categoryIcon = (nameKey?: string | null, name?: string | null): string =>
    CATEGORY_ICONS[nameKey ?? name ?? ''] || '📦';
