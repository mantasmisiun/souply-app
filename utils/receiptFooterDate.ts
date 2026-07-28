/**
 * The receipt's OWN printed date (footer), preferred over the upload-time
 * `receiptDate` column everywhere the list renders a date.
 *
 * Source priority:
 *   1. `receiptFooterDate` — the slimmed GET /users/:id/receipts endpoint's
 *      explicit column (JSON_EXTRACT server-side), no blob shipped;
 *   2. `parsedData.footer.date` / `parsedData.date` — the legacy blob dig,
 *      kept as a fallback so the app still works against an un-updated
 *      server that ships `parsedData`.
 */

export interface ReceiptDateSource {
    receiptFooterDate?: string | null;
    parsedData?: unknown;
}

const safeJsonParse = (raw: string): any => {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
};

const asDateString = (raw: unknown): string | null =>
    typeof raw === 'string' && raw.trim() ? raw : null;

export const receiptFooterDateStr = (r: ReceiptDateSource): string | null => {
    const explicit = asDateString(r.receiptFooterDate);
    if (explicit) return explicit;
    const pd = r.parsedData;
    if (!pd) return null;
    const obj = typeof pd === 'string' ? safeJsonParse(pd) : pd;
    return asDateString((obj as any)?.footer?.date ?? (obj as any)?.date ?? null);
};
