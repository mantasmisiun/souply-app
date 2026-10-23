/**
 * Shared receipt parsed-data types + persisted-blob builder.
 *
 * Extracted from app/receipt-process.tsx so the background scan-session
 * pipeline (services/scanSessionService.ts) and the screen share ONE
 * definition of the parsed shapes and of buildParsedData — the blob the
 * server persists. Any divergence here would mean the background pipeline
 * saves a different shape than the interactive screen re-saves on edit.
 */
import { type LoyaltyMoney } from '@shared/parsers/loyaltyMoney';
import type { Region, LabeledRegion } from "@shared/parsers/rimiParser";
import type { ItemConfidence } from "@shared/recognitionConfig";
import { redactReceiptText, type MaskBand } from "@shared/parsers/cardMaskDetection";
import { deriveImageDimsFromGeometry } from "./receiptImage";

// chainId → display name, for the chain-match gate copy.
export const CHAIN_NAMES: Record<number, string> = { 1: 'Maxima', 2: 'Rimi', 3: 'Iki', 4: 'Norfa', 5: 'Lidl' };

export interface ProductMatchOption {
  storeProductId: number;
  productId: number;
  categoryId: number;
  /** Server-joined category label (Phase 0d JOIN Category, server-side).
   *  Optional because pre-redesign receipts may not have it until the
   *  lazy-hydration GET handler backfills them. */
  categoryName?: string | null;
  /** L2 ancestor of categoryName — what the breakdown buckets on. Server
   *  CASE returns null for L1 categories. */
  categoryL2Name?: string | null;
  name: string;
  imageUrl: string | null;
  amount: number | null;
  unit: string | null;
  confidence: number;
  price?: number | null;
  promoPrice?: number | null;
}

export interface ProductLine {
  name: string;
  matchedName: string | null;
  storeProductId: number | null;
  storeProductImageUrl: string | null;
  matchConfidence: number | null;
  matchConfirmed: boolean;
  priceVerified?: boolean;
  /** Set when the USER manually re-matched this line (name-edit rematch flow). The
   *  server's autosave merge honors match fields only for marked lines — see
   *  applyReceiptAutosave — so stale client state can't undo server-side votes. */
  manualMatch?: boolean;
  /** Server-set (read overlay): this line's match contradicts one of the user's old
   *  'different' votes and that vote is queued for a re-verification swipe. The match
   *  renders normally with a small "reconfirm" chip until the re-swipe settles it. */
  pendingReverification?: boolean;
  altMatches: ProductMatchOption[];
  price: number;
  promoPrice: number | null;
  quantity: number;
  /** Receipt quantity unit: "vnt" for pieces, "kg" for weighable. Used for calculation labels. */
  unit: string | null;
  /** Product package size amount (e.g. 165 for CHEETOS 165g). Stored on the SP. */
  amount: number | null;
  /** Product package size unit (e.g. "g", "ml", "rit"). Stored on the SP; separate from `unit`. */
  sizeUnit: string | null;
  pricePerUnit: number | null;
  rawLines: string[];
  region: Region;
  /**
   * Server-computed per-line confidence (DISPLAY-ONLY). Present on receipts
   * saved after the score shipped; null on live-scan lines (the score is
   * computed during save) and on older receipts.
   */
  itemConfidence?: ItemConfidence | null;
  /**
   * Line-level category of the CURRENT primary match — set by the server at save +
   * on every demotion (runner-up → its category; orphan/OCR → null). The summary
   * breakdown prefers these over altMatches[0] (which is a borrowed candidate, not
   * necessarily the linked SP) so a swipe-'different' moves the line to the right
   * bucket. Absent on legacy receipts → breakdown falls back to altMatches[0].
   */
  categoryId?: number | null;
  categoryName?: string | null;
  categoryL2Name?: string | null;
}

/**
 * Map a product line's top match candidate to its stored display/link fields.
 *
 * A WEAK cross-chain fallback match — the candidate came from the cross-chain
 * catalog (`data.crossChain`) AND scored below the auto-apply bar — is too
 * speculative to advertise as "this product": it's another chain's catalog with a
 * sub-autoApply name hit (the slyvos / "IKI mince → another chain's mince" trap).
 * We ORPHAN it here: null matchedName/image/confidence so the receipt row shows
 * the OCR name from the start, while the candidates stay in `altMatches` for
 * orphan-rescue voting. The server then mints a fresh same-chain SP and the line
 * routes to orphan rescue instead of a confident "is this right?" Card-B.
 *
 * Strong (≥ autoApply) cross-chain matches still apply; same-chain matches are
 * untouched (a weak same-chain hit shares the catalog and IS the intended Card-B
 * confirm case).
 */
