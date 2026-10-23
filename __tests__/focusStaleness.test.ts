/**
 * Focus-refetch staleness gate (utils/focusStaleness.ts) — used by the
 * Apsipirkimai tab so a tab switch seconds after the last fetch reuses state
 * instead of re-firing trips/household/baskets. Contract:
 *   - never fetched → fetch
 *   - focus inside the TTL window → skip
 *   - focus after the TTL window → fetch
 *   - explicit refresh (force) → fetch regardless of freshness
 */
import { shouldRefetchOnFocus, FOCUS_REFETCH_TTL_MS } from '../utils/focusStaleness';

describe('shouldRefetchOnFocus', () => {
    const T0 = 1_000_000;

    it('fetches when nothing was ever fetched', () => {
        expect(shouldRefetchOnFocus(null, { now: T0 })).toBe(true);
    });

    it('skips a focus inside the TTL window', () => {
        expect(shouldRefetchOnFocus(T0, { now: T0 + 1 })).toBe(false);
        expect(shouldRefetchOnFocus(T0, { now: T0 + FOCUS_REFETCH_TTL_MS - 1 })).toBe(false);
        // Exactly at the boundary the data is still considered fresh
        // (profileStore's `>` comparison).
        expect(shouldRefetchOnFocus(T0, { now: T0 + FOCUS_REFETCH_TTL_MS })).toBe(false);
    });

    it('refetches once the window has passed (a real absence)', () => {
        expect(shouldRefetchOnFocus(T0, { now: T0 + FOCUS_REFETCH_TTL_MS + 1 })).toBe(true);
        expect(shouldRefetchOnFocus(T0, { now: T0 + 10 * FOCUS_REFETCH_TTL_MS })).toBe(true);
    });

    it('always refetches on explicit refresh, even when fresh', () => {
        expect(shouldRefetchOnFocus(T0, { now: T0 + 1, force: true })).toBe(true);
        expect(shouldRefetchOnFocus(null, { now: T0, force: true })).toBe(true);
    });

    it('honours a custom TTL', () => {
        expect(shouldRefetchOnFocus(T0, { now: T0 + 5_000, ttlMs: 4_000 })).toBe(true);
        expect(shouldRefetchOnFocus(T0, { now: T0 + 5_000, ttlMs: 6_000 })).toBe(false);
    });

    it('defaults `now` to the wall clock', () => {
        expect(shouldRefetchOnFocus(Date.now())).toBe(false);
        expect(shouldRefetchOnFocus(Date.now() - FOCUS_REFETCH_TTL_MS - 1_000)).toBe(true);
    });
});
