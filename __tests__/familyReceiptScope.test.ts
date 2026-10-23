/**
 * Family vs personal receipt items (spec §4.1/§4.2/§4.4) — the pure logic the
 * trip receipts screen's family mode is built on. No renderer: this is the
 * "which items land in which section / what does a toggle or bulk move do /
 * what does a locked response mean" layer.
 */
import {
    lineKey, derivePersonalKeys, isRowPersonal, splitRowsByScope, applyScope, revertScope,
    groupLinesByReceipt, summariseScopeOutcome, mergeLockStates,
    toggleSelection, pruneSelection, linesForSelection,
    type LineRef,
} from '../utils/familyReceiptScope';
import type { ScopeLockState } from '../utils/familyShoppingApi';

const L = (receiptId: number, lineIdx: number): LineRef => ({ receiptId, lineIdx });

const row = (key: string, lines: LineRef[]) => ({ key, lines });

describe('§4.5 hydration — derivePersonalKeys (family view lists FAMILY lines)', () => {
    const receipts = [
        { id: 10, items: [{ lineIdx: 0 }, { lineIdx: 1 }, { lineIdx: 2 }] },
        { id: 11, items: [{ lineIdx: 0 }, { lineIdx: 1 }] },
    ];

    it('personal = full line list minus the family view lines', () => {
        const views = new Map([
            [10, { familyItems: [{ lineIdx: 0 }, { lineIdx: 2 }] as any }],
            [11, { familyItems: [{ lineIdx: 0 }, { lineIdx: 1 }] as any }],
        ]);
        expect(derivePersonalKeys(receipts, views)).toEqual(new Set(['10:1']));
    });

    it('a receipt with no view contributes nothing — its lines stay family', () => {
        const views = new Map([[10, { familyItems: [] as any }]]);
        // receipt 11 has no view: none of its lines become personal.
        expect(derivePersonalKeys(receipts, views)).toEqual(new Set(['10:0', '10:1', '10:2']));
    });

    it('everything family → empty personal set (the §4.1 default)', () => {
        const views = new Map([
            [10, { familyItems: [{ lineIdx: 0 }, { lineIdx: 1 }, { lineIdx: 2 }] as any }],
            [11, { familyItems: [{ lineIdx: 0 }, { lineIdx: 1 }] as any }],
        ]);
        expect(derivePersonalKeys(receipts, views).size).toBe(0);
    });
});

describe('§4.1 sections — derived views of the per-line flag', () => {
    it('default (empty personal set) puts every row in the family section', () => {
        const rows = [row('a', [L(1, 0)]), row('b', [L(1, 1)])];
        const split = splitRowsByScope(rows, new Set());
        expect(split.family.map(r => r.key)).toEqual(['a', 'b']);
        expect(split.personal).toEqual([]);
    });

    it('a row is personal only when EVERY line is personal', () => {
        // Row c merges two lines across receipts; only one is personal.
        const rows = [row('c', [L(1, 0), L(2, 3)])];
        expect(isRowPersonal(rows[0].lines, new Set(['1:0']))).toBe(false);
        expect(splitRowsByScope(rows, new Set(['1:0'])).family.map(r => r.key)).toEqual(['c']);
        // Both lines personal → the row moves.
        const both = new Set(['1:0', '2:3']);
        expect(isRowPersonal(rows[0].lines, both)).toBe(true);
        expect(splitRowsByScope(rows, both).personal.map(r => r.key)).toEqual(['c']);
    });

    it('a row with no lines can never be personal', () => {
        expect(isRowPersonal([], new Set(['1:0']))).toBe(false);
    });

    it('order within each section is preserved', () => {
        const rows = [row('a', [L(1, 0)]), row('b', [L(1, 1)]), row('c', [L(1, 2)])];
        const split = splitRowsByScope(rows, new Set(['1:1']));
        expect(split.family.map(r => r.key)).toEqual(['a', 'c']);
        expect(split.personal.map(r => r.key)).toEqual(['b']);
    });
});

