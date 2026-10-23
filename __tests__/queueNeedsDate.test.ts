import { routeQueueError } from '../hooks/useReceiptQueueRunner';
import { ProcessingError } from '../services/receiptProcessingService';

/**
 * MISSING PURCHASE DATE on the background queue.
 *
 * The interactive scan asks the user (scanSessionService → ensureKeyReceiptFields);
 * the queue had no such gate, so an unreadable date was stored as "" and every
 * downstream view fell back to TODAY — a receipt from last week silently landed on
 * the wrong day. The queue is headless, so it now PARKS the item as `needs_date`
 * and the card asks for the date, rather than failing it (an error card is
 * dead-ended) or blocking on a modal that may not be on screen.
 */
describe('needs_date is parked, not failed', () => {
    test('routeQueueError still treats other ProcessingErrors as errors', () => {
        const r = routeQueueError(new ProcessingError('ocr_no_text', 'Nepavyko nuskaityti teksto'), true);
        expect(r.kind).toBe('error');
    });

    test('a needs_date error carries its reason so the runner can park it', () => {
        // The runner branches on `reason` BEFORE routeQueueError, so what matters
        // is that the reason survives on the thrown error.
        const e = new ProcessingError('needs_date', 'Reikia kvito datos');
        expect(e).toBeInstanceOf(ProcessingError);
        expect(e.reason).toBe('needs_date');
    });

    test('duplicate detection is unaffected by the new reason', () => {
        const dup = routeQueueError(new ProcessingError('post_failed', 'Kvitas jau įkeltas'), true);
        expect(dup.kind).toBe('error');
        if (dup.kind === 'error') expect(dup.isDuplicate).toBe(true);
    });

    test('offline still wins for non-ProcessingError failures', () => {
        expect(routeQueueError(new Error('boom'), false).kind).toBe('awaiting_network');
    });
});
