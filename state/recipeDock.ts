import { create } from 'zustand';

/**
 * Receptai dock ↔ screen bridge.
 *
 * The swipe-up sheet is rendered by the TAB BAR (`BasketDockSheet`), the same
 * way the Naršyti basket chooser and the Shopping filters are, so it lives in a
 * different tree from the Receptai screen. The screen already owns both ways to
 * start a recipe — the cover editor for a blank one, the URL sheet for an
 * imported one — so the dock does not duplicate them: it registers nothing and
 * only asks.
 *
 * Same callback-registry shape as `shoppingSheet` and `basketSession.collapseDock`.
 */
interface RecipeDockState {
    /** Start a blank recipe (opens the cover editor). Registered by the screen. */
    startBlank: (() => void) | null;
    setStartBlank: (fn: (() => void) | null) => void;
    /** Start from a pasted link (opens the URL sheet). Registered by the screen. */
    startFromUrl: (() => void) | null;
    setStartFromUrl: (fn: (() => void) | null) => void;
    /** Collapse the dock back to the bar — registered by the dock, called by the
     *  screen so a chosen action doesn't leave the sheet hanging open behind it. */
    collapse: (() => void) | null;
    setCollapse: (fn: (() => void) | null) => void;
    /** Dock detent: 0 collapsed, >0 expanded. Set by the dock so the screen's
     *  Android back handler can peel the sheet before falling through to
     *  press-back-again-to-exit. */
    stage: number;
    setStage: (n: number) => void;
}

export const useRecipeDock = create<RecipeDockState>((set) => ({
    startBlank: null,
    setStartBlank: (fn) => set({ startBlank: fn }),
    startFromUrl: null,
    setStartFromUrl: (fn) => set({ startFromUrl: fn }),
    collapse: null,
    setCollapse: (fn) => set({ collapse: fn }),
    stage: 0,
    setStage: (n) => set({ stage: n }),
}));
