/**
 * Dock geometry rules, kept as plain functions so they can be tested and so the
 * contract lives in one place instead of inside an animated style.
 */

/**
 * How far a docked sheet has given up its FLOATING margins, 0 → 1.
 *
 * 0 = the full symmetric gap on left, right and bottom; 1 = edge-to-edge.
 *
 * THE RULE: edge-to-edge belongs to the FULL detent, never to "as far as this
 * particular sheet opens". A sheet whose deepest stop is MEDIUM (`maxStage: 1`)
 * therefore keeps its float at every stage and returns 0 throughout.
 *
 * Measuring against the last snap instead shipped a Receptai sheet that sat
 * flush against the screen edges at its medium stop while still being a floating
 * panel in every other respect — the glass never went solid and the corners
 * never squared off, because those are (correctly) gated on a full detent.
 *
 * @param snaps  detent heights, ascending: [collapsed, medium] or [collapsed, medium, full]
 * @param height the sheet's current height
 */
export function floatCollapseProgress(snaps: readonly number[], height: number): number {
    'worklet';
    if (snaps.length < 3) return 0;
    const lo = snaps[0];
    const hi = snaps[snaps.length - 1];
    if (!(hi > lo)) return 0;
    const t = (height - lo) / (hi - lo);
    return t < 0 ? 0 : t > 1 ? 1 : t;
}
