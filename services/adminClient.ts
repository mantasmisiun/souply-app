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
