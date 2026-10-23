/**
 * Session-sheet target actions (utils/sessionTargetActions.ts) — the View /
 * Delete cards BasketListSheet renders above the item list.
 *
 * Contracts under test:
 *   · View builds the EXPLICIT stack (home tab via navigate, then the detail
 *     push) for both kinds — the finishToShopping shape, so Back is
 *     predictable.
 *   · Delete removes the TARGET itself and tears the session down (target
 *     null + bar hidden = the sheet's mount condition drops, the collapse
 *     callback fires, overlays cleared) — and on FAILURE throws with the
 *     session fully intact and the sheet untouched.
 *   · `pending-new` (lazy cart, no server row) is a no-op for both.
 */
import { viewSessionTarget, deleteSessionTarget } from "../utils/sessionTargetActions";
import { useBasketSession } from "../state/basketSession";
import { useBasketState } from "../state/basketState";
import { useTemplateAddState } from "../state/templateAddState";
import { useShoppingSheet } from "../state/shoppingSheet";
import { deleteTemplate } from "../utils/basketTemplatesApi";

// jest.mock calls are hoisted above the imports by babel-jest.
jest.mock("../utils/basketTemplatesApi", () => ({
    deleteTemplate: jest.fn(() => Promise.resolve()),
}));
jest.mock("../config/api", () => ({ API_BASE_URL: "http://test.local" }));
jest.mock("../config/user", () => ({
    getUserId: jest.fn(() => Promise.resolve("user-1")),
}));

const mockRouter = () => {
    const calls: string[] = [];
    return {
        calls,
        navigate: jest.fn((p: string) => calls.push(`navigate:${p}`)),
        push: jest.fn((p: string) => calls.push(`push:${p}`)),
    };
};

describe("viewSessionTarget (the View card's explicit stack)", () => {
    it("basket → Apsipirkimai tab, then the basket detail", () => {
        const r = mockRouter();
        viewSessionTarget({ kind: "basket", basketId: 12, isFamily: false }, r);
        expect(r.calls).toEqual(["navigate:/(tabs)/basket", "push:/basket/12"]);
    });

    it("recipe → Receptai tab, then the template detail", () => {
        const r = mockRouter();
        viewSessionTarget({ kind: "template", templateId: 7, name: "Cepelinai" }, r);
        expect(r.calls).toEqual(["navigate:/(tabs)/templates", "push:/template/7"]);
    });

    it("pending-new has no screen yet — no navigation at all", () => {
        const r = mockRouter();
        viewSessionTarget({ kind: "pending-new" }, r);
        expect(r.calls).toEqual([]);
    });
});

describe("deleteSessionTarget (the Delete card)", () => {
    const liveBasketSession = (target: any) => {
        useBasketSession.setState({ target, barVisible: true, itemCount: 3, newProductIds: [42] });
    };
    /** The sheet's mount condition (`target != null && barVisible`) is DOWN. */
    const expectSessionEnded = () => {
        const s = useBasketSession.getState();
        expect(s.target).toBeNull();
        expect(s.barVisible).toBe(false);
        expect(s.itemCount).toBe(0);
        expect(s.newProductIds).toEqual([]);
    };
    /** …or fully intact after a failure. */
    const expectSessionIntact = (target: any) => {
        const s = useBasketSession.getState();
        expect(s.target).toEqual(target);
        expect(s.barVisible).toBe(true);
        expect(s.itemCount).toBe(3);
    };

    beforeEach(() => {
        jest.clearAllMocks();
        (global as any).fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200 }));
        useBasketState.setState({ draftBasketId: 12, sessionBasketId: 12 });
        useShoppingSheet.setState({ removeTripByBasket: null });
        useTemplateAddState.setState({ templateId: null, items: [], loaded: false });
    });

    it("basket: DELETEs the basket row, ends the session, collapses the sheet, syncs legacy state", async () => {
        const target = { kind: "basket", basketId: 12, isFamily: false } as const;
        liveBasketSession(target);
        const collapse = jest.fn();
        const removeCard = jest.fn();
        useShoppingSheet.setState({ removeTripByBasket: removeCard });

        await deleteSessionTarget(target, collapse);

        expect((global as any).fetch).toHaveBeenCalledWith(
            "http://test.local/api/baskets/12", { method: "DELETE" });
        expectSessionEnded();
        expect(collapse).toHaveBeenCalled();
        // The legacy draft/session ids can't resurrect the deleted basket…
        expect(useBasketState.getState().sessionBasketId).toBeNull();
        expect(useBasketState.getState().draftBasketId).toBeNull();
        // …and a live Shopping-tab card for it animates away.
        expect(removeCard).toHaveBeenCalledWith(12);
        expect(deleteTemplate).not.toHaveBeenCalled();
    });

    it("basket: a failed DELETE throws and leaves the session intact", async () => {
        const target = { kind: "basket", basketId: 12, isFamily: false } as const;
        liveBasketSession(target);
        (global as any).fetch = jest.fn(() => Promise.resolve({ ok: false, status: 500 }));
        const collapse = jest.fn();

        await expect(deleteSessionTarget(target, collapse)).rejects.toThrow();

        expectSessionIntact(target);
        expect(collapse).not.toHaveBeenCalled();
        expect(useBasketState.getState().sessionBasketId).toBe(12);
    });

    it("recipe: deletes the template itself, clears the add-overlay, ends the session", async () => {
        const target = { kind: "template", templateId: 7, name: "Cepelinai" } as const;
        liveBasketSession(target);
        useTemplateAddState.setState({ templateId: 7, loaded: true });
        const collapse = jest.fn();

        await deleteSessionTarget(target, collapse);

        expect(deleteTemplate).toHaveBeenCalledWith(7);
        expect((global as any).fetch).not.toHaveBeenCalled(); // no basket API touched
        expectSessionEnded();
        expect(collapse).toHaveBeenCalled();
        // The recipe flow's overlay went down with the session (finishToShopping pairing).
        expect(useTemplateAddState.getState().templateId).toBeNull();
        expect(useTemplateAddState.getState().loaded).toBe(false);
    });

    it("recipe: a failed delete throws and leaves the session + overlay intact", async () => {
        const target = { kind: "template", templateId: 7, name: "Cepelinai" } as const;
        liveBasketSession(target);
        useTemplateAddState.setState({ templateId: 7, loaded: true });
        (deleteTemplate as jest.Mock).mockRejectedValueOnce(new Error("500"));
        const collapse = jest.fn();

        await expect(deleteSessionTarget(target, collapse)).rejects.toThrow();

        expectSessionIntact(target);
        expect(collapse).not.toHaveBeenCalled();
        expect(useTemplateAddState.getState().templateId).toBe(7);
    });

    it("pending-new: nothing persisted — no network, session untouched", async () => {
        const target = { kind: "pending-new" } as const;
        liveBasketSession(target);
        const collapse = jest.fn();

        await deleteSessionTarget(target, collapse);

        expect((global as any).fetch).not.toHaveBeenCalled();
        expect(deleteTemplate).not.toHaveBeenCalled();
        expect(collapse).not.toHaveBeenCalled();
        expectSessionIntact(target);
    });
});
