import { API_BASE_URL } from '../config/api';

export interface BasketTemplate {
    id: number;
    userId: string;
    name: string;
    isDefault: 0 | 1;
    autoUpdate: 0 | 1;
    visibility: 'private' | 'unlisted' | 'public';
    shareSlug: string | null;
    creatorHandle: string | null;
    sourceTemplateId: number | null;
    useCount: number;
    collectiveSavingsEur: string;
    snapshotCheapestChainId: number | null;
    snapshotTotalEur: string | null;
    snapshotRunnerUpEur: string | null;
    snapshotCalculatedAt: string | null;
    lastAutoUpdateDelta: number | null;
    lastAutoUpdateAt: string | null;
    createdAt: string;
    updatedAt: string;
    itemCount: number;
}

export interface BasketTemplateItem {
    id: number;
    templateId: number;
    productId: number;
    productName: string;
    quantity: string;
    unit: string | null;
    sortOrder: number;
    imageUrls: string[] | null;
    /** Derived from any chain's StoreProduct.isWeighable; signals the
     *  client to render the kg unit + decimal keyboard + 0.1 stepper. */
    isWeighable: 0 | 1;
}

export interface BasketTemplateDetail extends BasketTemplate {
    items: BasketTemplateItem[];
}

export type InstantiateResult =
    | { action: 'created'; basketId: number; templateId: number; itemCount: number }
    | { action: 'resume'; basketId: number; templateId: number };

async function jsonOrThrow(res: Response): Promise<any> {
    if (!res.ok) {
        let detail = '';
        try { detail = JSON.stringify(await res.json()); } catch {}
        throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
    }
    if (res.status === 204) return null;
    return res.json();
}

export async function listTemplates(userId: string): Promise<BasketTemplate[]> {
    const res = await fetch(`${API_BASE_URL}/api/basket-templates/user/${userId}`);
    return jsonOrThrow(res) ?? [];
}

export async function getTemplate(id: number): Promise<BasketTemplateDetail> {
    const res = await fetch(`${API_BASE_URL}/api/basket-templates/${id}`);
    return jsonOrThrow(res);
}

export async function createTemplate(opts: {
    userId: string;
    name: string;
    autoUpdate?: boolean;
    items?: Array<{ productId: number; quantity: number; unit?: string | null; sortOrder?: number }>;
}): Promise<{ id: number; userId: string; name: string; itemCount: number }> {
    const res = await fetch(`${API_BASE_URL}/api/basket-templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
    });
    return jsonOrThrow(res);
}

export async function createTemplateFromBasket(basketId: number, opts: { name: string; autoUpdate?: boolean }): Promise<{ id: number; userId: string; name: string; itemCount: number }> {
    const res = await fetch(`${API_BASE_URL}/api/basket-templates/from-basket/${basketId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
    });
    return jsonOrThrow(res);
}

export async function patchTemplate(id: number, fields: { name?: string; autoUpdate?: boolean }): Promise<BasketTemplate> {
    const res = await fetch(`${API_BASE_URL}/api/basket-templates/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
    });
    return jsonOrThrow(res);
}

export async function deleteTemplate(id: number): Promise<void> {
    await jsonOrThrow(await fetch(`${API_BASE_URL}/api/basket-templates/${id}`, { method: 'DELETE' }));
}

export async function instantiateTemplate(id: number, userId: string, opts: { force?: boolean } = {}): Promise<InstantiateResult> {
    const res = await fetch(`${API_BASE_URL}/api/basket-templates/${id}/instantiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, force: opts.force ?? false }),
    });
    return jsonOrThrow(res);
}

export async function ackAutoUpdate(templateId: number): Promise<void> {
    await jsonOrThrow(await fetch(`${API_BASE_URL}/api/basket-templates/${templateId}/ack-auto-update`, {
        method: 'POST',
    }));
}

// ── Sharing ───────────────────────────────────────────────────────────────

export interface ShareLinkResult {
    slug: string;
    url: string;
    visibility: 'unlisted' | 'public';
    /**
     * Server-rendered, Souply-branded QR PNG URL. Null when MinIO upload
     * failed. The share sheet prefers `qrDataUrl` (inline bytes) because
     * the hosted URL isn't always reachable from the phone in dev / on
     * slow networks.
     */
    qrUrl: string | null;
    /** Inline base64 data URI of the branded QR — same bytes as `qrUrl`,
     *  always reachable, slightly larger on the wire. */
    qrDataUrl: string | null;
    snapshot: {
        cheapestChainId: number | null;
        cheapestTotalEur: number | null;
        runnerUpTotalEur: number | null;
        mostExpensiveTotalEur: number | null;
        calculatedAt: string | null;
    };
}

export async function generateShareLink(templateId: number): Promise<ShareLinkResult> {
    const res = await fetch(`${API_BASE_URL}/api/basket-templates/${templateId}/share`, {
        method: 'POST',
    });
    return jsonOrThrow(res);
}

export async function revokeShareLink(templateId: number): Promise<void> {
    await jsonOrThrow(await fetch(`${API_BASE_URL}/api/basket-templates/${templateId}/share`, {
        method: 'DELETE',
    }));
}

export interface SharedTemplate {
    template: {
        id: number;
        name: string;
        creatorHandle: string | null;
        useCount: number;
        visibility: 'unlisted' | 'public';
    };
    snapshot: {
        cheapestChainId: number | null;
        cheapestTotalEur: number | null;
        runnerUpTotalEur: number | null;
        mostExpensiveTotalEur: number | null;
        calculatedAt: string | null;
    };
    items: Array<{
        productId: number;
        productName: string;
        quantity: number;
        unit: string | null;
        imageUrls: string[] | null;
    }>;
}

export async function fetchSharedTemplate(slug: string): Promise<SharedTemplate> {
    const res = await fetch(`${API_BASE_URL}/api/t/${slug}`);
    return jsonOrThrow(res);
}

// ── Template item CRUD ────────────────────────────────────────────────────

export async function addTemplateItem(templateId: number, item: {
    productId: number;
    quantity: number;
    unit?: string | null;
    sortOrder?: number;
}): Promise<{ id: number; templateId: number; productId: number; quantity: number }> {
    const res = await fetch(`${API_BASE_URL}/api/basket-templates/${templateId}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item),
    });
    return jsonOrThrow(res);
}

export async function patchTemplateItem(templateId: number, itemId: number, fields: {
    quantity?: number;
    sortOrder?: number;
}): Promise<void> {
    await jsonOrThrow(await fetch(`${API_BASE_URL}/api/basket-templates/${templateId}/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
    }));
}

export async function deleteTemplateItem(templateId: number, itemId: number): Promise<void> {
    await jsonOrThrow(await fetch(`${API_BASE_URL}/api/basket-templates/${templateId}/items/${itemId}`, {
        method: 'DELETE',
    }));
}
