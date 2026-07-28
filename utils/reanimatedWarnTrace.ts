import { devLog } from './devLog';

/**
 * DEV-ONLY: name the component behind Reanimated's
 * "Reading from `value` during component render" warning.
 *
 * The warning itself says nothing about WHERE it came from, and reading a shared
 * value during render is easy to miss in review: inside `useAnimatedStyle` /
 * `useDerivedValue` / a gesture callback it's correct, in a `useMemo` or the
 * render body it isn't — the same three characters either way. This wraps
 * console.warn, and when that message goes past it captures the JS stack (whose
 * frames are the React component functions) and ships it to the dev log.
 *
 * Deduped by stack and capped, so a warning that fires on every render of a list
 * doesn't flood anything.
 */
const seen = new Set<string>();
const MAX_REPORTS = 5;
const NEEDLE = 'Reading from `value` during component render';

export function installReanimatedWarnTrace(): void {
    if (!__DEV__) return;
    const original = console.warn;
    if ((console.warn as any).__reanimatedTraced) return;
    const wrapped = (...args: unknown[]) => {
        try {
            const first = typeof args[0] === 'string' ? args[0] : '';
            if (first.includes(NEEDLE) && seen.size < MAX_REPORTS) {
                // Frames above this wrapper are the render path — component
                // functions, in order.
                const stack = (new Error().stack ?? '')
                    .split('\n')
                    .slice(2, 16)
                    .map(l => l.trim())
                    .join(' | ');
                if (!seen.has(stack)) {
                    seen.add(stack);
                    devLog('reanimated.renderRead', { stack });
                    original('[trace] reanimated render-read stack:', stack);
                }
            }
        } catch { /* never let tracing break logging */ }
        original(...(args as []));
    };
    (wrapped as any).__reanimatedTraced = true;
    console.warn = wrapped;
}