export function topMatchDisplayFields(
  top: ProductMatchOption | null,
  isCrossChain: boolean,
  autoApply: boolean,
): Pick<
  ProductLine,
  | "matchedName"
  | "storeProductId"
  | "storeProductImageUrl"
  | "matchConfidence"
  | "matchConfirmed"
  | "priceVerified"
> {
  const weakCrossChain = isCrossChain && top !== null && !autoApply;
  return {
    matchedName: weakCrossChain ? null : top?.name ?? null,
    storeProductId: autoApply ? top!.storeProductId : null,
    storeProductImageUrl: weakCrossChain ? null : top?.imageUrl ?? null,
    matchConfidence: weakCrossChain ? null : top?.confidence ?? null,
    matchConfirmed: autoApply,
    priceVerified: autoApply,
  };
}

export interface HeaderData {
  chainName: string;
  chainId: number | null;
  storeCode: string;
  storeAddress: string;
  storeId: number | null;
  storeName: string | null;
  storeAddressMatched: string | null;
  matchConfidence: number | null;
  matchLoading: boolean;
  rawText: string;
  region: Region;
  /** Per-field source-line bboxes (emitted by every chain parser
   *  post-Phase-6 refactor). Optional because pre-refactor receipts in
   *  the DB carry only the block `region`; the photo view falls back
   *  to that single bbox when this array is absent or empty. Each entry
   *  carries a `kind` so the renderer can colour + label per field. */
  lineRegions?: LabeledRegion[];
  /** Parser-output version. Stamped at upload time and updated by
   *  rehydration. Mobile compares against the current `REGIONS_VERSION`
   *  to decide whether to re-OCR a receipt whose persisted bands came
   *  from an earlier parser revision. */
  regionsVersion?: string;
}

export interface FooterData {
  total: number | null;
  date: string;
  time: string;
  receiptNo: string;
  /** Every distinct identifier the footer printed, canonical first, PLUS the
   *  deterministic date+time+total synthetic witness (IKI). The server's
   *  overlap dedup (getReceiptByAnyReceiptNoAndUser) reads this — without it
   *  a scan that lost the printed number and one that captured it share no
   *  identifier and the duplicate sails through. */
  receiptNos?: string[];
  totalSavings: number | null;
  /** Receipt-level combo/set-deal discount (IKI bare "RINKINYS -1,90") — POSITIVE
   *  magnitude off the paid total, owned by no single product. Rendered as an
   *  adjustment row on the Prekės tab; rides parsedData.footer to the server
   *  (savings + store comparison subtract it from the visited basket). */
  comboDiscount: number | null;
  /** Loyalty money moved by this receipt ("Nurašyta MAXIMOS pinigų 0,12"): the
   *  redeemed part is paid from an earned balance AFTER the lines, so the line
   *  sum legitimately exceeds the printed total by that much — reconciliation
   *  and the savings stats both read it. See @shared/parsers/loyaltyMoney. */
  loyalty?: LoyaltyMoney | null;
  rawText: string;
  region: Region;
  lineRegions?: LabeledRegion[];
}

