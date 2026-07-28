import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
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

/**
 * The session collects into EITHER a basket or a template — same browse +
 * list-sheet mechanic, different persistence layer. `kind` discriminates;
 * consumers branch on it (fetch/add/label) rather than assuming a basket.
 */
export type SessionTarget =
    | { kind: 'basket'; basketId: number; isFamily: boolean }
    | { kind: 'template'; templateId: number; name?: string }
    /** LAZY basket (industry-standard cart semantics): "Add new" picked but
     *  nothing added yet — NO server row exists. The first successful add
     *  mints the real basket and swaps the target to it; abandoning the
     *  session leaves zero ghosts (the sentinel dies with the process). */
    | { kind: 'pending-new' };

/** Stable identity for a target across renders (kind + id). */
export const targetKey = (t: SessionTarget): string =>
    t.kind === 'basket' ? `b${t.basketId}` : t.kind === 'template' ? `t${t.templateId}` : 'new';

export interface ChooserOption {
    key: 'family' | 'previous' | 'new' | 'template';
    basketId: number | null; // null = create new
    /** Set for key 'template' — the session targets a template instead. */
    templateId?: number | null;
    /** Template name (key 'template') or a user-given basket name — a
     *  rename wins over the date title on chooser rows. */
    name?: string | null;
    label: string;           // resolved by the host at render (i18n)
    itemCount: number;
    /** Basket's last-edit timestamp (row subtitle); null for 'new'. */
    updatedAt: string | null;
    /** Up to 5 recent product names (newest-first) for the row's preview line. */
    itemPreview?: string[];
}

/** Chooser option for a JUST-CREATED template (0 items). The dock's create
 *  paths feed this straight to `applyChooserPick`, so a fresh recipe is
 *  targeted — and queued adds are flushed into it — through the exact same
 *  pick path an existing one takes. */
export const templateChooserOption = (t: { id: number; name: string }): ChooserOption => ({
    key: 'template', templateId: t.id, name: t.name,
    basketId: null, itemCount: 0, label: t.name, updatedAt: null,
});

/** Split the API's `~|~`-joined preview into a name list (newest-first). */
const parsePreview = (raw: unknown): string[] =>
    typeof raw === 'string' && raw.length > 0 ? raw.split('~|~').filter(Boolean) : [];

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
    /** Discovered template rows for the chooser's Templates section. */
    dockTemplates: ChooserOption[] | null;
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
    /** Product ids added to the target DURING this session (via the browse
     *  Add flow). The list sheet badges them "New" so a resumed basket's
     *  pre-existing items are visually distinct from what was just added.
     *  Cleared whenever a fresh session target is set. */
    newProductIds: number[];
    /** Nonce bumped to ask the tab-bar dock to expand its chooser sheet to
     *  the medium detent (the "raise the Baskets sheet on Add" flow). A nonce
     *  (not a bool) so it fires even when the value would repeat, and the dock
     *  reacts via an effect once it actually has the sheet mounted. */
    dockExpandRequest: number;
    /** Collapsed-dock top from the screen bottom, published by the floating
     *  docks. `tabBar` = the always-present pill bar; `session` = the taller
     *  session bar (null when no session). useSafeBottomTabBarHeight pads
     *  screens by whichever is the visible bottom bar. */
    tabBarClearance: number;
    sessionBarClearance: number | null;

    setTarget: (t: SessionTarget, itemCount?: number) => void;
    /** End the basket session (basket graduated to a list / was deleted). */
    clearTarget: () => void;
    /** End the session for ANY target kind — the session-bar "Parduotuvės ›"
     *  turned a recipe into a real basket, so the collecting session is over.
     *  clearTarget can't be used for this: it deliberately spares templates
     *  (its callers are basket self-heal paths that must not kill a template
     *  session mid-add). */
    endSession: () => void;
    setDormant: (d: { count: number } | null) => void;
    setCollapseDock: (fn: (() => void) | null) => void;
    setDockOptions: (o: ChooserOption[] | null) => void;
    setDockTemplates: (o: ChooserOption[] | null) => void;
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
    /** Release queued adds as no-ops (chooser dismissed without a pick). */
    cancelPending: () => void;
    /** Mark a product id as added this session (drives the "New" badge). */
    markNewProduct: (productId: number) => void;
    /** Ask the tab-bar dock to raise its chooser sheet to medium. */
    requestDockExpand: () => void;
    setTabBarClearance: (px: number) => void;
    setSessionBarClearance: (px: number | null) => void;
    /** A transient user-facing notice from the add flow (e.g. "already in this
     *  basket" when a resumed basket already holds the product). The root
     *  BasketSessionHost surfaces it as a toast; the nonce re-fires it even
     *  when the same message repeats. `key` is an i18n key. */
    addNotice: { key: string; nonce: number } | null;
    setAddNotice: (key: string) => void;
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
    dockTemplates: null,
    browseListRef: null,
    basketRev: 0,
    newProductIds: [],
    dockExpandRequest: 0,
    tabBarClearance: 0,
    sessionBarClearance: null,

    // A fresh target starts a fresh session → the "New" set resets so a
    // resumed basket's pre-existing items don't inherit stale badges.
    setTarget: (t, itemCount) => set(s => ({
        target: t, barVisible: true,
        itemCount: itemCount ?? s.itemCount,
        newProductIds: [],
    })),
    // End the active basket session entirely — the basket graduated to a
    // shopping list (inProgress/completed) or was deleted, so it must stop
    // driving catalog steppers and the session sheet. (dismissBar only HIDES
    // the bar but keeps the target, which is why a done basket still painted
    // steppers.) Templates are unaffected.
    clearTarget: () => set(s => (
        s.target == null || s.target.kind === 'template'
            ? s
            : { target: null, barVisible: false, itemCount: 0, newProductIds: [] }
    )),
    endSession: () => set({ target: null, barVisible: false, itemCount: 0, newProductIds: [] }),
    setDormant: (d) => set({ dormant: d }),
    setCollapseDock: (fn) => set({ collapseDock: fn }),
    setDockOptions: (o) => set({ dockOptions: o }),
    setDockTemplates: (o) => set({ dockTemplates: o }),
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
    // The chooser was dismissed without a pick — release every queued add as a
    // no-op so the waiting Add buttons revert (spinner off) instead of hanging.
    cancelPending: () => {
        const p = get().pendingAdds;
        set({ pendingAdds: [] });
        p.forEach(a => a.resolve({ success: false, message: '' }));
    },
    markNewProduct: (productId) => set(s => (
        s.newProductIds.includes(productId)
            ? s
            : { newProductIds: [...s.newProductIds, productId] }
    )),
    requestDockExpand: () => set(s => ({ dockExpandRequest: s.dockExpandRequest + 1 })),
    setTabBarClearance: (px) => set(s => (s.tabBarClearance === px ? s : { tabBarClearance: px })),
    setSessionBarClearance: (px) => set(s => (s.sessionBarClearance === px ? s : { sessionBarClearance: px })),
    addNotice: null,
    setAddNotice: (key) => set(s => ({ addNotice: { key, nonce: (s.addNotice?.nonce ?? 0) + 1 } })),
}));

