import { create } from 'zustand';
import { API_BASE_URL } from '../config/api';
import { getUserId } from '../config/user';

/**
 * Souply 2.0 basket-session target (user decision 2026-07-16):
 *
 *   · ONE explicit target per session (cold-start resets — the store is
 *     deliberately NOT persisted). Every add goes to it silently.
 *   · No ambiguity (no family basket, no viable previous basket) → first
 *     add auto-creates a personal draft, zero prompts.
 *   · Ambiguity (family basket exists, or a stage-1/2 personal basket
 *     exists) → the chooser sheet raises ONCE, offering at most 3 options:
 *     family / most-recent previous / new. The tapped add is QUEUED and
 *     flushed to the chosen basket.
 *   · X on the session bar hides the bar only (target survives; the next
 *     add re-summons silently). Switching targets mid-session = the
 *     chooser, reachable from the collapsed pill or the preview sheet.
 */

export interface SessionTarget {
    basketId: number;
    isFamily: boolean;
}

export interface ChooserOption {
    key: 'family' | 'previous' | 'new';
    basketId: number | null; // null = create new
    label: string;           // resolved by the host at render (i18n)
    itemCount: number;
    /** Basket's last-edit timestamp (row subtitle); null for 'new'. */
    updatedAt: string | null;
}

interface PendingAdd {
    productId: number;
    quantity: number;
    matchMode: string;
    resolve: (r: { success: boolean; message: string }) => void;
}

interface BasketSessionState {
    target: SessionTarget | null;
    barVisible: boolean;
    itemCount: number;
    chooserOpen: boolean;
    chooserOptions: ChooserOption[];
    pendingAdds: PendingAdd[];
    /** A resumable basket exists on the server but no session target is set
     *  yet (cold start). Drives the tab-bar dock's collapsed pill + re-entry. */
    dormant: { count: number } | null;
    /** Registered by the tab-bar dock: collapses it to stage 0. Browse page
     *  interactions (scroll, L1 toggle) call this so an expanded sheet gets
     *  out of the way. */
    collapseDock: (() => void) | null;
    /** Discovered chooser options (family / previous / new), published by the
     *  always-mounted host so the tab-bar dock can render them without its own
     *  discovery pass. null until the first discovery resolves. */
    dockOptions: ChooserOption[] | null;
    /** The Naršyti scroll list's ref, published so the dock's Pan can
     *  `blocksExternalGesture` it — a drag starting on the bar must expand the
     *  sheet, NOT let the list behind it steal the scroll (cross-tree, so it
     *  goes through the store). */
    browseListRef: { current: unknown } | null;
    /** Bumped on every basket mutation that happens OUTSIDE the list sheet's
     *  own steppers (an add from a product/search/L2 "Add" button). The
     *  root list sheet re-fetches its items when this changes so a freshly
     *  added product actually shows up (the counter alone was updating). */
    basketRev: number;

    setTarget: (t: SessionTarget, itemCount?: number) => void;
    setDormant: (d: { count: number } | null) => void;
    setCollapseDock: (fn: (() => void) | null) => void;
    setDockOptions: (o: ChooserOption[] | null) => void;
    setBrowseListRef: (r: { current: unknown } | null) => void;
    bumpBasketRev: () => void;
    dismissBar: () => void;
    showBar: () => void;
    bumpCount: (delta: number) => void;
    setCount: (n: number) => void;
    openChooser: (options: ChooserOption[]) => void;
    closeChooser: () => void;
    queueAdd: (a: PendingAdd) => void;
    takePending: () => PendingAdd[];
}

