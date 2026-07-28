/**
 * Focus-refetch staleness gate — the shape of profileStore's
 * `fetchProfileIfStale`, extracted for screens whose fetch state is local.
 *
 * A tab screen refetching on every `useFocusEffect` burns its requests (and
 * the setState re-render) even when the data is seconds old — with
 * `freezeOnBlur` every tab switch lands the full cost. The gate answers
 * "should this focus hit the network?"; explicit refreshes (pull-to-refresh,
 * a mutation on the screen, a background-completion signal) must NOT go
 * through it — they call the fetch directly, or pass `force`.
 */
export const FOCUS_REFETCH_TTL_MS = 30_000;

export function shouldRefetchOnFocus(
    lastFetchedAt: number | null,
    opts: { force?: boolean; ttlMs?: number; now?: number } = {},
): boolean {
    const { force = false, ttlMs = FOCUS_REFETCH_TTL_MS, now = Date.now() } = opts;
    if (force) return true;
    return lastFetchedAt == null || now - lastFetchedAt > ttlMs;
}
