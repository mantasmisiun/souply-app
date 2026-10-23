import { readSharedValue } from '../utils/sharedValue';

/**
 * "[Reanimated] Reading from `value` during component render", on every render of
 * the catalog list.
 *
 * The source looked correct — the read sat inside a `useCallback` — but this app
 * compiles with the React Compiler, which treats a `.value` read in a memoized
 * callback as a DEPENDENCY and lifts it into the render as the memo-cache key:
 *
 *     if ($[20] !== scrollOffset?.value || …) { … }   // ← during render
 *     $[20] = scrollOffset?.value;                    // ← during render
 *
 * Verified in the compiled bundle, and verified gone after this helper: the memo
 * now keys on the shared value's stable identity instead. These tests pin the
 * behaviour the call sites rely on — anything else is a compile-output concern,
 * checked by grepping the bundle for `$[n] !== x.value`.
 */
describe('readSharedValue', () => {
    test('returns the CURRENT value, not one captured earlier', () => {
        const sv = { value: 1 };
        const read = () => readSharedValue(sv);
        sv.value = 42;
        expect(read()).toBe(42);
    });

    test('tolerates an absent shared value (optional prop)', () => {
        expect(readSharedValue(undefined)).toBeUndefined();
        expect(readSharedValue(null)).toBeUndefined();
    });

    test('passes 0 through rather than collapsing it to undefined', () => {
        // The caller's guard is `cur == null`, so a legitimate 0 scroll offset
        // must survive.
        expect(readSharedValue({ value: 0 })).toBe(0);
    });
});
