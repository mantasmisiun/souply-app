/**
 * Read a Reanimated shared value from a JS callback — through a function the
 * React Compiler can't see through.
 *
 * WHY THE INDIRECTION. This project builds with the React Compiler on
 * (`transform.reactCompiler=true`). When a memoized callback's body reads
 * `sv.value`, the compiler decides the callback DEPENDS on that value and lifts
 * the read into the render as the memo-cache key:
 *
 *     if ($[20] !== scrollOffset?.value || …) { t11 = (id, screenY, height) => { … } }
 *     $[20] = scrollOffset?.value;          // ← both of these run during render
 *
 * That is exactly what Reanimated's strict mode warns about ("Reading from
 * `value` during component render"): a render-time read isn't reactive, so the
 * memo can be keyed on a stale number and the callback is rebuilt on a value
 * React never sees change. The source looked innocent — the read was inside a
 * `useCallback` — which is why the warning was hard to place.
 *
 * Behind a module-scope function the compiler sees an opaque call, keys the memo
 * on the shared value's stable IDENTITY, and the read happens where it belongs:
 * when the callback actually runs.
 */
export function readSharedValue<T>(sv?: { value: T } | null): T | undefined {
    return sv?.value;
}
