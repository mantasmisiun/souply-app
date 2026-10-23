/**
 * Process-wide cache of shopping-list items keyed by listId. Survives the
 * ShoppingListDetail remounts that happen when switching store tabs or the
 * chips⇄unified view, so a switch can render the right items INSTANTLY (no
 * skeleton, no staggered reveal) while a background fetch refreshes them.
 *
 * Kept intentionally simple (a module Map) — it's a render seed, not a source
 * of truth; the 3-second sync and every mutation write through it.
 */
const cache = new Map<number, any[]>();

export const setCachedListItems = (listId: number, items: any[]): void => {
    cache.set(listId, items);
};

export const getCachedListItems = (listIds: number[]): any[] =>
    listIds.flatMap(id => cache.get(id) ?? []);

export const hasCachedListItems = (listIds: number[]): boolean =>
    listIds.some(id => cache.has(id));
