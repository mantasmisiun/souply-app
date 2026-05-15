import { API_BASE_URL } from '../config/api';
import { getUserId } from '../config/user';

/**
 * Thin wrapper around /api/admin/* endpoints.
 *
 * Every call sends `X-Admin-Id` derived from the local userId — server
 * gates on `isAdmin` in the User row. No client-side flag matters; if
 * the user isn't actually an admin server-side the calls 403.
 */

export interface AdminImageCandidate {
    imageUrl: string;
    sourceType: 'cross_chain_sibling' | 'base_product_link' | 'pending_upload';
    sourceSpId: number | null;
    sourceChainName?: string;
    pendingUploadId?: number;
    uploadedBy?: string;
}

export interface AdminImageQueueRow {
    spId: number;
    name: string;
    chainId: number;
    chainName: string;
    chainLogoUrl: string | null;
    categoryName: string;
    currentImageUrl: string | null;
    flaggedByUser: boolean;
    flagReceiptId: number | null;
    flagLineIdx: number | null;
    recentPurchaseCount: number;
    candidates: AdminImageCandidate[];
    lastPropagation: {
        id: number;
        sourceType: string;
        actor: string;
        createdAt: string;
    } | null;
}

export interface ImageBatchResponse {
    rows: AdminImageQueueRow[];
    outstanding: number;
    leaseCount: number;
    resumed?: boolean;
}

export interface AuditLogRow {
    id: number;
    adminUserId: string;
    action: string;
    targetType: string;
    targetId: number;
    valueBefore: any;
    valueAfter: any;
    reversedAt: string | null;
    createdAt: string;
}

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const userId = await getUserId();
    const headers = new Headers(init.headers ?? {});
    headers.set('X-Admin-Id', userId);
    if (!headers.has('Content-Type') && init.body) {
        headers.set('Content-Type', 'application/json');
    }
    return fetch(`${API_BASE_URL}${path}`, { ...init, headers });
}

export async function getAdminImageQueue(): Promise<ImageBatchResponse> {
    const res = await adminFetch('/api/admin/images/queue');
    if (!res.ok) throw new Error(`queue ${res.status}`);
    return res.json();
}

export async function claimAdminImageBatch(size: number = 10): Promise<ImageBatchResponse> {
    const res = await adminFetch('/api/admin/images/claim-batch', {
        method: 'POST',
        body: JSON.stringify({ size }),
    });
    if (!res.ok) throw new Error(`claim ${res.status}`);
    return res.json();
}

export async function releaseAdminImageBatch(): Promise<{ released: number }> {
    const res = await adminFetch('/api/admin/images/release-batch', { method: 'POST' });
    if (!res.ok) throw new Error(`release ${res.status}`);
    return res.json();
}

export async function adoptImageCandidate(
    spId: number,
    payload: {
        imageUrl: string;
        sourceType: AdminImageCandidate['sourceType'] | 'admin_upload';
        sourceSpId?: number | null;
        pendingUploadId?: number;
    },
): Promise<void> {
    const res = await adminFetch(`/api/admin/images/${spId}/adopt-candidate`, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`adopt ${res.status}`);
}

export async function removeImage(spId: number): Promise<void> {
    const res = await adminFetch(`/api/admin/images/${spId}/remove`, { method: 'POST' });
    if (!res.ok) throw new Error(`remove ${res.status}`);
}

export async function skipImageCard(spId: number): Promise<void> {
    const res = await adminFetch(`/api/admin/images/${spId}/skip`, { method: 'POST' });
    if (!res.ok) throw new Error(`skip ${res.status}`);
}

export async function rejectPendingImageUpload(
    spId: number,
    pendingUploadId: number,
): Promise<void> {
    const res = await adminFetch(`/api/admin/images/${spId}/reject-pending`, {
        method: 'POST',
        body: JSON.stringify({ pendingUploadId }),
    });
    if (!res.ok) throw new Error(`reject ${res.status}`);
}

