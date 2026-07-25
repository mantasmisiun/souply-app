import { isTripNew } from '../state/tripSeenStore';

/**
 * "New" watermark semantics.
 *
 * `seen[tripId]` is how many receipts the user has ALREADY SEEN for that trip;
 * the card flags New when the live count exceeds it. It used to be stamped only
 * when the card was tapped, recording the count at that moment — so the happy
 * flow stamped 0 (list just finished, no receipt yet), the user uploaded from the
 * trip screen, and their OWN receipt flagged New the instant they left. The
 * watermark is now stamped from the screen that displays the receipts, so what
 * you looked at counts as seen — while a receipt added later (e.g. by a household
 * member) still lifts the count above it and flags correctly.
 */
describe('isTripNew', () => {
    test('a receipt the user has not seen flags New', () => {
        expect(isTripNew({ 7: 0 }, 7, 1)).toBe(true);
    });

    test('THE BUG: a receipt seen on the trip screen must NOT flag New', () => {
        // Stamped from the screen after the upload landed → watermark 1.
        expect(isTripNew({ 7: 1 }, 7, 1)).toBe(false);
    });

    test('a SECOND receipt (someone else uploaded) re-flags', () => {
        expect(isTripNew({ 7: 1 }, 7, 2)).toBe(true);
    });

    test('a trip with no receipts is never New', () => {
        expect(isTripNew({}, 7, 0)).toBe(false);
        expect(isTripNew({ 7: 0 }, 7, 0)).toBe(false);
    });

    test('an unknown trip with a receipt is New (never seen it)', () => {
        expect(isTripNew({}, 99, 1)).toBe(true);
    });

    test('a watermark ahead of the count (a receipt was deleted) does not flag', () => {
        expect(isTripNew({ 7: 3 }, 7, 2)).toBe(false);
    });
});