export function buildParsedData(
  header: HeaderData,
  products: ProductLine[],
  footer: FooterData,
  imageMeta: { uri: string | null; width: number; height: number } | null,
  imageFilePath: string | null,
  maskBands: MaskBand[] = [],
  wordsDump?: unknown,
): object {
  // Strip bank/loyalty card numbers + cashier name from everything that gets
  // persisted, so the DB never holds them (the image is redacted separately
  // before upload). Only the free-text carriers need it — structured fields
  // (receiptNo/date/total/storeAddress) are never sensitive.
  // SLIM the persisted blob (see receipt rawData slimming): drop transient/duplicate
  // fields + big image URLs. matchLoading = transient UI state; footer.rawText/region =
  // byte-identical duplicates of header.*; image URLs are re-fetchable by storeProductId.
  // Old receipts keep the fat shape — every reader stays backward-compatible.
  const { matchLoading: _matchLoading, ...slimHeader } = header;
  const { rawText: _footerRawText, region: _footerRegion, ...slimFooter } = footer;
  // Never persist image:null when we have geometry. Losing the OCR coordinate-
  // space dims forces the reopen path into a decoder-sampled re-measure that
  // drifts every band + mask; fall back to the region/word extents so the space
  // is always recoverable.
  const imgDims = imageMeta ?? deriveImageDimsFromGeometry({ header, products, footer, maskBands, wordsDump });
  return {
    version: 1,
    image: imgDims
      ? {
          filePath: imageFilePath,
          width: imgDims.width,
          height: imgDims.height,
        }
      : null,
    header: { ...slimHeader, rawText: redactReceiptText(header.rawText) },
    products: products.map((p) => ({
      ...p,
      rawLines: Array.isArray(p.rawLines) ? p.rawLines.map(redactReceiptText) : p.rawLines,
      // Drop the big image URLs from altMatches (never rendered — only altMatches[0]'s
      // category is read; the displayed thumbnail uses storeProductImageUrl, kept). This
      // is the bulk of the per-receipt bytes: ~3 dup/alt URLs × every product.
      altMatches: Array.isArray(p.altMatches)
        ? p.altMatches.map(({ imageUrl: _ai, ...am }) => am)
        : p.altMatches,
    })),
    footer: slimFooter, // rawText + region dropped (header is the single source of truth)
    // Geometry-only redaction boxes (no card digits) so the Kvitas-tab
    // overlay can re-draw the black "private info" bands on reload.
    maskBands: maskBands.map((b) => ({
      yTop: b.yTop, yBottom: b.yBottom, xLeft: b.xLeft, xRight: b.xRight, kind: b.kind,
      // Keep the per-corner Y (skew) so the reload overlay can bend the black band
      // along the tilted PII row instead of drawing a flat rectangle.
      yLeftTop: b.yLeftTop, yRightTop: b.yRightTop,
      yLeftBottom: b.yLeftBottom, yRightBottom: b.yRightBottom,
      // PII text extent — so a re-clamp on reload still can't trim the band into the card number.
      piiTop: b.piiTop, piiBottom: b.piiBottom,
    })),
    // Per-word OCR capture (staging+prod now, PII redacted at the build site). Top-level
    // so it survives the header-state round-trip. Repro a bad scan with wordsToFixture.mjs.
    ...(wordsDump ? { wordsDump } : {}),
  };
}

/**
 * DEV: paste-friendly dump of what a chain parser produced from the OCR text.
 * Pair with the "DEDUPED RAW TEXT" block above it to review parser accuracy —
 * copy both blocks out of the Metro log when a scanned receipt parses wrong.
 * Defensive field access (`?? '-'`) so it never throws on a partial parse.
 */
export function logParsedReview(chain: string, parsed: any): void {
  try {
    const h = parsed?.header ?? {};
    const f = parsed?.footer ?? {};
    const products: any[] = Array.isArray(parsed?.products) ? parsed.products : [];
    const rows = products.map((p, i) =>
      `  ${String(i + 1).padStart(2, ' ')}. ${p?.name ?? '?'}` +
      ` | price=${p?.price ?? '-'} qty=${p?.quantity ?? '-'} promo=${p?.promoPrice ?? '-'}` +
      `${p?.brandName ? ` brand=${p.brandName}` : ''}` +
      `${p?.isWeighable ? ' [kg]' : ''}` +
      `${p?.categoryId != null ? ` cat=${p.categoryId}` : ''}`,
    );
    console.log(
      `=== PARSED REVIEW [${chain}] (${products.length} products) ===\n` +
      `header: store=${h.storeName ?? '-'} | code=${h.storeCode ?? '-'} | addr=${h.storeAddress ?? '-'} | chainId=${h.chainId ?? '-'}\n` +
      `footer: total=${f.total ?? '-'} | date=${f.date ?? '-'} | receiptNo=${f.receiptNo ?? '-'} | savings=${f.totalSavings ?? '-'}\n` +
      `${rows.join('\n')}\n` +
      `=== END PARSED [${chain}] ===`,
    );
  } catch (e) {
    console.log(`[PARSED REVIEW ${chain}] log failed`, e);
  }
}
