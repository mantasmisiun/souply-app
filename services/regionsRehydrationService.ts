import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";
import { Image, Platform } from "react-native";
import TextRecognition from "@react-native-ml-kit/text-recognition";

// iOS-only row-fragment merger for Maxima + Lidl parsers. See
// receipt-process.tsx for the full rationale; same flag for the
// rehydration path so a re-OCR of a legacy receipt on iOS produces
// the same band layout as the original on-upload parse.
const PARSER_OPTS = { iosOcr: Platform.OS === 'ios' };
import { ocrImageTiled } from "../utils/mlkitOcr";
import { API_BASE_URL } from "../config/api";
import { parseRimiReceipt, type LabeledRegion } from "@shared/parsers/rimiParser";
import { parseMaximaReceipt } from "@shared/parsers/maximaParser";
import { parseIkiReceipt } from "@shared/parsers/ikiParser";
import { parseNorfaReceipt } from "@shared/parsers/norfaParser";
import { parseLidlReceipt } from "@shared/parsers/lidlParser";

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
 */
export const REGIONS_VERSION = 'v6.9';

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
    date: string | null;
    time: string | null;
}

const downloadToCache = async (url: string): Promise<string | null> => {
    try {
        const dest = `${FileSystem.cacheDirectory}region_rehydrate_${Date.now()}.img`;
        const { uri } = await FileSystem.downloadAsync(url, dest);
        return uri;
    } catch (e) {
        console.warn("[regionsRehydration] download failed:", e);
        return null;
    }
};

const ensurePortrait = async (uri: string): Promise<string> => {
    const dims = await new Promise<{ width: number; height: number }>(
        (resolve, reject) => {
            Image.getSize(uri, (w, h) => resolve({ width: w, height: h }), reject);
        },
    );
    if (dims.height >= dims.width) return uri;
    const [cw, ccw] = await Promise.all([
        ImageManipulator.manipulateAsync(uri, [{ rotate: 90 }], {
            compress: 1,
            format: ImageManipulator.SaveFormat.JPEG,
        }),
        ImageManipulator.manipulateAsync(uri, [{ rotate: -90 }], {
            compress: 1,
            format: ImageManipulator.SaveFormat.JPEG,
        }),
    ]);
    const [ocrCW, ocrCCW] = await Promise.all([
        TextRecognition.recognize(cw.uri),
        TextRecognition.recognize(ccw.uri),
    ]);
    const count = (r: any) =>
        r.blocks.reduce(
            (s: number, b: any) =>
                s + b.lines.filter((l: any) => l.text.trim().length >= 3).length,
            0,
        );
    return count(ocrCW) >= count(ocrCCW) ? cw.uri : ccw.uri;
};

interface ChainParseSummary {
    headerLineRegions: LabeledRegion[] | undefined;
    footerLineRegions: LabeledRegion[] | undefined;
    total: number | null;
    totalSavings: number | null;
    receiptNo: string | null;
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
    lines: LineWithFrame[],
): ChainParseSummary | null => {
    try {
        const r =
            chainId === 1 ? parseMaximaReceipt(lines, PARSER_OPTS) :
            chainId === 2 ? parseRimiReceipt(lines) :
            chainId === 3 ? parseIkiReceipt(lines) :
            chainId === 4 ? parseNorfaReceipt(lines) :
            chainId === 5 ? parseLidlReceipt(lines, PARSER_OPTS) :
            null;
        if (!r) return null;
        return {
            headerLineRegions: r.header.lineRegions,
            footerLineRegions: r.footer.lineRegions,
            total: typeof r.footer.total === 'number' ? r.footer.total : null,
            totalSavings: typeof r.footer.totalSavings === 'number' ? r.footer.totalSavings : null,
            receiptNo: trimOrNull(r.footer.receiptNo),
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
        const rotated = await ensurePortrait(localUri);
        const ocr = await ocrImageTiled(rotated);
        if (!ocr.lines || ocr.lines.length < 3) return null;

        const result = runChainParser(chainId, ocr.lines);
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
            date: result.date,
            time: result.time,
        };
    } catch (e) {
        console.warn("[regionsRehydration] OCR/parse failed:", e);
        return null;
    } finally {
        // Best-effort cleanup of the temp file. Failures don't matter —
        // cacheDirectory gets reclaimed by the OS.
        FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => {});
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
