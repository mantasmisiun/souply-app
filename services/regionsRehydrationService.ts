import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";
import { ocrReceiptPages } from "../utils/receiptOcrPipeline";
import { API_BASE_URL } from "../config/api";
import { parseRimiReceipt, type LabeledRegion } from "@shared/parsers/rimiParser";
import { parseMaximaReceipt } from "@shared/parsers/maximaParser";
import { parseIkiReceipt } from "@shared/parsers/ikiParser";
import { parseNorfaReceipt } from "@shared/parsers/norfaParser";
import { parseLidlReceipt } from "@shared/parsers/lidlParser";

// iOS-only row-fragment merger for Maxima + Lidl parsers. See
// receipt-process.tsx for the full rationale; same flag for the
// rehydration path so a re-OCR of a legacy receipt on iOS produces
// the same band layout as the original on-upload parse.
const PARSER_OPTS = { iosOcr: Platform.OS === 'ios' };

/**
 * On-open region rehydration for legacy receipts.
 *
 * Pre-Phase-5 receipts stored only a single block bbox per section
 * (header, footer). After the parser refactor, fresh uploads emit one
 * `lineRegions[]` entry per parsed field (store name, address, total,
 * date/time, receipt №).
 *
 * To upgrade old receipts without a batch migration, this service:
 *   1. Downloads the cached receipt image (already in MinIO).
 *   2. Re-runs OCR + the chain parser locally.
 *   3. Returns ONLY header.lineRegions and footer.lineRegions.
 *   4. The caller PATCHes them server-side so the next open is free.
 *
 * Surgical-on-purpose: products/totals/receiptNo etc. are NEVER
 * touched, so any edits the user has made since upload survive.
 *
 * Failure modes (silent return null, caller keeps the block bbox):
 *   • imageUrl missing or unreachable
 *   • OCR returns no usable text
 *   • chain unsupported / chainId unknown
 *   • parser throws
 */

