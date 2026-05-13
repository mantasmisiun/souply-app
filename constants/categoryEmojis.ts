/**
 * Category-name → emoji map used by C3 (per-category spending breakdown).
 *
 * Keyed by lowercased Lithuanian category name so we don't have to track
 * server-side category IDs in the app. The server's match endpoint
 * returns `categoryName` on each `altMatches[]` entry (see the JOIN
 * Category in storeProductModel.ts), so this map is the only place the
 * emoji decision lives on the client.
 *
 * Anything not in this map falls back to `❓` — C3 still renders the row
 * with the category name + "❓" so new server-side categories don't break
 * the UI; they just look a touch less polished until this map is
 * extended.
 *
 * To extend: confirm the exact server-side `Category.name` value
 * (`SELECT DISTINCT name FROM Category`) before adding a row — drift
 * between the two strings means the emoji silently won't apply.
 *
 * Migration path: when there are enough categories that this map is a
 * pain to maintain, move to a server-side `Category.emoji` column.
 * Mobile then becomes `category.emoji ?? CATEGORY_EMOJIS[name] ?? '❓'`,
 * keeping this file as a fallback.
 */

const CATEGORY_EMOJIS: Record<string, string> = {
    // Dairy + eggs
    "pieno produktai": "🥛",
    "sūris": "🧀",
    "kiaušiniai": "🥚",

    // Meat / fish
    "mėsa": "🥩",
    "mėsos gaminiai": "🥓",
    "paukštiena": "🍗",
    "žuvis": "🐟",
    "žuvies gaminiai": "🐟",
    "jūros gėrybės": "🦐",

    // Fresh produce
    "vaisiai": "🍎",
    "daržovės": "🥬",
    "daržovės ir vaisiai": "🥕",
    "uogos": "🍓",
    "žalumynai": "🌿",

    // Bakery + grains
    "duona ir kepiniai": "🍞",
    "duona": "🍞",
    "kepiniai": "🥐",
    "bakalėja": "🌾",
    "kruopos": "🌾",
    "makaronai": "🍝",
    "ryžiai": "🍚",
    "miltai": "🌾",
    "sausi pusryčiai": "🥣",

    // Pantry
    "konservai": "🥫",
    "aliejus": "🫒",
    "aliejus ir actas": "🫒",
    "padažai": "🥫",
    "prieskoniai": "🧂",
    "cukrus ir saldikliai": "🧂",

    // Sweets + snacks
    "saldainiai": "🍬",
    "saldumynai": "🍬",
    "šokoladas": "🍫",
    "sausainiai": "🍪",
    "užkandžiai": "🥨",
    "ledai": "🍦",

    // Drinks
    "gėrimai": "🥤",
    "nealkoholiniai gėrimai": "🥤",
    "vanduo": "💧",
    "sultys": "🧃",
    "kava ir arbata": "☕",
    "kava": "☕",
    "arbata": "🍵",
    "alkoholiniai gėrimai": "🍷",
    "alus": "🍺",
    "vynas": "🍷",

    // Frozen
    "šaldyti produktai": "🧊",

    // Non-food
    "higiena": "🧴",
    "kūno priežiūra": "🧴",
    "buities chemija": "🧽",
    "skalbimo priemonės": "🧺",
    "augintiniams": "🐾",
    "vaikams": "👶",
    "kūdikiams": "🍼",

    // Catch-all
    "nepriskirta": "❓",
};

/**
 * Look up a category's emoji by name. Case-insensitive; trims surrounding
 * whitespace defensively. Returns ❓ for unknown categories so the caller
 * can render the row consistently without a null check.
 */
export function categoryEmoji(name: string | null | undefined): string {
    if (!name) return "❓";
    const key = name.trim().toLowerCase();
    return CATEGORY_EMOJIS[key] ?? "❓";
}
