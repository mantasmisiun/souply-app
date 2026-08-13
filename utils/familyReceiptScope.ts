import type { ScopeChangeResult, ScopeLockState, FamilyReceiptView } from './familyShoppingApi';

/**
 * FAMILY vs PERSONAL receipt items (spec §4.1/§4.2) — the PURE logic behind the
 * trip receipts screen's family mode. The screen holds ONE piece of scope
 * state: the set of PERSONAL line keys ("receiptId:lineIdx"). Everything else —
 * which section a row renders in, what a toggle flips, what a bulk action
 * PATCHes — is derived here, so it can be tested without a renderer.
 *
 * Default is FAMILY (§4.1): a line is family unless its key is in the personal
 * set, which is exactly how the server stores it (ReceiptItem.isPersonal).
 */

/** One receipt line — the unit the server's scope PATCH addresses. */
export interface LineRef {
    receiptId: number;
    lineIdx: number;
}

export const lineKey = (ref: LineRef): string => `${ref.receiptId}:${ref.lineIdx}`;

/**
 * Derive the personal set from the server: a receipt's family view (§4.5)
 * lists FAMILY lines only, so personal = the receipt's full line list minus
 * the view's. Receipts with no view (fetch failed / not family) contribute
 * nothing — their lines stay family, the safe default.
 */
export const derivePersonalKeys = (
    receipts: { id: number; items: { lineIdx: number }[] }[],
    familyViews: ReadonlyMap<number, Pick<FamilyReceiptView, 'familyItems'>>,
): Set<string> => {
    const personal = new Set<string>();
    for (const r of receipts) {
        const view = familyViews.get(r.id);
        if (!view) continue;
        const family = new Set(view.familyItems.map(i => i.lineIdx));
        for (const it of r.items) {
            if (!family.has(it.lineIdx)) personal.add(lineKey({ receiptId: r.id, lineIdx: it.lineIdx }));
        }
    }
    return personal;
};

/**
 * A merged row is PERSONAL only when EVERY line in it is personal — the
 * sections are derived views of the per-line flag (§4.1), and a mixed row
 * (possible when another member re-scopes part of it) stays visible in the
 * family section rather than hiding shared money.
 */
export const isRowPersonal = (lines: LineRef[], personal: ReadonlySet<string>): boolean =>
    lines.length > 0 && lines.every(l => personal.has(lineKey(l)));

/** Split rows into the two derived sections. Order within each is preserved. */
export const splitRowsByScope = <T extends { lines: LineRef[] }>(
    rows: T[],
    personal: ReadonlySet<string>,
): { family: T[]; personal: T[] } => {
    const fam: T[] = [];
    const pers: T[] = [];
    for (const row of rows) (isRowPersonal(row.lines, personal) ? pers : fam).push(row);
    return { family: fam, personal: pers };
};

/** Apply a toggle/bulk move to the personal set (pure — returns a new Set). */
export const applyScope = (
    personal: ReadonlySet<string>,
    lines: LineRef[],
    toPersonal: boolean,
): Set<string> => {
    const next = new Set(personal);
    for (const l of lines) {
        if (toPersonal) next.add(lineKey(l));
        else next.delete(lineKey(l));
    }
    return next;
};

/**
 * Revert `lines` in `current` to their membership in `prev` — the undo for an
 * optimistic flip whose PATCH failed. Only the failed lines move back; lines
 * whose PATCH succeeded keep their new scope.
 */
export const revertScope = (
    current: ReadonlySet<string>,
    prev: ReadonlySet<string>,
    lines: LineRef[],
): Set<string> => {
    const next = new Set(current);
    for (const l of lines) {
        const k = lineKey(l);
        if (prev.has(k)) next.add(k);
        else next.delete(k);
    }
    return next;
};

/** Group line refs per receipt — one PATCH per receipt (§4.2 is one write). */
export const groupLinesByReceipt = (lines: LineRef[]): Map<number, number[]> => {
    const byReceipt = new Map<number, number[]>();
    for (const l of lines) {
        const arr = byReceipt.get(l.receiptId);
        if (arr) { if (!arr.includes(l.lineIdx)) arr.push(l.lineIdx); }
        else byReceipt.set(l.receiptId, [l.lineIdx]);
    }
    return byReceipt;
};

/**
 * §4.4 — what to tell the user after the PATCHes. 'adjusted' dominates: if ANY
 * receipt emitted a visible adjustment event, the user must be told (silently
 * succeeding would defeat the audit trail). 'restated' and 'none' are silent
 * successes — nothing was locked, nobody had acted on the number.
 */
export const summariseScopeOutcome = (
    results: Pick<ScopeChangeResult, 'ledger'>[],
): 'adjusted' | 'restated' | 'none' => {
    if (results.some(r => r.ledger === 'adjusted')) return 'adjusted';
    if (results.some(r => r.ledger === 'restated')) return 'restated';
    return 'none';
};

/** Fold the PATCH responses' lock states into the per-receipt lock map. */
export const mergeLockStates = (
    locks: ReadonlyMap<number, ScopeLockState>,
    results: Pick<ScopeChangeResult, 'receiptId' | 'lock'>[],
): Map<number, ScopeLockState> => {
    const next = new Map(locks);
    for (const r of results) next.set(r.receiptId, r.lock);
    return next;
};

// ── §4.2 bulk-selection transitions (long-press → checkbox mode) ─────────────

/** Toggle one row key; an emptied selection means "exit selection mode". */
export const toggleSelection = (selected: ReadonlySet<string>, key: string): Set<string> => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
};

/** Drop selected keys that no longer exist (a heal/reload changed the rows). */
export const pruneSelection = (selected: ReadonlySet<string>, liveKeys: string[]): Set<string> => {
    const live = new Set(liveKeys);
    const next = new Set<string>();
    for (const k of selected) if (live.has(k)) next.add(k);
    return next;
};

/** The line refs a bulk action moves — every line of every selected row. */
export const linesForSelection = <T extends { key: string; lines: LineRef[] }>(
    rows: T[],
    selected: ReadonlySet<string>,
): LineRef[] => rows.filter(r => selected.has(r.key)).flatMap(r => r.lines);