export const useBasketSession = create<BasketSessionState>((set, get) => ({
    target: null,
    barVisible: false,
    itemCount: 0,
    chooserOpen: false,
    chooserOptions: [],
    pendingAdds: [],
    dormant: null,
    collapseDock: null,
    dockOptions: null,
    browseListRef: null,
    basketRev: 0,

    setTarget: (t, itemCount) => set(s => ({
        target: t, barVisible: true,
        itemCount: itemCount ?? s.itemCount,
    })),
    setDormant: (d) => set({ dormant: d }),
    setCollapseDock: (fn) => set({ collapseDock: fn }),
    setDockOptions: (o) => set({ dockOptions: o }),
    setBrowseListRef: (r) => set({ browseListRef: r }),
    bumpBasketRev: () => set(s => ({ basketRev: s.basketRev + 1 })),
    dismissBar: () => set({ barVisible: false }),
    showBar: () => set({ barVisible: true }),
    bumpCount: (delta) => set(s => ({ itemCount: Math.max(0, s.itemCount + delta) })),
    setCount: (n) => set({ itemCount: Math.max(0, n) }),
    openChooser: (options) => set({ chooserOpen: true, chooserOptions: options }),
    closeChooser: () => set({ chooserOpen: false }),
    queueAdd: (a) => set(s => ({ pendingAdds: [...s.pendingAdds, a] })),
    takePending: () => {
        const p = get().pendingAdds;
        set({ pendingAdds: [] });
        return p;
    },
}));

/** POST one item to a basket; shared by the direct path and the flush. */
export const postBasketItem = async (
    basketId: number,
    productId: number,
    quantity: number,
    matchMode: string,
): Promise<{ success: boolean; message: string }> => {
    const res = await fetch(`${API_BASE_URL}/api/basket-items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ basketId, productId, quantity, matchMode }),
    });
    if (res.status === 409) return { success: false, message: 'Produktas jau yra krepšelyje' };
    if (!res.ok) return { success: false, message: 'Nepavyko pridėti produkto' };
    return { success: true, message: 'Produktas pridėtas į krepšelį' };
};

/**
 * Open the basket chooser from anywhere (tab-bar grabber, re-entry pill,
 * "Keisti krepšelį" row). Falls back to a lone "new basket" option when
 * discovery fails (offline / auth not ready) — the chooser Modal lives in
 * BasketSessionHost, mounted at the root, so this works on every surface.
 */
export const openBasketChooser = async (): Promise<void> => {
    const options = await discoverOptions().catch(() => null);
    useBasketSession.getState().openChooser(
        options ?? [{ key: 'new', basketId: null, label: '', itemCount: 0, updatedAt: null }],
    );
};

/**
 * Discover the chooser's option set (max 3):
 *   family basket (if the user's household has one) ·
 *   most-recent personal stage-1/2 basket · new.
 * Returns null when there is NO ambiguity (no family, no previous) — the
 * caller then auto-creates silently.
 */
export const discoverOptions = async (): Promise<ChooserOption[] | null> => {
    const userId = await getUserId();
    const [hhRes, basketsRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/households/mine`).then(r => {
            if (r.status === 401) throw new Error('auth-not-ready');
            return r.status === 404 ? null : r.json();
        }),
        fetch(`${API_BASE_URL}/api/baskets/user/${userId}`).then(r => {
            if (r.status === 401) throw new Error('auth-not-ready');
            return r.json();
        }),
    ]);
    const baskets: any[] = Array.isArray(basketsRes) ? basketsRes : [];
    // Family basket = a REAL family context only: the household's shared
    // basket is auto-minted at household creation, so a solo household (no
    // other members yet) shouldn't be offered a "family basket" it never
    // consciously created.
    const memberCount = Array.isArray(hhRes?.members) ? hhRes.members.length : 0;
    const familyBasketId: number | null = memberCount > 1 ? (hhRes?.sharedBasketId ?? null) : null;
    const familyRow = familyBasketId ? baskets.find(b => b.id === familyBasketId) : null;
    // Previous = most-recent PERSONAL basket still at stage 1-2 (draft or
    // compared; adding to compared reverts it — existing behavior).
    const previous = baskets
        .filter(b => b.householdId == null && (b.status === 'draft' || b.status === 'compared'))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] ?? null;

    if (!familyBasketId && !previous) return null;

    const options: ChooserOption[] = [];
    if (familyBasketId) {
        options.push({ key: 'family', basketId: familyBasketId, label: '', itemCount: Number(familyRow?.itemCount) || 0, updatedAt: familyRow?.updatedAt ?? null });
    }
    if (previous) {
        options.push({ key: 'previous', basketId: previous.id, label: '', itemCount: Number(previous.itemCount) || 0, updatedAt: previous.updatedAt ?? null });
    }
    options.push({ key: 'new', basketId: null, label: '', itemCount: 0, updatedAt: null });
    return options.slice(0, 3);
};
