/**
 * Pure logic for the recipe-create dock pane — the auto-prefill rules and the
 * "does this look like a URL yet" gate, kept out of the component so the
 * don't-clobber-user-edits contract is unit-testable.
 */

/** The name column the API enforces — truncate an imported page title to fit. */
export const MAX_TEMPLATE_NAME = 100;

/** The identity half of the pane, before it becomes a CoverDraft. */
export interface CoverFields {
    name: string;
    color: string;
    emoji: string;
}

/** Which fields the shopper has edited THEMSELVES — a later auto-prefill must
 *  never overwrite those. */
export interface CoverTouched {
    name: boolean;
    color: boolean;
    emoji: boolean;
}

export const UNTOUCHED: CoverTouched = { name: false, color: false, emoji: false };

/**
 * Fold an import preview into the current cover fields: each field takes the
 * preview's suggestion ONLY if the shopper hasn't touched it. `color` has no
 * per-recipe suggestion, so an untouched colour gets the given default (the
 * same value it started at — stated explicitly so the rule covers all three).
 */
export function mergePreviewIntoFields(
    fields: CoverFields,
    touched: CoverTouched,
    preview: { title: string; suggestedEmoji: string },
    defaultColor: string,
): CoverFields {
    return {
        name: touched.name ? fields.name : preview.title.slice(0, MAX_TEMPLATE_NAME),
        emoji: touched.emoji ? fields.emoji : preview.suggestedEmoji,
        color: touched.color ? fields.color : defaultColor,
    };
}

/**
 * Whether typed input is worth firing an import for. Deliberately strict — a
 * full scheme plus a dotted host — so the debounce can't spray requests while
 * an address is being typed by hand; anything the server would reject anyway
 * (no scheme, bare words) never leaves the device.
 */
export function looksLikeRecipeUrl(text: string): boolean {
    return /^https?:\/\/\S+\.\S{2,}/i.test(text.trim());
}
