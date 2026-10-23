import { floatCollapseProgress } from '../components/dock/dockGeometry';

/**
 * A docked sheet gives up its floating margins ONLY on the way to a FULL detent.
 *
 * This shipped wrong once: the progress was measured against the LAST snap, so a
 * sheet configured to stop at MEDIUM (`maxStage: 1`) hit 1 there and sat flush
 * against the screen edges — while its glass stayed translucent and its corners
 * stayed rounded, because those are gated on a full detent. Edge-to-edge is a
 * property of being full, not of being as open as this sheet goes.
 */

const COLLAPSED = 120;
const MEDIUM = 420;
const FULL = 820;

describe('floatCollapseProgress', () => {
    describe('a sheet with a full detent (maxStage 2)', () => {
        const snaps = [COLLAPSED, MEDIUM, FULL];

        it('floats when collapsed and docks at full', () => {
            expect(floatCollapseProgress(snaps, COLLAPSED)).toBe(0);
            expect(floatCollapseProgress(snaps, FULL)).toBe(1);
        });

        it('keeps part of its float at medium', () => {
            const p = floatCollapseProgress(snaps, MEDIUM);
            expect(p).toBeGreaterThan(0);
            expect(p).toBeLessThan(1);
        });

        it('grows monotonically between the detents', () => {
            const mid = floatCollapseProgress(snaps, (MEDIUM + FULL) / 2);
            expect(mid).toBeGreaterThan(floatCollapseProgress(snaps, MEDIUM));
            expect(mid).toBeLessThan(1);
        });
    });

    describe('a sheet whose deepest detent is medium (maxStage 1)', () => {
        const snaps = [COLLAPSED, MEDIUM];

        /** THE REGRESSION: this returned 1 and the sheet went edge-to-edge. */
        it('never gives up its float, even fully open', () => {
            expect(floatCollapseProgress(snaps, COLLAPSED)).toBe(0);
            expect(floatCollapseProgress(snaps, MEDIUM)).toBe(0);
            expect(floatCollapseProgress(snaps, (COLLAPSED + MEDIUM) / 2)).toBe(0);
        });
    });

    it('floats a bar with no sheet at all', () => {
        expect(floatCollapseProgress([COLLAPSED], COLLAPSED)).toBe(0);
        expect(floatCollapseProgress([], 0)).toBe(0);
    });

    it('clamps a height dragged past either end', () => {
        const snaps = [COLLAPSED, MEDIUM, FULL];
        expect(floatCollapseProgress(snaps, COLLAPSED - 200)).toBe(0);
        expect(floatCollapseProgress(snaps, FULL + 200)).toBe(1);
    });

    it('never divides by zero when the detents collapse onto each other', () => {
        expect(floatCollapseProgress([300, 300, 300], 300)).toBe(0);
    });
});
