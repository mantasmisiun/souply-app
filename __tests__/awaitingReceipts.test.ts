import {
    isAwaitingReceipt,
    countAwaitingReceiptGroups,
    groupReceiptProgress,
    type AwaitableList,
} from '../utils/awaitingReceipts';

const list = (
    id: number,
    status: string,
    receiptCount: number,
    basketId: number | null = null,
): AwaitableList => ({ id, status, receiptCount, basketId });

describe('isAwaitingReceipt', () => {
    it('is true for a completed row with no linked receipt', () => {
        expect(isAwaitingReceipt(list(1, 'completed', 0))).toBe(true);
    });
    it('is false once a receipt is linked', () => {
        expect(isAwaitingReceipt(list(1, 'completed', 1))).toBe(false);
    });
    it('is false for an active list', () => {
        expect(isAwaitingReceipt(list(1, 'active', 0))).toBe(false);
    });
    it('treats a missing receiptCount as 0 (awaiting)', () => {
        expect(isAwaitingReceipt({ id: 1, status: 'completed', basketId: null })).toBe(true);
    });
});

describe('countAwaitingReceiptGroups', () => {
    it('counts standalone completed lists individually', () => {
        expect(countAwaitingReceiptGroups([
            list(1, 'completed', 0),
            list(2, 'completed', 0),
        ])).toBe(2);
    });

    it('counts a split (shared basketId) once', () => {
        expect(countAwaitingReceiptGroups([
            list(1, 'completed', 0, 99),
            list(2, 'completed', 0, 99),
        ])).toBe(1);
    });

    it('still counts a split where only one store is missing its receipt', () => {
        expect(countAwaitingReceiptGroups([
            list(1, 'completed', 1, 99),
            list(2, 'completed', 0, 99),
        ])).toBe(1);
    });

    it('does not count a fully-receipted split', () => {
        expect(countAwaitingReceiptGroups([
            list(1, 'completed', 1, 99),
            list(2, 'completed', 2, 99),
        ])).toBe(0);
    });

    it('ignores active lists', () => {
        expect(countAwaitingReceiptGroups([
            list(1, 'active', 0),
            list(2, 'completed', 0),
        ])).toBe(1);
    });

    it('returns 0 for no lists', () => {
        expect(countAwaitingReceiptGroups([])).toBe(0);
    });
});

describe('groupReceiptProgress', () => {
    it('reports how many of the group stores have a receipt', () => {
        expect(groupReceiptProgress([
            list(1, 'completed', 1, 99),
            list(2, 'completed', 0, 99),
        ])).toEqual({ have: 1, total: 2 });
    });
    it('reports complete when all stores have receipts', () => {
        expect(groupReceiptProgress([
            list(1, 'completed', 1, 99),
            list(2, 'completed', 3, 99),
        ])).toEqual({ have: 2, total: 2 });
    });
});