/**
 * Bump when parser changes ALTER the bands that get emitted (added
 * kinds, fixed false-positives, captured a new field, etc.). Mobile
 * uses this to force re-OCR + re-parse on receipts whose persisted
 * lineRegions came from an older parser revision.
 *
 * History:
 *   v6.0 — first labelled (kind-tagged) regions
 *   v6.1 — Rimi receiptNo anchored (no BANKO false match);
 *          Norfa receiptNo fallback band tracked
 *   v6.2 — Rimi Mokėti label-only path uses TOTAL_LABEL_RE + relaxed
 *          parseAmount (covers "Mokėti EUR" + "N,NN EUR" forms);
 *          Norfa receiptNo also matches "Kvito Nr." short label
 *   v6.3 — Rimi total scan: y-range overlap (not center distance) for
 *          same-row + stacked-row fallback (Mokėti label on its own
 *          OCR line above the amount)
 *   v6.4 — Rimi Mokėti / sutaupėte regex char class widened to accept
 *          `ê`/`ë` (OCR substitution of `ė` on some PDFium-rendered
 *          receipts); path-1 guarded against overwriting a set total
 *   v6.5 — Rehydration also backfills footer.total + footer.totalSavings
 *          when the stored value is null (fixes receipts whose original
 *          parse hit the v6.4 regex bug and persisted null total).
 *   v6.6 — Rimi Mokėti label band tracked unconditionally (mirrors V2);
 *          Pass B forward scan extended to 10 lines (catches VAT row
 *          Suma-su-PVM as total when MLKit drops the integer half of
 *          the Mokėti amount on bold-rendered receipts).
 *   v6.7 — Rehydration trigger runs on screen mount (not gated on
 *          Kvitas-tab activation); total/totalSavings backfill is
 *          authoritative when re-parse produces a number (overwrites
 *          stale persisted values instead of only filling nulls).
 *   v6.8 — Rehydration backfill extended to identity fields
 *          (receiptNo, date, time). Fixes receipts whose stored
 *          parsedData drifted from the image they reference — most
 *          commonly when the dev batch tool created multiple Receipt
 *          rows with colliding filePath but different parsedData.
 *   v6.9 — Rimi receiptNo passes through ocrDigit (l/I→1, o/O→0) so
 *          OCR letter contamination ("l6/643/33366") doesn't reach
 *          the DB — Rimi numbers are pure digits + slashes.
 *   v7.0 — IKI photographed (thermal) parser overhaul: scrambled-OCR
 *          product recovery, coupon/discount/NUOLAIDA-fusion handling,
 *          chain-agnostic address strip, split company-code detection,
 *          AND a band-rendering overhaul — every section (header /
 *          products / footer / masks) now emits skew-aware quad bands,
 *          time (Laikas) is banded, and the total is banded on EVERY
 *          form (SUMA same-line / SUMA-split-two-lines / Mokėti). This
 *          bump RE-DERIVES all previously-saved receipts so they pick
 *          up the new bands instead of keeping their stale v6.x set.
 *   v7.1 — IKI thermal band seams now use a gap-aware MIDPOINT tiler:
 *          each band keeps its true content box (name-top + price-row
 *          bottom) and seams drop to the midpoint between a row's bottom
 *          and the next row's top, so dense price/discount rows are no
 *          longer clipped at the seam. Still gap-free + overlap-free.
 *   v7.2 — IKI band BOTTOM now anchors to the product's price/weight row,
 *          NOT its trailing full-width "NUOLAIDA SU KORTELE" label (whose
 *          tilted left-bottom corner dragged the seam through the next
 *          name). Names + prices stay whole. Also: the time band is sliced
 *          to just "Laikas HH:MM:SS" when it shares a line with a prefix.
 *   v7.3 — weighed item with a split weight row ("0,72" + "0 kg X 3,99")
 *          and no printed total now derives total = qty × €/kg, instead
 *          of mistaking the "0,72" quantity fragment for a 0,72 € total.
 *   v7.4 — bands are now TIGHT: each hugs its own content (+ small margin)
 *          and leaves a GAP over garbled/unrecognised rows instead of
 *          stretching to the next product (fixes bands "absorbing" several
 *          products on heavily-fused scans); still never overlap. Plus a
 *          corner/frame reconciliation so a footer band (e.g. "Kvito Nr.")
 *          can't float above its text when MLKit corners cover only the
 *          top of a tall merged line box.
 *   v7.5 — two product names fused on one OCR row by a line-total's VAT
 *          letter ("LYDYTAS … 99 A LIETUVISKI POMIDORAI") now split into
 *          separate products at the "<price> A" boundary.
 *   v7.6 — STABILITY: product bands reverted to a dead-simple EDGE-TO-EDGE
 *          partition. Each band = its NAME-line box; the tiler drops each
 *          bottom to the next product's name top (per-corner). Every
 *          product owns one contiguous, gap-free, non-overlapping slice.
 *          No content-chasing / margins / heuristics — the seam is always
 *          the next recognised name (replaces the unstable tight-band tiler).
 *   v7.7 — removed the header/footer corner→frame "reconciliation" (a v7.4
 *          misdiagnosis of the landscape image-space bug): it flattened a
 *          band to its OCR frame box, which can span several merged rows, so
 *          "Kvito Nr." rendered as a tall rectangle over extra lines and the
 *          cashier mask. Footer/header bands now always use their own bent
 *          corner points → hug the single line they came from.
 *   v7.8 — header→product boundary: product 1's top is now CLAMPED DOWN to
 *          the header edge (only pushed below it to avoid overlap), instead
 *          of being pulled UP to it. The first band starts on its own name,
 *          so the PVM-code line + dashed separator above stay a clean gap
 *          instead of being absorbed into the first product band.
 *   v7.9 — TILT from per-word ELEMENT frames. MLKit often returns a line's
 *          cornerPoints flat even on visibly skewed text; each word's frame
 *          steps with the skew, so we derive the true slope from the
 *          leftmost+rightmost words (mlkitOcr) and CONTINUE that slope when a
 *          band is widened to the section width (so the right-aligned price is
 *          covered, not clipped). Bands now bend to match the OCR'd text.
 *  v7.10 — per-line element slopes were NOISY (flat on some rows, steep on
 *          others → wavy bands clipping prices). A receipt has ONE physical
 *          tilt, so take the MEDIAN element slope across the page and apply it
 *          UNIFORMLY: every line becomes a clean parallelogram at the same
 *          skew, seams stay parallel, prices no longer sliced by a rogue tilt.
 *  v7.11 — global tilt was WRONG: the receipt CURVES (less skew at top, more at
 *          bottom). Back to PER-LINE tilt from each line's own words, but made
 *          smooth+robust: lines with too few words inherit the nearest measured
 *          slope (no flat fallback — that caused trapezoids), then median-smooth
 *          over 3 neighbours so a garbled row can't spike the tilt. Tilt now
 *          follows the real curve down the page.
 *  v7.12 — per-WORD element boxes are now threaded through to the parser
 *          (OcrLine/LineWithFrame/IkiLine `.words`). The "Kvito Nr." band is
 *          anchored to the real "Kvito" (left) and "Kasa" (right) word boxes —
 *          each side's own top/bottom Y, so it bends with the curve and hugs
 *          that one line. Falls back to "0027" then last word, then line box.
 *  v7.13 — word-anchoring extended to EVERY band: regionFor spans first→last
 *          word (storeAddress, storeCode, date/dateTime, total), the time band
 *          anchors "Laikas"→time-value word, and the black redaction masks
 *          (bank/loyalty/cashier) anchor to the actual masked words (real x +
 *          per-word Y, padded to keep over-covering). All fall back to the old
 *          char→x / line-box geometry when per-word data is absent.
 *  v7.14 — mask BEND fix: a single-word redaction (e.g. the PAN) anchored to one
 *          word's flat box couldn't bend. Now the box keeps word-precise x but
 *          takes its TILT from the line's own slope (≥2 words still use the real
 *          word Y), so even a one-word mask follows the receipt curve.
 *   v8.0 — IKI COLUMN ENGINE (flag-gated, falls back to the legacy tokenizer):
 *          rebuilds physical rows from per-WORD boxes (ignores MLKit line
 *          grouping), assembles products off the right-column positive-total
 *          ladder with left-name reconcile + guarded recovery, and bands them
 *          edge-to-edge with each seam tilted by the row's own local slope.
 *          Resolves OCR line fusion/splits + column scramble (matches name↔price
 *          by Y, not OCR order). Runs only when ≥60% of product rows carry words.
 *   v8.1 — column-engine product bands are now the TWO-BOX dual-curve (Idea 3):
 *          a name box [xLeft..xMid] joined to a price box [xMid..xRight] at the
 *          mid column, so the left edge rides the name row and the right edge
 *          rides the PRICE row (no diagonal clipping the middle rows). Region
 *          gains optional xMid/yMidTop/yMidBottom → rendered as a 6-point polygon.
 *   v8.2 — column-engine ASSEMBLY fixes (receipt-44 heavy-fusion failures): a
 *          product accumulates its rows until the next product starts — discounts
 *          (which print AFTER the total in IKI) attach to the current product, not
 *          the next; a name fused onto a discount line starts the NEXT product (no
 *          more "?" names / wrong promos); a name fused before a weight is
 *          recovered. rawLines now carries the FULL row text per product.
 *   v8.3 — column-engine: (a) "NUOLAIDA SU KORTELĖ" discount-label tails (garbled
 *          "SU K HT", "ŠU KORTEL.") are no longer mistaken for product names → no
 *          more phantom products; (b) a line-total fused onto the weight row
 *          ("… EUR/kg 18,15 A") is now captured, so weighed items get the right
 *          quantity + promo instead of a negative promoPrice.
 *   v8.4 — PER-COLUMN row clustering: the left column (names/weights/labels) and
 *          right column (prices/amounts) are clustered SEPARATELY (each narrow in
 *          x → clean Y), then merged by curve-normalized Y. A wide physical row
 *          can't be split or mis-merged by cross-column tilt error, and a price
 *          OCR'd far from its name re-joins it by Y. Replaces single-pass cluster.
 *   (v8.5–v8.42 — parser-revision bumps whose individual notes were not logged
 *          here; see the shared/parsers git history for the changes each covered.
 *          Bump discipline restored below — log every bump.)
 *  v8.43 — rehydration re-parses through the SHARED OCR pipeline (ocrReceiptPages:
 *          rotation + tiling + row merge) and IKI now parses the row-MERGED lines —
 *          the same funnel as the upload/queue/recovery. The old path fed IKI raw
 *          unmerged lines from a separate rotate+tile, so the value backfill
 *          (total/date/receiptNo) could authoritatively overwrite stored fields
 *          with a DIFFERENT parse of the same photo. Bumped so stale receipts
 *          re-derive once through the aligned funnel.
 */
