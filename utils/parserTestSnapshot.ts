/**
 * In-memory store of the most recent batch run's per-receipt detail.
 * The dev receipt-detail screen reads from this; the dev receipt-batch
 * screen writes after each row finishes.
 *
 * NOT persisted. Refreshing the JS bundle clears the store. That's
 * fine — it's a dev tool and the source of truth (PDFs + truth files)
 * lives on disk anyway.
 */

import type { MaximaProduct, ProductBand } from '@shared/parsers/maximaParser';
import type { RimiProduct, RimiReceiptBand } from '@shared/parsers/rimiParser';
import type { NorfaProduct, NorfaReceiptBand } from '@shared/parsers/norfaParser';
import type { LidlProduct, LidlReceiptBand } from '@shared/parsers/lidlParser';
import type { MaskBand } from '@shared/parsers/cardMaskDetection';

/**
 * Any chain's product shape — they're structurally identical (same
 * field names + types) so the receipt-detail UI can render any of
 * them without branching.
 */
export type ParsedProduct = MaximaProduct | RimiProduct | NorfaProduct | LidlProduct;

/**
 * Chain-neutral typed-band shape used by the dev overlay. Rimi,
 * Norfa, and Lidl each export a structurally-identical band type;
 * the snapshot stores them as a union so future chains plug in by
 * adding their own band type to this union without changing the
 * detail screen.
 */
export type TaggedReceiptBand =
    | RimiReceiptBand
    | NorfaReceiptBand
    | LidlReceiptBand;

export interface PageMeta {
    /** Filename of the PNG inside /receipts-batch/<chain>/. */
    name: string;
    /** Native pixel width of this page's PNG. */
    pixelWidth: number;
    /** Native pixel height of this page's PNG. */
    pixelHeight: number;
    /** Receipt CONTENT x-bounds (price-column refined, see receiptXBounds) —
     *  band crops use these to skip the PDF page's white margins. Absent on
     *  old snapshots → full-width fallback. */
    receiptXLeft?: number;
    receiptXRight?: number;
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
     * Typed bands across the whole receipt (`store-name`,
     * `store-address`, `product`, `receipt-no`, `datetime`,
     * `total`). Used by the visual overlay on the dev detail
     * screen. Populated by Rimi and Norfa V2 step 1; empty for
     * chains that don't have a typed-band parser.
     */
    taggedBands?: TaggedReceiptBand[];
    /**
     * Bank-card + loyalty-card redaction bands detected by
     * `detectCardMaskBands`. Drawn as solid red/orange strips over the
     * receipt image on the dev detail screen so masking-detection
     * accuracy can be eyeballed on real receipts. Chain-agnostic —
     * populated for every chain, independent of the V2 product bands.
     */
    maskBands?: MaskBand[];
    /**
     * FINAL parsed products (post-normalization, post-heals/grafts) — what
     * actually ships. The item-truth checkmarks assert THESE values; the
     * band list's own extract-level products are display-only.
     */
    products?: {
        name: string;
        price: number;
        promoPrice: number | null;
        quantity: number;
        unit: string;
        parsedAmount?: number | null;
        parsedUnit?: string | null;
    }[];
    /**
     * Footer fields of the FINAL parse — the item-truth footer checkmark on
     * the detail screen asserts these (total/date/receiptNo/recon state).
     */
    footer?: {
        total: number | null;
        date: string | null;
        receiptNo: string | null;
        reconciled: boolean | null;
        reconDelta: number | null;
    };
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
