import { create } from 'zustand';
import type { HouseholdInfo } from '../utils/tripsApi';

/**
 * Shopping-tab sheet ↔ screen bridge (shared/SMART_BASKET_SPEC.md §1).
 *
 * The Shopping DOCK SHEET (pill on the tab bar) owns the date + status
 * filters, the family/household section and the "AI Basket" flow; the
 * Shopping SCREEN owns the trips list. This store carries the filter state
 * down and the screen's data/callbacks up — same callback-registry pattern
 * as basketSession.collapseDock.
 */
interface ShoppingSheetState {
    /** Single-day trips filter (null = show everything). */
    selectedDate: Date | null;
    setSelectedDate: (d: Date | null) => void;
    /** Trip STAGE filter: null = all; otherwise the allowed stage numbers
     *  (1..5 — the sheet's 4 status options map onto stage sets). */
    selectedStages: Set<number> | null;
    setSelectedStages: (s: Set<number> | null) => void;
    /** The sheet's checked status-option ids (UI state — survives the sheet
     *  unmounting on tab switches). null = All. */
    statusIds: Set<number> | null;
    setStatusIds: (s: Set<number> | null) => void;
    /** "YYYY-MM-DD" → chain dot colours for the calendar (screen-computed). */
    dotMap: Map<string, string[]>;
    setDotMap: (m: Map<string, string[]>) => void;
    /** Current household (null = none) — the family section renders from it. */
    household: HouseholdInfo | null;
    setHousehold: (h: HouseholdInfo | null) => void;
    /** Re-fetch trips + household (after create/join/leave/generate). */
    refreshTrips: (() => void) | null;
    setRefreshTrips: (fn: (() => void) | null) => void;
}

export const useShoppingSheet = create<ShoppingSheetState>((set) => ({
    selectedDate: null,
    setSelectedDate: (d) => set({ selectedDate: d }),
    selectedStages: null,
    setSelectedStages: (s) => set({ selectedStages: s }),
    statusIds: null,
    setStatusIds: (s) => set({ statusIds: s }),
    dotMap: new Map(),
    setDotMap: (m) => set({ dotMap: m }),
    household: null,
    setHousehold: (h) => set({ household: h }),
    refreshTrips: null,
    setRefreshTrips: (fn) => set({ refreshTrips: fn }),
}));
