/**
 * Handoff between the receipt pipeline and the user-facing store-resolution
 * screen (the `store_unrecognized` recoverable case).
 *
 * The pipeline calls `requestStoreResolution(...)` (which returns a Promise),
 * then navigates to the screen. The screen reads the pending request, and on
 * Confirm / cancel calls `completeStoreResolution(...)`, resolving the Promise
 * so the pipeline continues with the chosen store (or bails if cancelled).
 */

export interface ResolvedStore {
    storeId: number;
    storeName: string | null;
    storeAddress: string | null;
}

interface PendingResolution {
    chainId: number;
    chainName: string;
    ocrAddress: string | null;
    resolve: (store: ResolvedStore | null) => void;
}

let pending: PendingResolution | null = null;

export function requestStoreResolution(
    chainId: number,
    chainName: string,
    ocrAddress: string | null,
): Promise<ResolvedStore | null> {
    return new Promise((resolve) => {
        // If a stale request is somehow still open, cancel it first.
        if (pending) pending.resolve(null);
        pending = { chainId, chainName, ocrAddress, resolve };
    });
}

export function getStoreResolutionRequest(): Omit<PendingResolution, 'resolve'> | null {
    if (!pending) return null;
    const { chainId, chainName, ocrAddress } = pending;
    return { chainId, chainName, ocrAddress };
}

/** Resolve the open request (store = chosen, or null = cancelled). */
export function completeStoreResolution(store: ResolvedStore | null): void {
    const p = pending;
    pending = null;
    p?.resolve(store);
}

/**
 * Best-effort address line from the header OCR text — used to prefill the
 * resolution search when the parser couldn't produce a structured
 * `storeAddress`. Finds the first Lithuanian street line (e.g.
 * "Pramonės g. 6, Šiauliai": street-type abbrev + a number).
 */
export function pickAddressFromRawText(rawText: string | null | undefined): string | null {
    if (!rawText) return null;
    const STREET = /\b(g|pr|al|pl|skg|krant|gatv|prospekt|al[eė]j)\.?\s*\d/i;
    // A real address line has a "street, city" comma AND no price/weight markers.
    // Without these guards a garbled product weight ("…IKI OKIS G000 ka X 1,85 EUR/
    // kg") matches the "g\d" street pattern and gets prefilled as the address (the
    // last product's name) — receipt 117.
    const PRODUCTISH = /EUR|\bkg\b|\bvnt\b|\bX\b|\d[.,]\s?\d{2}\s*[ABC]\b/i;
    for (const raw of rawText.split('\n')) {
        const line = raw.trim();
        if (line.length >= 4 && /,/.test(line) && STREET.test(line) && !PRODUCTISH.test(line)) return line;
    }
    return null;
}