export const REGIONS_VERSION = 'v8.43';

interface LineWithFrame {
    text: string;
    yTop: number;
    yBottom: number;
    xLeft: number;
    xRight: number;
}

export interface RehydratedRegions {
    headerLineRegions: LabeledRegion[];
    footerLineRegions: LabeledRegion[];
    /** Re-parsed footer values, surfaced for authoritative backfill
     *  (caller overwrites stale persisted values when the parser
     *  produces a fresh result — REGIONS_VERSION bump is the cue
     *  that the parser revision changed and the DB needs re-deriving).
     *
     *  Why this isn't just regions: filePath isn't a unique identity
     *  for parsedData. Dev batch tool can create multiple Receipt
     *  rows pointing to the same image — when the image gets
     *  refreshed via pdftoppm overwrite, older rows are left holding
     *  parsedData from a now-stale image. Backfilling identity fields
     *  (receiptNo, date, time) from the re-parse converges those
     *  rows back to the image they actually show. */
    total: number | null;
    totalSavings: number | null;
    receiptNo: string | null;
    /** The FULL identifier set from the re-parse — sent so the server can refresh the
     *  receiptNos column (a re-parse that finds more ids than the original must not leave
     *  the functional column stuck on the stale single value — receipt-143). */
    receiptNos: string[] | null;
    date: string | null;
    time: string | null;
}

