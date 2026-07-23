import { useEffect, useState } from 'react';
import { API_BASE_URL } from '../config/api';
import type { ReceiptRegion } from '../components/receipt/ReceiptPhotoView';

/**
 * Loads a SAVED receipt's photo + parser-region overlays for <ReceiptPhotoView>,
 * self-contained (two GETs, no dependency on the 2600-line receipt-process
 * screen):
 *   • GET /api/receipts/:id        → parsedData (regions) + parsed.image dims.
 *     Products come rehydrated from the ReceiptItem table (region column), so the
 *     green per-product bands render for saved receipts too.
 *   • GET /api/receipts/:id/image  → a presigned MinIO URL.
 *
 * Region mapping mirrors receipt-process's <ReceiptPhotoView> props exactly
 * (array-presence semantics: an existing-but-empty lineRegions means "nothing to
 * band"; only a MISSING array falls back to the block region). `drawMasks` is
 * false for saved receipts — the stored image is already redaction-burned.
 */
export interface SavedReceiptPhoto {
    imageUri: string | null;
    imageDims: { width: number; height: number } | null;
    headerRegions: ReceiptRegion[];
    productRegions: ReceiptRegion[];
    footerRegions: ReceiptRegion[];
    skippedRegions: ReceiptRegion[];
    loading: boolean;
}

const EMPTY: SavedReceiptPhoto = {
    imageUri: null, imageDims: null,
    headerRegions: [], productRegions: [], footerRegions: [], skippedRegions: [],
    loading: true,
};

export function useSavedReceiptPhoto(receiptId: number | null): SavedReceiptPhoto {
    const [state, setState] = useState<SavedReceiptPhoto>(EMPTY);

    useEffect(() => {
        if (receiptId == null) { setState(EMPTY); return; }
        let alive = true;
        setState({ ...EMPTY, loading: true });
        (async () => {
            try {
                const [metaRes, imgRes] = await Promise.all([
                    fetch(`${API_BASE_URL}/api/receipts/${receiptId}`),
                    fetch(`${API_BASE_URL}/api/receipts/${receiptId}/image`).catch(() => null),
                ]);
                const receipt = await metaRes.json();
                const parsed = typeof receipt?.parsedData === 'string'
                    ? JSON.parse(receipt.parsedData)
                    : receipt?.parsedData;

                const header = parsed?.header ?? {};
                const footer = parsed?.footer ?? {};
                const products: any[] = Array.isArray(parsed?.products) ? parsed.products : [];

                const w = Number(parsed?.image?.width);
                const h = Number(parsed?.image?.height);
                const imageDims = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0
                    ? { width: w, height: h } : null;

                const headerRegions: ReceiptRegion[] = Array.isArray(header.lineRegions)
                    ? header.lineRegions
                    : header.region ? [header.region] : [];
                const productRegions: ReceiptRegion[] = products.map(p => p.region).filter(Boolean);
                const footerRegions: ReceiptRegion[] = footer.lineRegions && footer.lineRegions.length > 0
                    ? footer.lineRegions
                    : footer.region ? [footer.region] : [];
                const skippedRegions: ReceiptRegion[] = Array.isArray(parsed?.skippedRegions)
                    ? parsed.skippedRegions : [];

                let imageUri: string | null = null;
                try {
                    const imgData = imgRes ? await imgRes.json() : null;
                    if (imgData?.url) imageUri = imgData.url as string;
                } catch { /* no image — fallback rendered by ReceiptPhotoView */ }

                if (!alive) return;
                setState({ imageUri, imageDims, headerRegions, productRegions, footerRegions, skippedRegions, loading: false });
            } catch {
                if (alive) setState({ ...EMPTY, loading: false });
            }
        })();
        return () => { alive = false; };
    }, [receiptId]);

    return state;
}
