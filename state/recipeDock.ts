import { create } from 'zustand';

/**
 * Receptai dock ↔ screen bridge.
 *
 * The swipe-up sheet is rendered by the TAB BAR (`BasketDockSheet`), the same
 * way the Naršyti basket chooser and the Shopping filters are, so it lives in a
 * different tree from the Receptai screen. Creating a recipe now happens
 * entirely INSIDE the dock (the create pane owns both the blank and the
 * from-a-link paths), so the only traffic left here is the screen's Android
 * back handler peeling the sheet.
 *
 * Same callback-registry shape as `shoppingSheet` and `basketSession.collapseDock`.
 */
interface RecipeDockState {
    /** Collapse the dock back to the bar — registered by the dock, called by
     *  the screen's back handler so back peels the sheet before falling
     *  through to press-back-again-to-exit. */
    collapse: (() => void) | null;
    setCollapse: (fn: (() => void) | null) => void;
    /** Dock detent: 0 collapsed, >0 expanded. Set by the dock so the screen's
     *  Android back handler knows whether there is a sheet to peel. */
    stage: number;
    setStage: (n: number) => void;
}

export const useRecipeDock = create<RecipeDockState>((set) => ({
    collapse: null,
    setCollapse: (fn) => set({ collapse: fn }),
    stage: 0,
    setStage: (n) => set({ stage: n }),
}));
