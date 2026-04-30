/**
 * In-memory store of the most recent batch run's per-receipt detail.
 * The dev receipt-detail screen reads from this; the dev receipt-batch
 * screen writes after each row finishes.
 *
 * NOT persisted. Refreshing the JS bundle clears the store. That's
 * fine — it's a dev tool and the source of truth (PDFs + truth files)
 * lives on disk anyway.
 */

import type { MaximaProduct, ProductBand } from '../../shared/parsers/maximaParser';
import type { RimiProduct, RimiReceiptBand } from '../../shared/parsers/rimiParser';

/**
 * Either chain's product shape — they're structurally identical
 * (same field names + types) so the receipt-detail UI can render
 * either without branching.
 */
export type ParsedProduct = MaximaProduct | RimiProduct;

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

/**
 * One band's full V2 result: y-coords (for cropping + overlay),
 * extracted product (or null when skipped), and any warnings the
 * extractor attached. 1:1 with the V2 bands list.
 */
export interface BandResult {
    band: ProductBand;
    product: ParsedProduct | null;
    warnings: string[];
}

export interface ReceiptSnapshot {
    chain: string;
    sourcePdf: string;
    pages: PageMeta[];
    /**
     * Maxima V2 step 1 + step 2 output. Each entry has the band's
     * y-range (for the visual overlay and per-band image crop)
     * plus the structured product extracted from it (null for
     * SKIP bands — deposits, plastic bags, TAISYMAS refunds,
     * anchor parse fails).
     */
    bands: BandResult[];
    /**
     * Rimi V2 step 1 output: typed bands across the whole receipt
     * (`store-name`, `store-address`, `product`, `receipt-no`,
     * `datetime`). Step 2 (per-band content extraction) hasn't
     * been built yet, so for now this is purely for visual
     * verification that band geometry is right. Empty for chains
     * that don't have a typed-band parser.
     */
    taggedBands?: RimiReceiptBand[];
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
