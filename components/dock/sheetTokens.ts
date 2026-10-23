import { spacing } from '../../constants/theme';
import { concentricRadius } from '../../utils/displayCorners';

/**
 * THE sheet-surface tokens — the numbers every glass sheet (DockedGlassSheet,
 * GlassSheet, GlassStageSheet) is built from. ONE home, on purpose: each of
 * these existed as a per-component constant and every copy that drifted became
 * a reported defect ("content padding doesn't match", "shadow is clipped").
 *
 * Sheets and sheet CONTENT must never re-declare these values. Content gets
 * them automatically via `SheetContent` (rendered by the sheet components
 * themselves) — a call site should not even know they exist.
 */

/**
 * The dock's ONE inset: the slim grabber strip above the bar row AND the
 * horizontal inset of both the bar row and the sheet content. The bar row is
 * laid out at `left/right: SHEET_PEEK`, and `SheetContent` pads content by the
 * same value, so a sheet's content edges always line up with its title row.
 */
export const SHEET_PEEK = 14;

/**
 * The radius of SheetCard's soft boxShadow halo — how far the shadow bleeds
 * past the card box on every side. It renders OUTSIDE the card's bounds, so
 * any ancestor with `overflow: 'hidden'` (a sheet's scroll viewport, an
 * animated pager) slices the halo unless it reserves at least this much room
 * past the card. `SheetContent` reserves it top and bottom; `SheetCard`'s
 * shadow blur reads the same constant, so reserve and halo can never drift.
 */
export const SHEET_CARD_SHADOW_RADIUS = 20;

/**
 * The sheet corner radius — concentric with the device's display corner at the
 * sheet's standard float gap, so a floating sheet's corners run parallel to
 * the screen's. All three sheet components derive their resting radius here
 * (the docked/full state then animates toward the raw display radius).
 */
export function sheetCornerRadius(bottomInset: number): number {
    return concentricRadius(bottomInset, spacing.sm);
}
