/**
 * Pure sync/search helpers for the shopping-list detail screen.
 *
 * Extracted from ShoppingListDetail so the two hot-path behaviours are unit-
 * testable on their own:
 *
 *   · mergeServerItems — the 3s poll's merge, WITH a diff-bail: when the
 *     merged result is item-for-item identical to what's already on screen it
 *     returns the PREVIOUS array unchanged, so React sees the same state
 *     reference and skips the commit entirely. Before this, every poll tick
 *     rebuilt the array from server JSON and re-rendered every layout-animated
 *     row whether anything changed or not.
 *
 *   · createDebouncedSearch — the add-product search's debounce + abort +
 *     monotonic seq guard (same shape as app/search.tsx's inline version).
 *     Typing "pienas" used to fire 5 concurrent requests with last-to-arrive
 *     wins; now only the settled query fires and only the latest response
 *     commits.
 */

/** The fields the sync/merge path cares about. The screen's ShoppingListItem
 *  extends this shape. */
export interface SyncableListItem {
    id: number;
    listId: number;
    productName: string;
    quantity: number;
    price: number | null;
    isChecked: boolean;
    l1CategoryId?: number | null;
    l2CategoryId?: number | null;
    l2CategoryName?: string | null;
    checkedByUserId?: string | null;
    checkedByName?: string | null;
    checkedByColor?: string | null;
}

// Category groups follow the Naršyti sequence — by L1 id, then L2 id (NOT
// alphabetical). Uncategorised items (no L2) sink to the bottom under "Kita".
const CAT_LAST = Number.MAX_SAFE_INTEGER;
export const sortItems = <T extends SyncableListItem>(arr: T[]): T[] =>
    arr.sort((a, b) => {
        if (a.isChecked !== b.isChecked) return Number(a.isChecked) - Number(b.isChecked);
        if (!a.isChecked) {
            const l1a = a.l2CategoryId == null ? CAT_LAST : (a.l1CategoryId ?? CAT_LAST);
            const l1b = b.l2CategoryId == null ? CAT_LAST : (b.l1CategoryId ?? CAT_LAST);
            if (l1a !== l1b) return l1a - l1b;
            const l2a = a.l2CategoryId ?? CAT_LAST;
            const l2b = b.l2CategoryId ?? CAT_LAST;
            if (l2a !== l2b) return l2a - l2b;
        }
        return a.productName.localeCompare(b.productName, 'lt');
    });

/** Cheap change fingerprint over the fields the screen renders. Two arrays
 *  with equal fingerprints would paint identically, so the merge can bail. */
export const itemsFingerprint = (arr: readonly SyncableListItem[]): string =>
    arr
        .map(i =>
            `${i.id}|${i.isChecked ? 1 : 0}|${i.quantity}|${i.price ?? ''}|` +
            `${i.checkedByUserId ?? ''}|${i.checkedByName ?? ''}|${i.l2CategoryId ?? ''}|${i.productName}`)
        .join('');

/**
 * Merge a server snapshot into the on-screen items.
 *
 *  · items the user just mutated (in-flight optimistic writes) keep their
 *    LOCAL version — the server hasn't necessarily seen the write yet;
 *  · an item pending undo-delete stays hidden;
 *  · result sorted into display order;
 *  · **diff-bail**: identical outcome → returns `prev` (same reference).
 */
export const mergeServerItems = <T extends SyncableListItem>(
    prev: T[],
    server: T[],
    opts: { inFlightIds: ReadonlySet<number>; pendingDeleteId?: number | null },
): T[] => {
    const byId = new Map<number, T>(prev.map(p => [p.id, p]));
    const merged = server.map(s => (opts.inFlightIds.has(s.id) ? (byId.get(s.id) ?? s) : s));
    const pendDel = opts.pendingDeleteId;
    const filtered = pendDel != null ? merged.filter(m => m.id !== pendDel) : merged;
    sortItems(filtered);
    if (filtered.length === prev.length && itemsFingerprint(filtered) === itemsFingerprint(prev)) {
        return prev;
    }
    return filtered;
};

/**
 * Debounced, abortable, stale-proof search runner (the app/search.tsx shape,
 * factored so both the runner and its guards are testable).
 *
 *  · each `search()` call resets the debounce timer (default 300 ms);
 *  · when the timer fires, any previous request is aborted and a new fetch
 *    runs with an AbortSignal;
 *  · a monotonic seq guard drops responses that are no longer the latest —
 *    even if an older request slips past the abort;
 *  · `cancel()` (clear/close/unmount) stops the timer, aborts, and
 *    invalidates any in-flight response.
 */
export interface DebouncedSearch {
    search: (query: string) => void;
    cancel: () => void;
}

export function createDebouncedSearch<R>(
    run: (query: string, signal: AbortSignal) => Promise<R>,
    onResults: (results: R, query: string) => void,
    debounceMs = 300,
): DebouncedSearch {
    let seq = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let ctrl: AbortController | null = null;

    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

    return {
        search(query: string) {
            clearTimer();
            const mySeq = ++seq;
            timer = setTimeout(() => {
                timer = null;
                ctrl?.abort();
                const c = new AbortController();
                ctrl = c;
                run(query, c.signal)
                    .then(results => { if (mySeq === seq) onResults(results, query); })
                    .catch(() => { /* aborted or network — stale either way */ });
            }, debounceMs);
        },
        cancel() {
            clearTimer();
            seq++;
            ctrl?.abort();
            ctrl = null;
        },
    };
}