describe('§4.1 one-tap toggle — applyScope / revertScope', () => {
    it('to personal adds, to family removes, input set untouched (pure)', () => {
        const start = new Set<string>(['1:5']);
        const toPersonal = applyScope(start, [L(1, 0), L(1, 1)], true);
        expect(toPersonal).toEqual(new Set(['1:5', '1:0', '1:1']));
        const back = applyScope(toPersonal, [L(1, 0), L(1, 5)], false);
        expect(back).toEqual(new Set(['1:1']));
        expect(start).toEqual(new Set(['1:5'])); // never mutated
    });

    it('toggling is idempotent per direction', () => {
        const once = applyScope(new Set(), [L(1, 0)], true);
        expect(applyScope(once, [L(1, 0)], true)).toEqual(once);
    });

    it('revertScope restores ONLY the failed lines to their previous state', () => {
        // prev: line 1:0 family, 1:1 personal. A bulk to-personal flip of both
        // succeeded for 1:0's receipt but failed for receipt 2's line.
        const prev = new Set(['1:1']);
        const optimistic = applyScope(prev, [L(1, 0), L(2, 0)], true);
        const reverted = revertScope(optimistic, prev, [L(2, 0)]);
        expect(reverted).toEqual(new Set(['1:1', '1:0'])); // 2:0 back to family, 1:0 keeps the new scope
    });

    it('revertScope re-adds a line that was personal before the failed flip', () => {
        const prev = new Set(['3:7']);
        const optimistic = applyScope(prev, [L(3, 7)], false); // to-family flip
        expect(optimistic.has('3:7')).toBe(false);
        expect(revertScope(optimistic, prev, [L(3, 7)])).toEqual(new Set(['3:7']));
    });
});

describe('§4.2 bulk — grouping and selection transitions', () => {
    it('groupLinesByReceipt: one PATCH per receipt, deduped, order kept', () => {
        const groups = groupLinesByReceipt([L(1, 0), L(2, 4), L(1, 2), L(1, 0)]);
        expect(Array.from(groups.entries())).toEqual([[1, [0, 2]], [2, [4]]]);
    });

    it('long-press then taps: toggleSelection flips membership', () => {
        let sel = toggleSelection(new Set(), 'a'); // long-press enters with a
        expect(sel).toEqual(new Set(['a']));
        sel = toggleSelection(sel, 'b');
        expect(sel).toEqual(new Set(['a', 'b']));
        sel = toggleSelection(sel, 'a'); // tap a again deselects
        expect(sel).toEqual(new Set(['b']));
        sel = toggleSelection(sel, 'b'); // deselecting the last empties → host exits
        expect(sel.size).toBe(0);
    });

    it('pruneSelection drops keys that no longer exist after a reload', () => {
        expect(pruneSelection(new Set(['a', 'gone']), ['a', 'b'])).toEqual(new Set(['a']));
    });

    it('linesForSelection collects every line of every selected row', () => {
        const rows = [
            { key: 'a', lines: [L(1, 0), L(2, 1)] },
            { key: 'b', lines: [L(1, 3)] },
            { key: 'c', lines: [L(3, 0)] },
        ];
        expect(linesForSelection(rows, new Set(['a', 'c']))).toEqual([L(1, 0), L(2, 1), L(3, 0)]);
        expect(linesForSelection(rows, new Set())).toEqual([]);
    });
});

describe('§4.4 locked responses — outcome summary and lock folding', () => {
    const lock = (locked: boolean, reason: string): ScopeLockState =>
        ({ householdId: 1, recorded: true, locked, reason, windowClosesAt: null });

    it("'adjusted' dominates — any visible audit entry must be surfaced", () => {
        expect(summariseScopeOutcome([{ ledger: 'restated' }, { ledger: 'adjusted' }])).toBe('adjusted');
        expect(summariseScopeOutcome([{ ledger: 'adjusted' }])).toBe('adjusted');
    });

    it("pre-lock restatements and no-ledger writes stay silent", () => {
        expect(summariseScopeOutcome([{ ledger: 'restated' }, { ledger: 'none' }])).toBe('restated');
        expect(summariseScopeOutcome([{ ledger: 'none' }])).toBe('none');
        expect(summariseScopeOutcome([])).toBe('none');
    });

    it('mergeLockStates folds PATCH responses over the per-receipt map', () => {
        const before = new Map([[10, lock(false, 'not-recorded')], [11, lock(false, 'window-open')]]);
        // The server locked receipt 11 between hydration and the PATCH (a
        // settlement confirmed) — the response's lock replaces the stale one.
        const after = mergeLockStates(before, [{ receiptId: 11, lock: lock(true, 'settled') }]);
        expect(after.get(11)!.locked).toBe(true);
        expect(after.get(10)!.locked).toBe(false);
        expect(before.get(11)!.locked).toBe(false); // pure — input untouched
    });

    it('lineKey format matches what the store persists', () => {
        expect(lineKey(L(12, 3))).toBe('12:3');
    });
});
