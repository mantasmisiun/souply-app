import { API_BASE_URL } from '../config/api';

/**
 * Receipt actions from the trip receipt sheet. Auth rides the global fetch
 * interceptor (owner-scoped server-side).
 */

/** User removal of a receipt BEFORE the mandatory queue is cleared: the server
 *  hides it from the user's views (userDeletedAt), wipes the stored photo, and
 *  unlinks it from its trip — but KEEPS the anonymized price data. Re-uploading
 *  the same receipt later un-hides + re-links it to the new trip. Throws on 423
 *  (queue already cleared → only the photo may be deleted). */
export async function userDeleteReceipt(receiptId: number): Promise<void> {
    const res = await fetch(`${API_BASE_URL}/api/receipts/${receiptId}/user`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`userDeleteReceipt ${res.status}`);
}

/** Photo-only delete (after the queue is cleared): wipes the stored image, keeps
 *  the receipt, its data, and the trip link intact. */
export async function deleteReceiptImage(receiptId: number): Promise<void> {
    const res = await fetch(`${API_BASE_URL}/api/receipts/${receiptId}/image`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`deleteReceiptImage ${res.status}`);
}
