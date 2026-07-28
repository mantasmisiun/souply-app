/**
 * DockActionRow single-card width rule (components/dock/dockLayout.ts).
 *
 * A LONE action card must keep exactly the width it would have if a second
 * card sat beside it — half the row minus half the gap, left-aligned — never
 * stretch across the whole sheet. The row pads itself with invisible flex
 * ghost slots, so the rule is layout-driven (no hardcoded widths) and holds
 * for every caller: the Receptai root's one card, a chooser row whose
 * conditional second action dropped out, the map docks with their custom gap.
 */
import { dockRowGhostSlots } from "../components/dock/dockLayout";

describe("dockRowGhostSlots (single-card width rule)", () => {
    it("a lone action gets exactly one ghost slot → two-up width, right half empty", () => {
        expect(dockRowGhostSlots(1)).toBe(1);
    });

    it("two-card rows are untouched (the standard pair defines the grid)", () => {
        expect(dockRowGhostSlots(2)).toBe(0);
    });

    it("empty rows (the row renders null) and 3+ rows are untouched", () => {
        expect(dockRowGhostSlots(0)).toBe(0);
        expect(dockRowGhostSlots(3)).toBe(0);
        expect(dockRowGhostSlots(4)).toBe(0);
    });
});
