import { useCallback, useRef, useState } from 'react';
import { type PaneSubmitControls } from '../components/recipe/RecipeCreatePane';

/**
 * Host side of the pane→bar-row submit contract.
 *
 * A sheet pane owns its submit action and its enable/busy rules, but the bar row
 * that renders the pill belongs to the HOST. The pane therefore reports upward
 * on every change — and reporting straight into `useState` is an infinite loop:
 * the pane hands over a FRESH OBJECT each render, the host re-renders because
 * the object identity changed, that re-render re-runs the pane's effect, and so
 * on ("Maximum update depth exceeded").
 *
 * This hook is the fix, in one place so neither host can reimplement it wrong:
 *   · the submit FUNCTION lives in a ref — its identity changes constantly and
 *     must never drive a render;
 *   · only the two booleans are state, and the setter returns the PREVIOUS
 *     object when they are unchanged, so React bails out of the re-render and
 *     the cycle can't start.
 *
 * `clear()` resets to the closed-pane default (disabled, idle) so a re-opened
 * pane never inherits the last one's enabled pill.
 */
export function usePaneSubmitControls() {
    const submitRef = useRef<(() => void) | null>(null);
    const [state, setState] = useState<{ disabled: boolean; busy: boolean }>({
        disabled: true,
        busy: false,
    });

    const onSubmitControls = useCallback((c: PaneSubmitControls) => {
        submitRef.current = c.submit;
        setState(prev => (
            prev.disabled === c.disabled && prev.busy === c.busy
                ? prev            // same values → same object → no re-render
                : { disabled: c.disabled, busy: c.busy }
        ));
    }, []);

    const submit = useCallback(() => { submitRef.current?.(); }, []);

    const clear = useCallback(() => {
        submitRef.current = null;
        setState(prev => (prev.disabled && !prev.busy ? prev : { disabled: true, busy: false }));
    }, []);

    return { submit, disabled: state.disabled, busy: state.busy, onSubmitControls, clear };
}