const downloadToCache = async (url: string): Promise<string | null> => {
    if (!url) return null;
    // A LOCAL file (a fresh-scan camera image, file://...) is already on disk — feeding it
    // to downloadAsync makes it resolve to null and the `{ uri }` destructure then throws
    // "Cannot read property 'uri' of null" (the reported warning). Use it directly; only a
    // remote http(s) URL (a saved receipt's stored image) needs the download. Both platforms.
    if (/^file:|^content:|^ph:|^assets-library:/i.test(url)) return url;
    try {
        const dest = `${FileSystem.cacheDirectory}region_rehydrate_${Date.now()}.img`;
        const res = await FileSystem.downloadAsync(url, dest);
        return res?.uri ?? null; // null-safe: don't destructure a possibly-null result
    } catch (e) {
        console.warn("[regionsRehydration] download failed:", e);
        return null;
    }
};


interface ChainParseSummary {
    headerLineRegions: LabeledRegion[] | undefined;
    footerLineRegions: LabeledRegion[] | undefined;
    total: number | null;
    totalSavings: number | null;
    receiptNo: string | null;
    receiptNos: string[] | null;
    date: string | null;
    time: string | null;
}

const trimOrNull = (s: unknown): string | null => {
    if (typeof s !== 'string') return null;
    const t = s.trim();
    return t.length > 0 ? t : null;
};

const runChainParser = (
    chainId: number,
    allLines: LineWithFrame[],
    mergedLines: LineWithFrame[],
): ChainParseSummary | null => {
    try {
        // SAME allLines-vs-mergedLines split as the interactive scan, the headless
        // queue and account recovery: IKI parses the row-MERGED stream. The old code
        // fed IKI raw unmerged (and non-row-merged) lines, so the re-parse produced a
        // DIFFERENT total/date/receiptNo than the upload and then authoritatively
        // backfilled those wrong values into the stored receipt on reopen.
        const r =
            chainId === 1 ? parseMaximaReceipt(allLines, PARSER_OPTS) :
            chainId === 2 ? parseRimiReceipt(allLines) :
            chainId === 3 ? parseIkiReceipt(mergedLines) :
            chainId === 4 ? parseNorfaReceipt(allLines) :
            chainId === 5 ? parseLidlReceipt(allLines, PARSER_OPTS) :
            null;
        if (!r) return null;
        return {
            headerLineRegions: r.header.lineRegions,
            footerLineRegions: r.footer.lineRegions,
            total: typeof r.footer.total === 'number' ? r.footer.total : null,
            totalSavings: typeof r.footer.totalSavings === 'number' ? r.footer.totalSavings : null,
            receiptNo: trimOrNull(r.footer.receiptNo),
            receiptNos: Array.isArray((r.footer as any).receiptNos)
                ? (r.footer as any).receiptNos.filter((v: unknown): v is string => typeof v === 'string' && v.trim().length > 0)
                : null,
            date: trimOrNull(r.footer.date),
            time: trimOrNull(r.footer.time),
        };
    } catch (e) {
        console.warn(`[regionsRehydration] parser threw for chain ${chainId}:`, e);
        return null;
    }
};

