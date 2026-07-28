/**
 * Catalog-dock recipe create → the session-bar landing.
 *
 * The catalog pane's Sukurti (blank/manual path) creates the template and
 * hands it — as templateChooserOption(created) — to applyChooserPick, the
 * chooser's own template-pick path. The contract under test: the catalog does
 * NOT navigate anywhere; the new recipe becomes the ACTIVE session target
 * (BasketListSheet's bar: ✕ Prekės: 0 · Parduotuvės ›), the dock collapses,
 * and any adds queued behind the chooser flush into the fresh recipe.
 */
import { applyChooserPick } from "../utils/basketUtils";
import { useBasketSession, templateChooserOption } from "../state/basketSession";
import { addTemplateItem } from "../utils/basketTemplatesApi";

// jest.mock calls are hoisted above the imports by babel-jest.
jest.mock("../utils/basketTemplatesApi", () => ({
    addTemplateItem: jest.fn(() => Promise.resolve({ id: 501 })),
}));
jest.mock("../config/api", () => ({ API_BASE_URL: "http://test.local" }));
jest.mock("../config/user", () => ({
    getUserId: jest.fn(() => Promise.resolve("user-1")),
}));

const resetSession = () => {
    useBasketSession.setState({
        target: null,
        barVisible: false,
        itemCount: 99, // deliberately stale — the pick must reset it to the option's 0
        pendingAdds: [],
        collapseDock: null,
        newProductIds: [],
    });
};

describe("catalog recipe create landing (templateChooserOption → applyChooserPick)", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        resetSession();
    });

    it("templateChooserOption builds a zero-item template pick", () => {
        expect(templateChooserOption({ id: 12, name: "Šaltibarščiai" })).toEqual({
            key: "template",
            templateId: 12,
            name: "Šaltibarščiai",
            basketId: null,
            itemCount: 0,
            label: "Šaltibarščiai",
            updatedAt: null,
        });
    });

    it("blank create lands as the active session target with 0 items, dock collapsed", async () => {
        const collapse = jest.fn();
        useBasketSession.setState({ collapseDock: collapse });

        await applyChooserPick(templateChooserOption({ id: 7, name: "Cepelinai" }), jest.fn());

        const s = useBasketSession.getState();
        // The session bar's exact inputs: a template target, visible bar, count 0.
        expect(s.target).toEqual({ kind: "template", templateId: 7, name: "Cepelinai" });
        expect(s.barVisible).toBe(true);
        expect(s.itemCount).toBe(0);
        // The sheet collapses so the catalog underneath shows the session bar.
        expect(collapse).toHaveBeenCalled();
        // No basket-side API was touched for a template pick.
        expect(addTemplateItem).not.toHaveBeenCalled();
    });

    it("adds queued behind the chooser flush into the fresh recipe", async () => {
        const resolve = jest.fn();
        useBasketSession.setState({
            pendingAdds: [{ productId: 42, quantity: 2, matchMode: "exact", resolve }],
        });

        await applyChooserPick(templateChooserOption({ id: 9, name: "Kugelis" }), jest.fn());

        expect(addTemplateItem).toHaveBeenCalledWith(9, { productId: 42, quantity: 2 });
        expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
        const s = useBasketSession.getState();
        expect(s.target).toEqual({ kind: "template", templateId: 9, name: "Kugelis" });
        expect(s.itemCount).toBe(1); // 0 from the fresh option + 1 flushed add
    });
});
