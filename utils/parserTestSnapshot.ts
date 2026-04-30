/**
 * In-memory store of the most recent batch run's per-receipt detail.
 * The dev receipt-detail screen reads from this; the dev receipt-batch
 * screen writes after each row finishes.
 *
 * NOT persisted. Refreshing the JS bundle clears the store. That's
 * fine — it's a dev tool and the source of truth (PDFs + truth files)
 * lives on disk anyway.
 */

import type { ProductBand } from '../../shared/parsers/maximaParserV2';

export interface PageMeta {
    /** Filename of the PNG inside /receipts-batch/<chain>/. */
    name: string;
    /** Native pixel width of this page's PNG. */
    pixelWidth: number;
    /** Native pixel height of this page's PNG. */
    pixelHeight: number;
    /**
     * y-offset added to lines from this page when concatenated into
     * the parser's single-y-space input. For single-page receipts
     * always 0. For multi-page, prevYOffset + prevPixelHeight + gap.
     */
    yOffsetInParserSpace: number;
}

export interface ReceiptSnapshot {
    chain: string;
    sourcePdf: string;
    pages: PageMeta[];
    /** V2 step-1 output: contiguous product bands with y-ranges in
     *  parser-space. Step 2 (per-band content extraction) hasn't
     *  been built yet, so V2 emits no products — only band
     *  boundaries for visual inspection. */
    bandsV2: ProductBand[];
}

const snapshots = new Map<string, ReceiptSnapshot>();

export const makeSnapshotKey = (chain: string, sourcePdf: string): string =>
    `${chain}::${sourcePdf}`;

export const setReceiptSnapshot = (key: string, snap: ReceiptSnapshot): void => {
    snapshots.set(key, snap);
};

export const getReceiptSnapshot = (key: string): ReceiptSnapshot | null =>
    snapshots.get(key) ?? null;

export const clearAllSnapshots = (): void => {
    snapshots.clear();
};
