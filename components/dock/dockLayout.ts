import { spacing } from '../../constants/theme';

/**
 * Shared geometry for every map DockedGlassSheet (the main dock and the
 * store-options dock).
 *
 * NO horizontal padding here, on purpose: DockedGlassSheet lays the bar row
 * out at the shared PEEK inset and wraps sheet content in SheetContent (the
 * same inset), so bar and content already align — a pad here would stack on
 * top and push these two docks out of line with every other sheet (they sat
 * at 30px while the rest sat at 14).
 */

/** Bar row base — layout only; the inset is the sheet's job. */
export const dockBarBase = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: spacing.md,
};

/**
 * Invisible flex siblings that pad a DockActionRow out to the standard two-up
 * grid. A LONE action must keep exactly the width it would have with a second
 * card beside it — half the row minus half the gap, left-aligned — because a
 * full-width single card reads as a different component. Rows with two or
 * more cards already define the grid and need no padding.
 */
export const dockRowGhostSlots = (liveActionCount: number): number =>
    liveActionCount === 1 ? 1 : 0;
