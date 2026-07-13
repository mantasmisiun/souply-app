/**
 * "Awaiting receipt" logic shared by the List-tab badge and the
 * shopping-list cards.
 *
 * A completed shopping-list ROW is for one store; a 1/2/3-store split is
 * 1/2/3 rows sharing a basketId. A row is "awaiting a receipt" once it is
 * completed and no Receipt is linked to it (server returns `receiptCount`).
 * For the badge we count distinct GROUPS (a split counts once) that still
 * have at least one store awaiting.
 */

export interface AwaitableList {
    id: number;
    basketId?: number | null;
    status: string;
    receiptCount?: number;
}

/** Group key: shared basketId for a split, else the standalone row id. */
const groupKey = (l: AwaitableList): string =>
    l.basketId != null ? `b${l.basketId}` : `l${l.id}`;

/** A completed row with no linked receipt yet. */
export const isAwaitingReceipt = (l: AwaitableList): boolean =>
    l.status === 'completed' && (Number(l.receiptCount) || 0) === 0;

/** Distinct completed groups that still have ≥1 store awaiting a receipt. */
export const countAwaitingReceiptGroups = (lists: AwaitableList[]): number => {
    const awaiting = new Set<string>();
    for (const l of lists) if (isAwaitingReceipt(l)) awaiting.add(groupKey(l));
    return awaiting.size;
};

/** Per-group receipt progress: how many of the group's stores have a receipt. */
export const groupReceiptProgress = (
    lists: AwaitableList[],
): { have: number; total: number } => {
    const total = lists.length;
    const have = lists.filter((l) => (Number(l.receiptCount) || 0) > 0).length;
    return { have, total };
};