/**
 * Run OCR + chain parser on the cached image, return per-field bboxes
 * for header and footer. Returns null on any failure — caller keeps
 * showing the legacy block bbox.
 */
export const computeRehydratedRegions = async (
    imageUrl: string,
    chainId: number | null,
): Promise<RehydratedRegions | null> => {
    if (!imageUrl || chainId == null) return null;

    const localUri = await downloadToCache(imageUrl);
    if (!localUri) return null;

    try {
        // The SHARED OCR pipeline (rotation + tiling + multi-page merge) — the same
        // funnel the upload and recovery use, so a re-parse can't drift from them.
        const { allLines, mergedLines } = await ocrReceiptPages([localUri]);
        if (!allLines || allLines.length < 3) return null;

        const result = runChainParser(chainId, allLines, mergedLines);
        if (!result) return null;

        const header = Array.isArray(result.headerLineRegions) ? result.headerLineRegions : [];
        const footer = Array.isArray(result.footerLineRegions) ? result.footerLineRegions : [];
        // Surface even an empty regions result when any identity/
        // value field came back — the caller may still want to
        // backfill. Only bail when EVERYTHING is missing.
        const hasAnyValue =
            result.total !== null ||
            result.totalSavings !== null ||
            result.receiptNo !== null ||
            result.date !== null ||
            result.time !== null;
        if (header.length === 0 && footer.length === 0 && !hasAnyValue) {
            return null;
        }

        return {
            headerLineRegions: header,
            footerLineRegions: footer,
            total: result.total,
            totalSavings: result.totalSavings,
            receiptNo: result.receiptNo,
            receiptNos: result.receiptNos,
            date: result.date,
            time: result.time,
        };
    } catch (e) {
        console.warn("[regionsRehydration] OCR/parse failed:", e);
        return null;
    } finally {
        // Best-effort cleanup — but ONLY of the temp copy THIS service downloaded
        // (region_rehydrate_*). Since downloadToCache started returning LOCAL file://
        // sources as-is (the fresh-scan fix), `localUri` can be the CALLER'S image —
        // deleting it destroyed the re-OCR source mid-session ("File …reocr_298….jpg
        // is not readable": no receipt photo, no band crops — user report 2026-07-04).
        if (localUri.includes('region_rehydrate_')) {
            FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => {});
        }
    }
};

/**
 * PATCH the recomputed regions to the server so the next open is free.
 * Best-effort: a write failure just means the user will pay the
 * re-OCR cost again on next open, never a hard error.
 *
 * Includes `regionsVersion` so the server records which parser
 * revision produced these bands. Mobile reads it on next open to
 * decide whether another re-OCR is needed.
 */
export const persistRehydratedRegions = async (
    receiptId: number,
    regions: RehydratedRegions,
): Promise<void> => {
    try {
        await fetch(`${API_BASE_URL}/api/receipts/${receiptId}/regions`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...regions, regionsVersion: REGIONS_VERSION }),
        });
    } catch (e) {
        console.warn("[regionsRehydration] PATCH failed:", e);
    }
};

/**
 * CONVERGENCE stamp: mark a receipt's stored regions as the CURRENT parser revision
 * WITHOUT re-deriving geometry. Sent with empty region arrays — the server skips a
 * zero-length lineRegions update (keeps the stored bands) and applies only the
 * version. Called when re-OCR is unavailable (image not cached / OCR too sparse) so a
 * stale or kindless receipt stops re-firing the rehydration — and therefore stops
 * accumulating the per-reopen band drift — instead of retrying (and re-deriving a
 * slightly different geometry) on every open.
 */
export const markRegionsVersionCurrent = async (receiptId: number): Promise<void> => {
    try {
        await fetch(`${API_BASE_URL}/api/receipts/${receiptId}/regions`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ headerLineRegions: [], footerLineRegions: [], regionsVersion: REGIONS_VERSION }),
        });
    } catch (e) {
        console.warn("[regionsRehydration] version stamp failed:", e);
    }
};