export async function resolveReceiptLineIssue(args: {
    receiptId: number;
    receiptLineIdx: number;
    userId: string;
}): Promise<void> {
    const res = await adminFetch('/api/admin/issues/resolve', {
        method: 'POST',
        body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`resolve ${res.status}`);
}

export async function revertImageChange(auditId: number): Promise<void> {
    const res = await adminFetch(`/api/admin/images/revert/${auditId}`, { method: 'POST' });
    if (!res.ok) throw new Error(`revert ${res.status}`);
}

export async function getAdminAuditLog(page: number = 0, pageSize: number = 50): Promise<{
    rows: AuditLogRow[];
    page: number;
    pageSize: number;
}> {
    const res = await adminFetch(`/api/admin/audit?page=${page}&pageSize=${pageSize}`);
    if (!res.ok) throw new Error(`audit ${res.status}`);
    return res.json();
}

// ── Amounts tab ─────────────────────────────────────────────────────

export type CanonicalUnit = 'g' | 'kg' | 'ml' | 'l' | 'vnt' | 'rit';

export interface AdminAmountQueueRow {
    spId: number;
    name: string;
    chainId: number;
    chainName: string;
    chainLogoUrl: string | null;
    categoryName: string;
    storedAmount: number | null;
    storedUnit: string | null;
    storedIsWeighable: boolean;
    flaggedByUser: boolean;
    flagReceiptId: number | null;
    flagLineIdx: number | null;
    recentPurchaseCount: number;
    suggestion: {
        amount: number;
        unit: CanonicalUnit;
        matched: string;
        isWeighable: boolean;
    };
}

export interface AmountBatchResponse {
    rows: AdminAmountQueueRow[];
    leaseCount: number;
    resumed?: boolean;
}

export async function getAdminAmountQueue(): Promise<AmountBatchResponse> {
    const res = await adminFetch('/api/admin/amounts/queue');
    if (!res.ok) throw new Error(`amounts queue ${res.status}`);
    return res.json();
}

export async function claimAdminAmountBatch(size: number = 10): Promise<AmountBatchResponse> {
    const res = await adminFetch('/api/admin/amounts/claim-batch', {
        method: 'POST',
        body: JSON.stringify({ size }),
    });
    if (!res.ok) throw new Error(`amounts claim ${res.status}`);
    return res.json();
}

export async function releaseAdminAmountBatch(): Promise<{ released: number }> {
    const res = await adminFetch('/api/admin/amounts/release-batch', { method: 'POST' });
    if (!res.ok) throw new Error(`amounts release ${res.status}`);
    return res.json();
}

export type ConfirmAmountOutcome = 'confirmed' | 'duplicate_size';

export async function confirmAdminAmount(
    spId: number,
    payload: { amount: number; unit: CanonicalUnit; isWeighable: boolean },
): Promise<ConfirmAmountOutcome> {
    const res = await adminFetch(`/api/admin/amounts/${spId}/confirm`, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
    if (res.status === 409) {
        // Server completed the lease + logged an amount_skip with
        // reason='duplicate_size_in_chain'. Treat as a special skip
        // so the card auto-advances with a clearer toast.
        return 'duplicate_size';
    }
    if (!res.ok) throw new Error(`amounts confirm ${res.status}`);
    return 'confirmed';
}

export async function skipAdminAmount(spId: number): Promise<void> {
    const res = await adminFetch(`/api/admin/amounts/${spId}/skip`, { method: 'POST' });
    if (!res.ok) throw new Error(`amounts skip ${res.status}`);
}

// ── Flags tab ───────────────────────────────────────────────────────

export interface AdminFlagQueueRow {
    /** `${receiptId}-${lineIdx}` — server-side path key for action endpoints. */
    flagKey: string;
    receiptId: number;
    lineIdx: number;
    spId: number;
    chainId: number;
    chainName: string;
    chainLogoUrl: string | null;
    /** Canonical Product behind the current SP — what the user saw in
     *  the app and flagged. The Pavadinimas search field is
     *  initialised against this. */
    productId: number;
    productName: string;
    categoryId: number | null;
    categoryName: string;
    userCount: number;
    flagged: {
        name: boolean;
        amount: boolean;
        price: boolean;
        discount: boolean;
        image: boolean;
    };
    sp: {
        name: string;
        /** Per-chain OCR'd label. Drives the "Atpažintas tekstas" field. */
        storeProductName: string | null;
        brandName: string | null;
        amount: number | null;
        unit: string | null;
        isWeighable: boolean;
        imageUrl: string | null;
    };
    receiptPrice: {
        priceId: number | null;
        price: number | null;
        promoPrice: number | null;
        priceVerified: boolean;
    };
    /** Cross-chain siblings + BaseProductLink siblings + pending user
     *  uploads available for this SP. Same shape as the Images tab's
     *  `candidates`. The Flags tab's image picker renders these as a
     *  thumbnail strip next to the current image. */
    imageCandidates: AdminImageCandidate[];
    flaggedAt: string;
}

export interface FlagBatchResponse {
    rows: AdminFlagQueueRow[];
    leaseCount: number;
    resumed?: boolean;
}

export async function getAdminFlagQueue(): Promise<FlagBatchResponse> {
    const res = await adminFetch('/api/admin/flags/queue');
    if (!res.ok) throw new Error(`flags queue ${res.status}`);
    return res.json();
}

export async function claimAdminFlagBatch(size: number = 10): Promise<FlagBatchResponse> {
    const res = await adminFetch('/api/admin/flags/claim-batch', {
        method: 'POST',
        body: JSON.stringify({ size }),
    });
    if (!res.ok) throw new Error(`flags claim ${res.status}`);
    return res.json();
}

export async function releaseAdminFlagBatch(): Promise<{ released: number }> {
    const res = await adminFetch('/api/admin/flags/release-batch', { method: 'POST' });
    if (!res.ok) throw new Error(`flags release ${res.status}`);
    return res.json();
}

export interface ConfirmFlagPayload {
    sp?: {
        /** Chain-specific OCR'd label — `StoreProduct.storeProductName`. */
        storeProductName?: string;
        brandName?: string | null;
        amount?: number;
        unit?: CanonicalUnit;
        isWeighable?: boolean;
        imageUrl?: string | null;
    };
    /** Re-link the SP to a different Product, or create one. */
    productLink?:
        | { mode: 'pick'; productId: number }
        | { mode: 'create'; name: string };
    /** Apply this category to the effective Product (post-link). */
    categoryId?: number;
    /** Direct edits to the receipt's Price row. Omit either key for
     *  no change. `promoPrice: null` explicitly removes a phantom
     *  discount; a number replaces/adds. Confirm always verifies the
     *  row server-side (admin reviewed). */
    receiptPrice?: {
        price?: number;
        promoPrice?: number | null;
    };
}

export interface AdminProductSearchRow {
    id: number;
    name: string;
    categoryId: number | null;
    categoryName: string | null;
}

export interface AdminCategorySearchRow {
    id: number;
    name: string;
    nameKey: string;
    path: string;
}

export async function searchAdminProducts(q: string, limit: number = 10): Promise<AdminProductSearchRow[]> {
    const qs = `q=${encodeURIComponent(q)}&limit=${limit}`;
    const res = await adminFetch(`/api/admin/products/search?${qs}`);
    if (!res.ok) throw new Error(`product search ${res.status}`);
    const json = await res.json();
    return json.rows ?? [];
}

export async function searchAdminCategories(q: string): Promise<AdminCategorySearchRow[]> {
    const res = await adminFetch(`/api/admin/categories/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error(`category search ${res.status}`);
    const json = await res.json();
    return json.rows ?? [];
}

export type ConfirmFlagOutcome = 'confirmed' | 'duplicate_size';

export async function confirmAdminFlag(
    flagKey: string,
    payload: ConfirmFlagPayload,
): Promise<ConfirmFlagOutcome> {
    const res = await adminFetch(`/api/admin/flags/${flagKey}/confirm`, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
    if (res.status === 409) return 'duplicate_size';
    if (!res.ok) throw new Error(`flags confirm ${res.status}`);
    return 'confirmed';
}

export async function dismissAdminFlag(flagKey: string): Promise<void> {
    const res = await adminFetch(`/api/admin/flags/${flagKey}/dismiss`, {
        method: 'POST',
        body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`flags dismiss ${res.status}`);
}

export async function skipAdminFlag(flagKey: string): Promise<void> {
    const res = await adminFetch(`/api/admin/flags/${flagKey}/skip`, {
        method: 'POST',
        body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`flags skip ${res.status}`);
}

/**
 * Returns the absolute URL of the cropped receipt JPEG. The endpoint
 * requires admin auth via `X-Admin-Id`, so this is consumed via a
 * fetch + Blob → object-URL pattern in the card UI (not directly via
 * `<Image source={{ uri }} />` which can't carry our header).
 */
export function flaggedReceiptCropUrl(receiptId: number, lineIdx: number): string {
    return `${API_BASE_URL}/api/admin/flags/receipts/${receiptId}/${lineIdx}/crop`;
}

export async function fetchFlaggedReceiptCrop(
    receiptId: number,
    lineIdx: number,
): Promise<{ blob: Blob; status: number } | null> {
    const res = await adminFetch(`/api/admin/flags/receipts/${receiptId}/${lineIdx}/crop`);
    if (res.status === 404 || res.status === 422) return null;
    if (!res.ok) throw new Error(`flag crop ${res.status}`);
    const blob = await res.blob();
    return { blob, status: res.status };
}