/** Result of an add; `already` = the product was already in the basket (409),
 *  treated as success (the desired end-state — product present — holds) but
 *  flagged so callers skip the optimistic count/new-badge bump. */
export interface AddItemResult { success: boolean; message: string; already?: boolean }

/** POST one item to a basket; shared by the direct path and the flush. */
export const postBasketItem = async (
    basketId: number,
    productId: number,
    quantity: number,
    matchMode: string,
): Promise<AddItemResult> => {
    const res = await fetch(`${API_BASE_URL}/api/basket-items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ basketId, productId, quantity, matchMode }),
    });
    // 409 = already in this basket. Idempotent: the item IS present, so the add
    // succeeded in intent. Returning success (not a failure) stops the silent
    // rollback / "already in basket" toast when a cold-start add resumes a
    // basket that happens to hold that product; a basketRev refresh then shows
    // the real stepper. `already` lets callers skip the count bump.
    if (res.status === 409) return { success: true, already: true, message: 'Produktas jau yra krepšelyje' };
    if (!res.ok) return { success: false, message: 'Nepavyko pridėti produkto' };
    // The server reverts a PRICED ('compared') basket to draft when it's edited,
    // which invalidates the store results computed for it — drop the caches so
    // the map recalculates instead of showing prices that predate this item.
    try {
        const body = await res.json().catch(() => null);
        if (body?.revertedToDraft) await dropCachedBasketResults(basketId);
    } catch { /* the add itself succeeded — cache cleanup is best-effort */ }
    return { success: true, message: 'Produktas pridėtas į krepšelį' };
};

/** Forget a basket's calculated store results + calc meta (origin/settings
 *  snapshot). Called whenever an edit invalidates them. */
export const dropCachedBasketResults = async (basketId: number | string): Promise<void> => {
    try {
        await AsyncStorage.multiRemove([`basket_results_${basketId}`, `basket_calc_meta_${basketId}`]);
    } catch { /* non-fatal */ }
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
    // Recent PERSONAL baskets (draft/compared), most-recent first. The 2.0
    // chooser keeps EACH as its own resumable row so a "new"-created basket
    // sits alongside the one it superseded — until the older one ages past 48h
    // (then it's dropped from the chooser). Fail-open on unparseable dates so a
    // date-format quirk never hides a live basket. Capped so the sheet stays
    // compact.
    const CUTOFF = Date.now() - 48 * 60 * 60 * 1000;
    const recents = baskets
        .filter(b => b.householdId == null && (b.status === 'draft' || b.status === 'compared'))
        .filter(b => { const t = Date.parse(String(b.updatedAt)); return isNaN(t) || t >= CUTOFF; })
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, 5);

    if (!familyBasketId && recents.length === 0) return null;

    const options: ChooserOption[] = [];
    if (familyBasketId) {
        options.push({ key: 'family', basketId: familyBasketId, label: '', name: familyRow?.name ?? null, itemCount: Number(familyRow?.itemCount) || 0, updatedAt: familyRow?.updatedAt ?? null, itemPreview: parsePreview(familyRow?.itemPreview) });
    }
    for (const b of recents) {
        options.push({ key: 'previous', basketId: b.id, label: '', name: b.name ?? null, itemCount: Number(b.itemCount) || 0, updatedAt: b.updatedAt ?? null, itemPreview: parsePreview(b.itemPreview) });
    }
    options.push({ key: 'new', basketId: null, label: '', itemCount: 0, updatedAt: null });
    return options;
};

/**
 * Discover the user's templates for the chooser's Templates section — each a
 * resumable 'template' row (icon+count, name title, product-name preview).
 * Returns [] on any failure so the section just renders empty.
 */
export const discoverTemplates = async (): Promise<ChooserOption[]> => {
    try {
        const userId = await getUserId();
        const res = await fetch(`${API_BASE_URL}/api/basket-templates/user/${userId}`);
        if (!res.ok) return [];
        const rows: any[] = await res.json();
        if (!Array.isArray(rows)) return [];
        return rows.map(t => ({
            key: 'template' as const,
            basketId: null,
            templateId: Number(t.id),
            name: t.name ?? null,
            label: '',
            itemCount: Number(t.itemCount) || 0,
            updatedAt: t.updatedAt ?? null,
            itemPreview: parsePreview(t.itemPreview),
        }));
    } catch {
        return [];
    }
};
