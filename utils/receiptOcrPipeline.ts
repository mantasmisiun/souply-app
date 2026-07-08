import TextRecognition from "@react-native-ml-kit/text-recognition";
import * as ImageManipulator from "expo-image-manipulator";
import { Image } from "react-native";
import { ocrImageEnhanced, type OcrEngine } from "./mlkitOcr";

/**
 * SINGLE SOURCE OF TRUTH for turning receipt image/PDF-page URIs into the OCR
 * line input the shared parsers consume.
 *
 * EVERY receipt-parsing surface MUST go through `ocrReceiptPages` so the exact
 * same lines reach the parsers regardless of entry point:
 *   - the Analyze-tab headless queue (`services/receiptProcessingService.ts`)
 *   - account recovery (`services/recoveryOcr.ts`)
 *  (the interactive `app/receipt-process.tsx` inlines an equivalent pass that
 *   also collects per-page crop/mask geometry; its merge math is identical.)
 *
 * Why this matters: account recovery matches a re-OCR'd receipt against the
 * total stored at upload time. If the two paths group lines even slightly
 * differently (e.g. a frameScale-unaware merge threshold, or skipping the
 * portrait rotation), the parsed total drifts by a few cents and the match
 * fails. Sharing the pipeline removes that whole class of divergence.
 */

export interface LineWithFrame {
    text: string;
    yTop: number;
    yBottom: number;
    xLeft: number;
    xRight: number;
    // Skew-aware edge Y (from MLKit cornerPoints) — top/bottom Y at the line's
    // left vs right edge. Optional; absent → axis-aligned yTop/yBottom.
    yLeftTop?: number;
    yRightTop?: number;
    yLeftBottom?: number;
    yRightBottom?: number;
    // Per-word boxes (MLKit elements), for word-anchored bands. Carry the same
    // y-offset as the line.
    words?: { text: string; xLeft: number; xRight: number; yTop: number; yBottom: number; cornerPoints?: { x: number; y: number }[] }[];
}

export interface ReceiptOcrPageMeta {
    /** Post-rotation page uri (what OCR actually ran on). */
    uri: string;
    pixelWidth: number;
    pixelHeight: number;
    frameScale: number;
    /** This page's y-offset in the concatenated parser space. */
    yOffsetScaled: number;
    /** Max line yBottom on this page (page-local, pre-offset). */
    pageMaxYScaled: number;
    /** Receipt CONTENT x-bounds — density histogram refined to the price
     *  column (see computeReceiptXBoundsForPage). Band crops use these to
     *  skip PDF page margins. */
    receiptXLeftScaled: number;
    receiptXRightScaled: number;
}

export interface ReceiptOcrResult {
    /** Raw OCR lines (page-pixel space, multi-page y-offset applied), sorted top→bottom. */
    allLines: LineWithFrame[];
    /** Same lines after the adjacent-row merge pass (Iki + chain detection use these). */
    mergedLines: LineWithFrame[];
    /** OCR downscale factor of page 0 — drives the merge threshold. */
    frameScale: number;
    /** First page, post-rotation: what the upload + crop run against. */
    firstPageUri: string;
    firstPageWidth: number;
    firstPageHeight: number;
    /** Per-page metadata (rotation-corrected uris, y-offsets, x-bounds). */
    pageMetas: ReceiptOcrPageMeta[];
}

/**
 * Receipt horizontal bounds for ONE page — the SINGLE implementation shared by
 * the live scan, the recovery flow and the dev batch (they must never drift):
 * a 20-px text-density histogram (percentile bounds fail when sparse edge
 * lines — dividers, logos — keep outer bins alive), then the price-column
 * clamp: the VAT letter after each price is the receipt's rightmost REAL
 * content, so ≥3 price-tail lines pull the right bound in (narrow-only,
 * right-half guarded).
 */
export function computeReceiptXBoundsForPage(
    lines: { xLeft: number; xRight: number; text: string }[],
    pageWidth: number,
    logLabel?: string,
): { left: number; right: number; peak: number } {
    const BIN = 20;
    const nBins = Math.max(1, Math.ceil(pageWidth / BIN));
    const hist = new Array(nBins).fill(0);
    for (const { xLeft: l, xRight: r } of lines) {
        const lo = Math.max(0, Math.floor(l / BIN));
        const hi = Math.min(nBins - 1, Math.floor(Math.max(l, r - 1) / BIN));
        for (let b = lo; b <= hi; b++) hist[b]++;
    }
    const peak = hist.reduce((m, v) => Math.max(m, v), 0);
    const densityThresh = Math.max(1, peak * 0.08);
    let leftBin = 0;
    while (leftBin < nBins && hist[leftBin] < densityThresh) leftBin++;
    let rightBin = nBins - 1;
    while (rightBin >= 0 && hist[rightBin] < densityThresh) rightBin--;
    let left = leftBin * BIN;
    let right = (rightBin + 1) * BIN;
    if (right <= left) { left = 0; right = pageWidth; }
    const PRICE_TAIL_RE = /-?\d{1,4}[.,]\s?\d{2}\s*[ABC]\s*$/;
    const tails = lines.filter((l) => PRICE_TAIL_RE.test(l.text.trim()));
    if (tails.length >= 3) {
        const colRight = Math.max(...tails.map((l) => l.xRight)) + 12;
        const mid = left + (right - left) / 2;
        if (colRight < right && colRight > mid) {
            if (logLabel) {
                console.log(`${logLabel} price-column right clamp: ${Math.round(right)} → ${Math.round(colRight)} (${tails.length} price tails)`);
            }
            right = colRight;
        }
    }
    return { left, right, peak };
}

/**
 * Camera photos held sideways arrive as landscape. Rotate to portrait (trying
 * both directions and keeping whichever OCRs to more lines) so the parser sees
 * the receipt upright. No-op for images already in portrait.
 */
export async function rotatePortrait(uri: string): Promise<string> {
    const dims = await new Promise<{ width: number; height: number }>(
        (resolve, reject) => {
            Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
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
    const countLines = (r: { blocks: { lines: unknown[] }[] }) =>
        r.blocks.reduce((s, b) => s + b.lines.length, 0);
    return countLines(ocrCW) >= countLines(ocrCCW) ? cw.uri : ccw.uri;
}

export interface CropResult {
    uri: string;
    width: number;
    height: number;
}

/**
 * Crop a captured receipt photo down to just the receipt, using the OCR text
 * geometry as a cheap, dependency-free edge detector: the union of all text
 * boxes (with padding) is the receipt's printed region; everything outside it
 * is background (table, hand, shadow). This avoids pulling in OpenCV / a native
 * contour detector while still isolating the receipt in the common guided-scan
 * case where text fills the paper top-to-bottom.
 *
 * `lines` MUST be in `uri`'s pixel space (i.e. the `allLines` that
 * `ocrReceiptPages` returns for this same page). Horizontal bounds use the
 * 5th/95th percentile so a single stray background read can't balloon the box;
 * vertical bounds keep the full text span. Returns the original uri unchanged
 * when there's too little text to trust a crop or the content already fills the
 * frame.
 */
export async function cropToContentBounds(
    uri: string,
    lines: LineWithFrame[],
    pageWidth: number,
    pageHeight: number,
): Promise<CropResult> {
    if (lines.length < 4 || pageWidth <= 0 || pageHeight <= 0) {
        return { uri, width: pageWidth, height: pageHeight };
    }

    let top = Infinity;
    let bottom = -Infinity;
    const lefts: number[] = [];
    const rights: number[] = [];
    for (const l of lines) {
        if (l.yTop < top) top = l.yTop;
        if (l.yBottom > bottom) bottom = l.yBottom;
        lefts.push(l.xLeft);
        rights.push(l.xRight);
    }
    lefts.sort((a, b) => a - b);
    rights.sort((a, b) => a - b);
    const pct = (arr: number[], p: number) =>
        arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)))];
    let left = pct(lefts, 0.05);
    let right = pct(rights, 0.95);

    // Pad outward so the printed edge / a clipped last char is never shaved.
    const padX = pageWidth * 0.05;
    const padY = pageHeight * 0.02;
    left = Math.max(0, left - padX);
    right = Math.min(pageWidth, right + padX);
    top = Math.max(0, top - padY);
    bottom = Math.min(pageHeight, bottom + padY);

    const cropW = Math.round(right - left);
    const cropH = Math.round(bottom - top);
    // Degenerate, or already ~full-frame → not worth a re-encode.
    if (cropW < 24 || cropH < 24) {
        return { uri, width: pageWidth, height: pageHeight };
    }
    if (cropW >= pageWidth * 0.96 && cropH >= pageHeight * 0.96) {
        return { uri, width: pageWidth, height: pageHeight };
    }

    const out = await ImageManipulator.manipulateAsync(
        uri,
        [{ crop: { originX: Math.round(left), originY: Math.round(top), width: cropW, height: cropH } }],
        { compress: 0.95, format: ImageManipulator.SaveFormat.JPEG },
    );
    return { uri: out.uri, width: out.width, height: out.height };
}

// ── FUSED-ROW STRIP RE-OCR (document mode) ─────────────────────────────────
// Vision/ML Kit occasionally merge two printed rows into ONE double-height
// garbled line even when the pixels are pristine and cleanly separated — a
// layout-specific line-GROUPING failure (0AE04F24: the short "RIMI SMART, 1 l"
// row chained into "Makaronai be glitimo BARILLA" below it at every image
// quality, while the identical product block on 26117700 read perfectly).
// The cure is context isolation: crop exactly the fused box's y-range and
// re-OCR the strip alone — with nothing to mis-group against, engines read
// isolated strips reliably. The strip's lines then REPLACE everything whose
// center falls in that range (the fused box AND partial duplicate reads like
// a lone "Makaronai" or the same-row price, which the full-width strip
// re-reads). Fail-safe: the splice is accepted only when the strip read is
// demonstrably better — otherwise the fused box stays and the parser-side
// quarantine handles it exactly as before.

const isFusedBodyText = (l: { text: string }): boolean =>
    l.text.trim().length >= 8 && l.text.trim().includes(' ');

export interface FusedStripPlan {
    /** Crop bounds (page-local px). */
    top: number;
    bottom: number;
    /** The fused line's text (for logging). */
    fusedText: string;
    /** Indices (into the page's line array) replaced by the strip's read. */
    replacedIdx: number[];
    /** Median body-line height (acceptance check reuses it). */
    medianH: number;
    /** INSERTION plan: the strip covers a zone where a row was DROPPED —
     *  nothing is replaced; accepted lines are ADDED. Its acceptance rule
     *  differs: ≥1 body line that isn't a duplicate of the surrounding
     *  context (see reocrFusedRows). */
    insertion?: boolean;
    /** GARBLED-ANCHOR plan: the row's pixels are clean but the engine
     *  returned garbage for BOTH the name and the anchor (Norfa-04-23 "Žemės
     *  riešutai GAR2, 500g  2x1,49 2,98 M1" → "CAD" + "2v1 Aa ae M1"). A
     *  sporadic engine miss, not damage. Acceptance: the re-OCR must produce
     *  a CLEAN anchor line (price/weighable + VAT suffix) that the garbled
     *  originals lacked — proof the row was recovered (see reocrFusedRows). */
    garbled?: boolean;
}

// A clean anchor line: total + VAT suffix (Norfa `N,NN M1`/`M5`, Rimi `N,NN
// A`/`B`, incl. Cyrillic homoglyphs). Also matches the tail of a weighable
// "qty x ppu TOTAL M1". Used to tell a recovered row from a garbled one.
const CLEAN_ANCHOR_RE = /(?:^|\s)\d+[.,]\s?\d{2}\s*(?:M\s*[15]|[ABАВ])\s*$/i;
const ANCHOR_SUFFIX_RE = /(?:M\s*[15]|[ABАВ])\s*$/i;

/**
 * Pure planner: find fused boxes (double-height body lines spanning two
 * mutually-disjoint rows — same signature as the Rimi parser / ensemble
 * detectors) and compute for each the strip bounds + the lines the strip
 * replaces. Exported for tests.
 */
export function planFusedStrips(
    lines: { text: string; yTop: number; yBottom: number; xLeft?: number; xRight?: number }[],
    pageHeight: number,
): FusedStripPlan[] {
    const hs = lines
        .filter(isFusedBodyText)
        .map((l) => l.yBottom - l.yTop)
        .filter((h) => h > 0)
        .sort((a, b) => a - b);
    if (hs.length < 8) return [];
    const medianH = hs[Math.floor(hs.length / 2)];
    if (!(medianH > 0)) return [];

    const spansTwoRows = (c: { yTop: number; yBottom: number }): boolean => {
        const inside = lines.filter((o) => {
            if (o === c) return false;
            const oh = o.yBottom - o.yTop;
            if (oh <= 0) return false;
            const ov = Math.min(o.yBottom, c.yBottom) - Math.max(o.yTop, c.yTop);
            return ov >= 0.6 * oh;
        });
        for (let a = 0; a < inside.length; a++) {
            for (let b = a + 1; b < inside.length; b++) {
                const la = inside[a], lb = inside[b];
                const ov = Math.min(la.yBottom, lb.yBottom) - Math.max(la.yTop, lb.yTop);
                const minH = Math.min(la.yBottom - la.yTop, lb.yBottom - lb.yTop);
                if (ov < 0.3 * minH) return true;
            }
        }
        return false;
    };

    // Contains at least one mostly-inside line — a fusion often CONSUMES the
    // second row's only text (78B94F81: weighed line + "Linu sėmenys" fused;
    // the sole survivor inside was the price anchor, so the two-disjoint-rows
    // test alone missed it). One contained line + double height is enough to
    // TRY a strip — acceptance rejects any read that isn't clearly better.
    const containsALine = (c: { yTop: number; yBottom: number }): boolean =>
        lines.some((o) => {
            if (o === c) return false;
            const oh = o.yBottom - o.yTop;
            if (oh <= 0) return false;
            const ov = Math.min(o.yBottom, c.yBottom) - Math.max(o.yTop, c.yTop);
            return ov >= 0.6 * oh;
        });

    const plans: FusedStripPlan[] = [];
    const claimed = new Set<number>();
    for (let i = 0; i < lines.length && plans.length < 4; i++) {
        const l = lines[i];
        const h = l.yBottom - l.yTop;
        if (!isFusedBodyText(l)) continue;
        // 1.6× threshold for the STRIP lane (the parser-side name quarantine
        // keeps its stricter 1.75×): sub-threshold fusions cost products
        // (-13/-2 footprints sat at 1.6-1.75×), and a false strip is cheap —
        // the acceptance gate throws it away.
        if (h < 1.6 * medianH || h > 3.5 * medianH) continue;
        // Qualification tiers: spans two disjoint lines, contains one line, or
        // is TWO FULL ROWS tall — a fusion can consume every other line of
        // both rows (rimi-30-04-2026-2: Cukrus' discount row + Lazdynų's name
        // row became one 2.1× box with nothing else inside). Photo-skew
        // singles measure ~1.8× and stay below the unconditional tier.
        if (!spansTwoRows(l) && !containsALine(l) && h < 2.0 * medianH) continue;
        if (claimed.has(i)) continue;
        const pad = Math.max(6, Math.round(0.12 * h));
        // The fused bbox often STARTS mid-glyph inside its first row (-23:
        // "I'T ALPRO" began below the caps of "ALPRO, 1 l"), and a crop at
        // the bbox top beheads that row — engines then refuse or re-glue it
        // (the clipped-caps lesson the insertion planner already paid for).
        // Extend the crop up to just past the bottom of the nearest line
        // fully above, bounded to ~one row; the edge-sliver filter drops
        // whatever of that neighbour leaks in.
        //
        // "Above" must X-OVERLAP the fused box: a right-column PRICE box
        // legitimately sits on the fusion's own first row (-23: "3,29 А"
        // bottomed at y1042 INSIDE the ALPRO row) — anchoring to it clamped
        // the extension back to the beheading crop. Only the fusion's own
        // column defines its upper wall.
        const xOverlapsFused = (o: typeof l): boolean =>
            o.xLeft == null || o.xRight == null || l.xLeft == null || l.xRight == null
            || Math.min(o.xRight, l.xRight) - Math.max(o.xLeft, l.xLeft) > 0;
        const above = lines
            .filter((o) => o !== l && o.yBottom - o.yTop > 0 && o.yBottom <= l.yTop + 0.3 * medianH
                && xOverlapsFused(o))
            .sort((a, b) => b.yBottom - a.yBottom)[0];
        const extendedTop = above
            ? Math.max(above.yBottom - 0.2 * medianH, l.yTop - 1.2 * medianH)
            : l.yTop - 0.6 * medianH;
        const top = Math.max(0, Math.round(Math.min(l.yTop - pad, extendedTop)));
        const bottom = Math.min(pageHeight, Math.round(l.yBottom + pad));
        if (bottom - top < 20) continue;
        const replacedIdx: number[] = [];
        for (let j = 0; j < lines.length; j++) {
            const c = (lines[j].yTop + lines[j].yBottom) / 2;
            if (c >= top && c <= bottom) {
                replacedIdx.push(j);
                claimed.add(j);
            }
        }
        plans.push({ top, bottom, fusedText: l.text, replacedIdx, medianH });
    }
    return plans;
}

/**
 * DROPPED-ROW strips: Vision sometimes deletes whole left-column rows outright
 * (5EEA946F: "bulguras RIMI, 400 g" and "Bolivinių balandų miš. RIMI" absent
 * from the output while their pixels are crisp). Signal: a PRODUCT ANCHOR
 * (price + VAT letter, right column) with NO left-column text overlapping its
 * row — impossible on a real receipt. The strip spans the whole uncovered gap
 * (from the last left-column line above to the first below), so neighbouring
 * dropped name-only rows heal in the same pass. Exported for tests.
 */
export function planDroppedRowStrips(
    lines: { text: string; yTop: number; yBottom: number; xLeft: number; xRight: number }[],
    pageWidth: number,
    pageHeight: number,
): FusedStripPlan[] {
    const hs = lines
        .filter(isFusedBodyText)
        .map((l) => l.yBottom - l.yTop)
        .filter((h) => h > 0)
        .sort((a, b) => a - b);
    if (hs.length < 8) return [];
    const medianH = hs[Math.floor(hs.length / 2)];
    if (!(medianH > 0)) return [];

    // Latin AND Cyrillic-homoglyph VAT letters — pre-fold OCR output.
    const ANCHOR_RE = /^\d+[.,]\s?\d{2}\s*[ABАВ]\s*$/;
    const leftLines = lines.filter((l) => l.xLeft < pageWidth * 0.45 && l.text.trim().length >= 3);
    const plans: FusedStripPlan[] = [];
    for (const anchor of lines) {
        if (plans.length >= 4) break;
        if (!ANCHOR_RE.test(anchor.text.trim()) || anchor.xLeft < pageWidth * 0.5) continue;
        const aH = anchor.yBottom - anchor.yTop;
        const hasCompanion = leftLines.some((l) => {
            const ov = Math.min(l.yBottom, anchor.yBottom) - Math.max(l.yTop, anchor.yTop);
            return ov >= 0.4 * aH;
        });
        if (hasCompanion) continue;
        // Widen to the full uncovered span so adjacent dropped rows heal too.
        const above = leftLines.filter((l) => l.yBottom <= anchor.yTop + 0.3 * medianH);
        const below = leftLines.filter((l) => l.yTop >= anchor.yBottom - 0.3 * medianH);
        const prevBottom = above.length ? Math.max(...above.map((l) => l.yBottom)) : anchor.yTop - medianH;
        const nextTop = below.length ? Math.min(...below.map((l) => l.yTop)) : anchor.yBottom + medianH;
        let top = Math.max(0, Math.round(prevBottom - 6));
        let bottom = Math.min(pageHeight, Math.round(nextTop + 6));
        if (bottom - top > 4.5 * medianH) {
            // A giant uncovered span is a section boundary, not a dropped row —
            // stay tight around the anchor.
            top = Math.max(0, Math.round(anchor.yTop - 1.2 * medianH));
            bottom = Math.min(pageHeight, Math.round(anchor.yBottom + 1.2 * medianH));
        }
        if (bottom - top < 20) continue;
        const replacedIdx: number[] = [];
        for (let j = 0; j < lines.length; j++) {
            const c = (lines[j].yTop + lines[j].yBottom) / 2;
            if (c >= top && c <= bottom) replacedIdx.push(j);
        }
        plans.push({ top, bottom, fusedText: anchor.text, replacedIdx, medianH });
    }
    return plans;
}

/**
 * MISSING-FIRST-LINE insertion strips: a wrapped product name's FIRST row can
 * be dropped by the engine with no fused box, no lonely anchor and no visible
 * gap — the squeeze signature (rimi-30-04-2026-8: "Varškės sūrelis…" vanished
 * between the previous product's Nuol row and its own "MAGIJA, 20,7 %, 40 g"
 * continuation). Signal: a left-column CONTINUATION-shaped line (BRAND-comma
 * start) sitting tight under a STRUCTURAL row (discount/weight/multi — never
 * a name), with the space between them unoccupied. The strip re-reads that
 * zone in isolation and ADDS whatever non-duplicate row it finds.
 * Exported for tests.
 */
const CONTINUATION_NAME_RE = /^[A-ZĄČĘĖĮŠŲŪŽ0-9]{3,},\s/;
const STRUCTURAL_ROW_RE = /Nuo[l1i]|Galut|kaina|vnt\s*\.?\s*[xX×*]|kg\s+[xX×]|EUR/i;

export function planMissingFirstLineStrips(
    lines: { text: string; yTop: number; yBottom: number; xLeft: number; xRight: number }[],
    pageWidth: number,
    pageHeight: number,
): FusedStripPlan[] {
    const hs = lines
        .filter(isFusedBodyText)
        .map((l) => l.yBottom - l.yTop)
        .filter((h) => h > 0)
        .sort((a, b) => a - b);
    if (hs.length < 8) return [];
    const medianH = hs[Math.floor(hs.length / 2)];
    if (!(medianH > 0)) return [];

    const leftLines = lines.filter((l) => l.xLeft < pageWidth * 0.45 && l.text.trim().length >= 3);
    const plans: FusedStripPlan[] = [];
    for (const l of leftLines) {
        if (plans.length >= 3) break;
        if (!isFusedBodyText(l) || !CONTINUATION_NAME_RE.test(l.text.trim())) continue;
        const above = leftLines.filter((o) => o !== l && o.yBottom <= l.yTop + 0.3 * medianH);
        if (!above.length) continue;
        const prev = above.reduce((a, b) => (a.yBottom > b.yBottom ? a : b));
        const gap = l.yTop - prev.yBottom;
        // Squeezed: the dropped row hides in LESS than a row-pitch of space —
        // a normal gap means the first line was simply read (or is a true
        // one-liner). And the row above must be structural, never name text
        // (a name above means the first line IS present).
        if (gap >= 0.9 * medianH || gap < -0.3 * medianH) continue;
        if (!STRUCTURAL_ROW_RE.test(prev.text)) continue;
        // The strip spans from the TOP of the structural row above THROUGH
        // the continuation row — full rows only. A squeezed dropped row
        // OVERLAPS the previous row's bbox (rimi-30-04-2026-8: row top 1105
        // vs prev bottom 1117), so starting the crop below prev's bottom
        // sliced the target row's caps/diacritics off and both engines
        // refused it. Re-read context rows are discarded by the insertion
        // dup-filter; only the genuinely new row splices in.
        const top = Math.max(0, Math.round(prev.yTop - 0.1 * medianH));
        const bottom = Math.min(pageHeight, Math.round(l.yBottom + 0.2 * medianH));
        if (bottom - top < 0.45 * medianH) continue;
        // Occupied DROPPED-ZONE check (the gap between prev's bottom and the
        // continuation's top only) = nothing was dropped here.
        const gapTop = prev.yBottom + 2;
        const occupied = lines.some((o) => {
            if (o === l) return false;
            const c = (o.yTop + o.yBottom) / 2;
            return c >= gapTop && c <= l.yTop - 2;
        });
        if (occupied) continue;
        plans.push({ top, bottom, fusedText: l.text, replacedIdx: [], medianH, insertion: true });
    }
    return plans;
}

/**
 * GARBLED-ANCHOR strips: a whole product row whose pixels are pristine but
 * that the engine returned as garbage — Norfa-04-23 read "Žemės riešutai
 * GAR2, 500g  2x1,49 2,98 M1" as "CAD" + "2v1 Aa ae M1" (both HALF height).
 * A sporadic engine miss, not fading/skew. The dropped-row planner misses it
 * because the garbled "…M1" box isn't recognised as an anchor at all.
 *
 * Signal: a RIGHT-column box ending in a VAT suffix (M1/M5/A/B) that ISN'T a
 * clean anchor AND carries letter garbage in its value part, with NO clean
 * full-height left-column name on its row (the name misread too). Re-OCR the
 * row (padded to a full median height — the garbled boxes are half-tall).
 * Acceptance (see reocrFusedRows) demands the re-read yield a CLEAN anchor,
 * so a false trigger that can't recover is a safe no-op. Exported for tests.
 */
export function planGarbledAnchorStrips(
    lines: { text: string; yTop: number; yBottom: number; xLeft: number; xRight: number }[],
    pageWidth: number,
    pageHeight: number,
): FusedStripPlan[] {
    const hs = lines
        .filter(isFusedBodyText)
        .map((l) => l.yBottom - l.yTop)
        .filter((h) => h > 0)
        .sort((a, b) => a - b);
    if (hs.length < 8) return [];
    const medianH = hs[Math.floor(hs.length / 2)];
    if (!(medianH > 0)) return [];

    // Full-height left-column names — a row with one of these is a healthy
    // product, not a garbled miss.
    const cleanLeft = lines.filter(
        (l) => l.xLeft < pageWidth * 0.45
            && l.text.trim().length >= 3
            && l.yBottom - l.yTop >= 0.6 * medianH
            && /[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]/.test(l.text),
    );
    const plans: FusedStripPlan[] = [];
    for (const box of lines) {
        if (plans.length >= 4) continue;
        const t = box.text.trim();
        if (box.xLeft < pageWidth * 0.5) continue;              // right column
        if (!ANCHOR_SUFFIX_RE.test(t)) continue;                // ends in a VAT suffix
        if (CLEAN_ANCHOR_RE.test(t)) continue;                  // a clean anchor — not garbled
        // A garbled anchor carries letter noise in the value part (a clean
        // number never does); this is what separates "2v1 Aa ae M1" from a
        // legitimately unusual-but-clean price.
        if (!/[a-zA-Z]/.test(t.replace(ANCHOR_SUFFIX_RE, ''))) continue;
        const aH = box.yBottom - box.yTop;
        const hasCleanName = cleanLeft.some((l) => {
            const ov = Math.min(l.yBottom, box.yBottom) - Math.max(l.yTop, box.yTop);
            return ov >= 0.3 * aH;
        });
        if (hasCleanName) continue;                             // name survived → not this class
        const cy = (box.yTop + box.yBottom) / 2;
        const top = Math.max(0, Math.round(cy - 0.7 * medianH));
        const bottom = Math.min(pageHeight, Math.round(cy + 0.7 * medianH));
        if (bottom - top < 20) continue;
        const replacedIdx: number[] = [];
        for (let j = 0; j < lines.length; j++) {
            const c = (lines[j].yTop + lines[j].yBottom) / 2;
            if (c >= top && c <= bottom) replacedIdx.push(j);
        }
        plans.push({ top, bottom, fusedText: t, replacedIdx, medianH, garbled: true });
    }
    return plans;
}

/** Drop strip lines HALLUCINATED from partial glyphs at the crop edges: the
 *  strip's padding can catch the ascender/descender sliver of a NEIGHBOUR row,
 *  which the engine decodes as garbage ("пTTaтттт" from the FUSILLI row's top
 *  20px on 0AE04F24). Slivers are SHORT (a fraction of a row) and hang off
 *  the boundary; real rows are full-height or overlap replaced content.
 *  Exported for tests. */
export function filterStripEdgeSlivers<T extends { yTop: number; yBottom: number }>(
    stripLines: T[],
    top: number,
    bottom: number,
    replaced: { yTop: number; yBottom: number }[],
    medianH: number,
): T[] {
    const EDGE = 3;
    return stripLines.filter((l) => {
        const touchesEdge = l.yTop <= top + EDGE || l.yBottom >= bottom - EDGE;
        if (!touchesEdge) return true;
        const h = Math.max(1, l.yBottom - l.yTop);
        if (h >= 0.5 * medianH) return true; // full-height rows are real content
        return replaced.some((r) => {
            const ov = Math.min(r.yBottom, l.yBottom) - Math.max(r.yTop, l.yTop);
            return ov >= 0.5 * h;
        });
    });
}

/** Accept a strip read only when it is demonstrably BETTER than what it
 *  replaces: no line still fused-tall, at least two distinct rows, and it
 *  covers the replaced text (≥70% of the character mass, ≥ as many lines).
 *  Exported for tests. */
export function stripReadAcceptable(
    stripLines: { text: string; yTop: number; yBottom: number; xLeft?: number; xRight?: number }[],
    replaced: { text: string; yTop: number; yBottom: number }[],
    medianH: number,
): boolean {
    // ≥2 lines only — NOT ≥ replaced.length: a good heal merges partial-read
    // fragments into whole rows, so fewer-but-better is normal (-23: the
    // count gate rejected the clean mlkit@1x read and the ladder fell
    // through to a re-glued 1.5× read). Text loss is what the ≥70% mass
    // gate below is for.
    if (stripLines.length < 2) return false;
    if (stripLines.some((l) => isFusedBodyText(l) && l.yBottom - l.yTop >= 1.75 * medianH)) return false;
    // HORIZONTAL-GLUE guard: an engine can double-emit a word — once glued
    // into a DIFFERENT row's line, once standalone (-23 mlkit@1.5 read
    // "PLANT Šok. sk. sojos gėr. ALPRO" plus a lone "PLANT" from the row
    // below; the glued line is normal-height, so the fused-tall gate can't
    // see it). Token repeats across rows are legitimate on receipts (brand
    // names), so the tell is X-POSITION: the glued copy and its standalone
    // twin are the same physical word — their x-spans overlap (estimated
    // inside the long line by character proportion). Rejection is
    // fail-safe: the ladder tries the next attempt, and if all fail the
    // fused box stays quarantined exactly as before strips existed.
    const foldText = (s: string): string =>
        s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const tokensIn = (s: string): string[] => foldText(s).match(/[a-z]{3,}/g) ?? [];
    for (const l of stripLines) {
        if (l.xLeft == null || l.xRight == null) continue;
        if (l.text.trim().split(/\s+/).length !== 1) continue;
        const ts = tokensIn(l.text);
        if (ts.length !== 1) continue;
        const lXLeft = l.xLeft, lXRight = l.xRight;
        const reGlued = stripLines.some((o) => {
            if (o === l || o.xLeft == null || o.xRight == null) return false;
            const ov = Math.min(o.yBottom, l.yBottom) - Math.max(o.yTop, l.yTop);
            const minH = Math.min(o.yBottom - o.yTop, l.yBottom - l.yTop);
            if (ov >= 0.5 * minH) return false; // same row — legit fragment split
            const ot = tokensIn(o.text);
            if (ot.length < 2 || !ot.includes(ts[0])) return false;
            const folded = foldText(o.text);
            const idx = folded.indexOf(ts[0]);
            if (idx < 0) return false;
            const w = o.xRight - o.xLeft;
            const tokL = o.xLeft + (idx / folded.length) * w;
            const tokR = o.xLeft + ((idx + ts[0].length) / folded.length) * w;
            return Math.min(tokR, lXRight) - Math.max(tokL, lXLeft) > 0;
        });
        if (reGlued) return false;
    }
    const sorted = [...stripLines].sort((a, b) => a.yTop - b.yTop);
    let rows = 1;
    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1], cur = sorted[i];
        const ov = Math.min(prev.yBottom, cur.yBottom) - Math.max(prev.yTop, cur.yTop);
        if (ov < 0.5 * Math.min(prev.yBottom - prev.yTop, cur.yBottom - cur.yTop)) rows++;
    }
    if (rows < 2) return false;
    // A removed PRICE must survive the splice — losing an anchor destroys the
    // band. Every replaced price-shaped line needs a numeric strip counterpart
    // at (roughly) its row.
    const PRICEISH = /\d+[.,]\s?\d{2}/;
    for (const r of replaced) {
        if (!/^\d+[.,]\s?\d{2}\s*[ABАВ]?\s*$/.test(r.text.trim())) continue;
        const rH = Math.max(1, r.yBottom - r.yTop);
        const kept = stripLines.some((l) => {
            const ov = Math.min(l.yBottom, r.yBottom) - Math.max(l.yTop, r.yTop);
            return ov >= 0.5 * rH && PRICEISH.test(l.text);
        });
        if (!kept) return false;
    }
    const removedLen = replaced.reduce((s, l) => s + l.text.trim().length, 0);
    const gotLen = stripLines.reduce((s, l) => s + l.text.trim().length, 0);
    return gotLen >= 0.7 * removedLen;
}

/**
 * FIXED-POINT healing: strips run in ROUNDS. A healed zone can unlock plans
 * that were invisible or blocked in the previous round — on rimi-30-04-2026-8
 * round 1's fused strip restored the "Nuo1./Galut." rows, and only THEN did
 * the missing-first-line signature above "MAGIJA, …" become valid (its "row
 * above" had been a garbled fused box, and the overlap-dedupe blocked the
 * insertion strip in the same round). Single-pass healing stopped there;
 * iterating re-plans on the healed lines. Bounded to 3 rounds; each round
 * must accept at least one strip to continue.
 */
export async function reocrFusedRows(
    pageUri: string,
    pageWidth: number,
    pageHeight: number,
    initialLines: LineWithFrame[],
    engine: OcrEngine,
): Promise<LineWithFrame[]> {
    let current = initialLines;
    for (let round = 1; round <= 3; round++) {
        const { lines: next, accepted } = await reocrFusedRowsOnce(pageUri, pageWidth, pageHeight, current, engine, round);
        current = next;
        if (!accepted) break;
    }
    return current;
}

async function reocrFusedRowsOnce(
    pageUri: string,
    pageWidth: number,
    pageHeight: number,
    lines: LineWithFrame[],
    engine: OcrEngine,
    round: number,
): Promise<{ lines: LineWithFrame[]; accepted: boolean }> {
    // Fused boxes first, then dropped rows, then missing-first-line
    // insertions — dedupe overlapping strips (different signals can describe
    // the same damage; a blocked plan gets its chance next round if the zone
    // heals).
    const fusedPlans = planFusedStrips(lines, pageHeight);
    const noOverlap = (d: FusedStripPlan, prior: FusedStripPlan[]) =>
        prior.every((f) => Math.min(f.bottom, d.bottom) - Math.max(f.top, d.top) < 0.3 * (d.bottom - d.top));
    const droppedPlans = planDroppedRowStrips(lines, pageWidth, pageHeight).filter((d) => noOverlap(d, fusedPlans));
    const insertionPlans = planMissingFirstLineStrips(lines, pageWidth, pageHeight)
        .filter((d) => noOverlap(d, [...fusedPlans, ...droppedPlans]));
    const garbledPlans = planGarbledAnchorStrips(lines, pageWidth, pageHeight)
        .filter((d) => noOverlap(d, [...fusedPlans, ...droppedPlans, ...insertionPlans]));
    const plans = [...fusedPlans, ...droppedPlans, ...insertionPlans, ...garbledPlans];
    if (plans.length === 0) return { lines, accepted: false };
    const dropIdx = new Set<number>();
    const spliced: LineWithFrame[] = [];
    for (const plan of plans) {
        try {
            const strip = await ImageManipulator.manipulateAsync(
                pageUri,
                [{ crop: { originX: 0, originY: plan.top, width: pageWidth, height: plan.bottom - plan.top } }],
                { compress: 1, format: ImageManipulator.SaveFormat.PNG },
            );
            const replaced = plan.replacedIdx.map((i) => lines[i]);
            // ENGINE×SCALE LADDER: the primary engine can refuse a row at one
            // scale while another engine or scale reads it fine. Try both
            // engines at 1×, then both at 1.5× (some rows unstick only when
            // upscaled). Acceptance gates are identical for every attempt.
            const baseEngines: OcrEngine[] = engine === 'mlkit' ? ['mlkit'] : [engine, 'mlkit'];
            const attempts: { eng: OcrEngine; scale: number }[] = [
                ...baseEngines.map((e) => ({ eng: e, scale: 1 })),
                ...baseEngines.map((e) => ({ eng: e, scale: 1.5 })),
            ];
            const attemptLog: { eng: string; scale: number; lines: string[] }[] = [];
            let done = false;
            for (const { eng, scale } of attempts) {
                let attemptUri = strip.uri;
                let coordScale = 1;
                if (scale !== 1) {
                    const scaled = await ImageManipulator.manipulateAsync(
                        strip.uri,
                        [{ resize: { width: Math.round(pageWidth * scale) } }],
                        { compress: 1, format: ImageManipulator.SaveFormat.PNG },
                    );
                    attemptUri = scaled.uri;
                    coordScale = pageWidth / scaled.width;
                }
                const stripOcrRaw = await ocrImageEnhanced(attemptUri, eng, { document: true });
                const stripOcr = coordScale === 1 ? stripOcrRaw : {
                    ...stripOcrRaw,
                    lines: stripOcrRaw.lines.map((l) => ({
                        ...l,
                        yTop: l.yTop * coordScale, yBottom: l.yBottom * coordScale,
                        xLeft: l.xLeft * coordScale, xRight: l.xRight * coordScale,
                        yLeftTop: l.yLeftTop == null ? undefined : l.yLeftTop * coordScale,
                        yRightTop: l.yRightTop == null ? undefined : l.yRightTop * coordScale,
                        yLeftBottom: l.yLeftBottom == null ? undefined : l.yLeftBottom * coordScale,
                        yRightBottom: l.yRightBottom == null ? undefined : l.yRightBottom * coordScale,
                        words: l.words?.map((w) => ({
                            ...w,
                            xLeft: w.xLeft * coordScale, xRight: w.xRight * coordScale,
                            yTop: w.yTop * coordScale, yBottom: w.yBottom * coordScale,
                            cornerPoints: w.cornerPoints?.map((p) => ({ x: p.x * coordScale, y: p.y * coordScale })),
                        })),
                    })),
                };
                attemptLog.push({ eng: String(eng), scale, lines: stripOcr.lines.map((l) => l.text) });
                const offY = (v: number | undefined) => (v == null ? undefined : v + plan.top);
                const remappedAll: LineWithFrame[] = stripOcr.lines.map((l) => ({
                    text: l.text,
                    yTop: l.yTop + plan.top,
                    yBottom: l.yBottom + plan.top,
                    xLeft: l.xLeft,
                    xRight: l.xRight,
                    yLeftTop: offY(l.yLeftTop),
                    yRightTop: offY(l.yRightTop),
                    yLeftBottom: offY(l.yLeftBottom),
                    yRightBottom: offY(l.yRightBottom),
                    words: l.words?.map((w) => ({
                        ...w, yTop: w.yTop + plan.top, yBottom: w.yBottom + plan.top,
                        cornerPoints: w.cornerPoints?.map((p) => ({ x: p.x, y: p.y + plan.top })),
                    })),
                }));
                const remapped = filterStripEdgeSlivers(remappedAll, plan.top, plan.bottom, replaced, plan.medianH);
                if (plan.insertion) {
                    // INSERTION acceptance: at least one body line that isn't
                    // a duplicate of the surrounding context — nothing is
                    // removed, the healed row is simply added.
                    const tokensOf = (s: string) => new Set(
                        s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((t) => t.length >= 2),
                    );
                    const context = lines.filter((l) => l.yBottom > plan.top - plan.medianH && l.yTop < plan.bottom + plan.medianH);
                    const freshNew = remapped.filter((l) => {
                        if (!isFusedBodyText(l)) return false;
                        const lt = tokensOf(l.text);
                        if (lt.size === 0) return false;
                        return !context.some((c) => {
                            const ct = tokensOf(c.text);
                            let hit = 0;
                            for (const t of lt) if (ct.has(t)) hit++;
                            return hit / Math.min(lt.size, ct.size || 1) >= 0.5;
                        });
                    });
                    if (freshNew.length >= 1) {
                        spliced.push(...freshNew);
                        console.log(
                            `[fusedReocr] INSERT (${eng}) y${plan.top}-${plan.bottom} above "${plan.fusedText.slice(0, 24)}": ` +
                            freshNew.map((l) => `"${l.text.slice(0, 30)}"`).join(' | '),
                        );
                        done = true;
                        break;
                    }
                    continue; // next engine
                }
                if (plan.garbled) {
                    // GARBLED-ANCHOR acceptance: the re-read must produce a
                    // CLEAN anchor (price/weighable + VAT suffix) that the
                    // garbled originals lacked, plus some body text. That is
                    // proof the row was actually recovered; anything less is
                    // rejected, so a mis-fired plan is a safe no-op.
                    const hadClean = replaced.some((l) => CLEAN_ANCHOR_RE.test(l.text.trim()));
                    const nowClean = remapped.some((l) => CLEAN_ANCHOR_RE.test(l.text.trim()));
                    const hasBody = remapped.some((l) => isFusedBodyText(l));
                    if (!hadClean && nowClean && hasBody) {
                        plan.replacedIdx.forEach((i) => dropIdx.add(i));
                        spliced.push(...remapped);
                        console.log(
                            `[fusedReocr] GARBLED (${eng}) y${plan.top}-${plan.bottom}: "${plan.fusedText.slice(0, 24)}" → ` +
                            remapped.map((l) => `"${l.text.slice(0, 28)}"`).join(' | '),
                        );
                        done = true;
                        break;
                    }
                    continue; // next engine
                }
                if (stripReadAcceptable(remapped, replaced, plan.medianH)) {
                    plan.replacedIdx.forEach((i) => dropIdx.add(i));
                    spliced.push(...remapped);
                    console.log(
                        `[fusedReocr] strip (${eng}) y${plan.top}-${plan.bottom}: ${replaced.length}→${remapped.length} lines; ` +
                        `"${plan.fusedText.slice(0, 32)}" → ${remapped.map((l) => `"${l.text.slice(0, 24)}"`).join(' | ')}`,
                    );
                    done = true;
                    break;
                }
            }
            if (!done) {
                console.log(
                    `[fusedReocr] strip y${plan.top}-${plan.bottom} ${plan.insertion ? 'found nothing new' : 'REJECTED'} on all attempts ("${plan.fusedText.slice(0, 32)}")`,
                );
            }
            // DEV OBSERVABILITY: ship the exact strip crop + every attempt's
            // raw engine output to the dev server so failed strips can be
            // diagnosed from evidence instead of guesses. Best-effort.
            if (__DEV__) {
                try {
                    const { readAsStringAsync, EncodingType } = require('expo-file-system/legacy');
                    const { API_BASE_URL } = require('../config/api');
                    const pngBase64 = await readAsStringAsync(strip.uri, { encoding: EncodingType.Base64 });
                    await fetch(`${API_BASE_URL}/receipts-batch-debug`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chain: 'strips',
                            file: `strip-r${round}-y${plan.top}-${plan.bottom}${plan.insertion ? '-insert' : plan.garbled ? '-garbled' : ''}`,
                            page: 1,
                            pngBase64,
                            meta: { plan: { top: plan.top, bottom: plan.bottom, insertion: !!plan.insertion, fusedText: plan.fusedText }, accepted: done, attempts: attemptLog },
                        }),
                    });
                } catch { /* debug only */ }
            }
        } catch (e) {
            console.log('[fusedReocr] strip failed (kept original):', e);
        }
    }
    if (dropIdx.size === 0 && spliced.length === 0) return { lines, accepted: false };
    const out = lines.filter((_, i) => !dropIdx.has(i)).concat(spliced);
    out.sort((a, b) => a.yTop - b.yTop);
    return { lines: out, accepted: true };
}

/**
 * OCR every page (rotating to portrait + auto-tiling tall images via
 * `ocrImageTiled`), concatenate with per-page y-offsets so multi-page e-receipts
 * parse as one document, then run the adjacent-row merge.
 */
export async function ocrReceiptPages(
    imageUris: string[],
    engine: OcrEngine = 'auto',
    opts: {
        document?: boolean;
        /** Fused/dropped-row strip re-OCR (opt-in). Works for PDF pages AND
         *  photos — the early photo damage (duplicated rows) was caused by
         *  engine double-reads and edge slivers that now have their own
         *  guards (cluster dedupe, sliver filter, anchor-must-survive
         *  acceptance); a photo's engine-dropped rows only ever heal through
         *  a strip (ios-55 "MILLER, 250 g"). */
        stripHealing?: boolean;
    } = {},
): Promise<ReceiptOcrResult> {
    const allLines: LineWithFrame[] = [];
    const pageMetas: ReceiptOcrPageMeta[] = [];
    let frameScale = 1;
    let yOffset = 0;
    let firstPageUri = imageUris[0] ?? "";
    let firstPageWidth = 0;
    let firstPageHeight = 0;

    for (let pageIdx = 0; pageIdx < imageUris.length; pageIdx++) {
        const pageUri = await rotatePortrait(imageUris[pageIdx]);
        const ocr = await ocrImageEnhanced(pageUri, engine, opts);
        if (pageIdx === 0) {
            frameScale = ocr.frameScale;
            firstPageUri = pageUri;
            firstPageWidth = ocr.pixelWidth;
            firstPageHeight = ocr.pixelHeight;
        }

        // Heal fused double-height boxes and engine-dropped rows by re-OCRing
        // their strip in isolation. Photos qualify too (the strips themselves
        // always run document-mode): a photo's dropped rows heal the same way
        // — ios-55's "MILLER, 250 g" only ever read via a strip — and the
        // acceptance gates (edge-sliver filter, anchor-must-survive, ≥2 rows,
        // text-mass) are what protect skewed geometry from bad splices.
        const pageLines = opts.stripHealing
            ? await reocrFusedRows(pageUri, ocr.pixelWidth, ocr.pixelHeight, ocr.lines as LineWithFrame[], engine)
            : (ocr.lines as LineWithFrame[]);

        let pageMaxYScaled = 0;
        const off = (v: number | undefined) => (v == null ? undefined : v + yOffset);
        for (const line of pageLines) {
            if (line.yBottom > pageMaxYScaled) pageMaxYScaled = line.yBottom;
            allLines.push({
                text: line.text,
                yTop: line.yTop + yOffset,
                yBottom: line.yBottom + yOffset,
                xLeft: line.xLeft,
                xRight: line.xRight,
                yLeftTop: off(line.yLeftTop),
                yRightTop: off(line.yRightTop),
                yLeftBottom: off(line.yLeftBottom),
                yRightBottom: off(line.yRightBottom),
                words: line.words?.map((w) => ({
                    ...w, yTop: w.yTop + yOffset, yBottom: w.yBottom + yOffset,
                    cornerPoints: w.cornerPoints?.map((p) => ({ x: p.x, y: p.y + yOffset })),
                })),
            });
        }
        const xb = computeReceiptXBoundsForPage(pageLines, ocr.pixelWidth, `PAGE ${pageIdx + 1}`);
        pageMetas.push({
            uri: pageUri,
            pixelWidth: ocr.pixelWidth,
            pixelHeight: ocr.pixelHeight,
            frameScale: ocr.frameScale,
            yOffsetScaled: yOffset,
            pageMaxYScaled,
            receiptXLeftScaled: xb.left,
            receiptXRightScaled: xb.right,
        });
        yOffset += pageMaxYScaled + 50;
    }

    allLines.sort((a, b) => a.yTop - b.yTop);

    const mergedLines: LineWithFrame[] = [];
    const PRICE_RE = /^\d+[.,]\s?\d{2}\s*[AB]\s*$/;
    const ROW_THRESHOLD = 30 * frameScale;

    for (const line of allLines) {
        if (mergedLines.length > 0) {
            const last = mergedLines[mergedLines.length - 1];
            if (Math.abs(line.yTop - last.yTop) < ROW_THRESHOLD) {
                if (PRICE_RE.test(line.text)) {
                    mergedLines.push({ ...line });
                } else if (PRICE_RE.test(last.text)) {
                    mergedLines.splice(mergedLines.length - 1, 0, { ...line });
                } else {
                    last.text = last.text + " " + line.text;
                    last.yTop = Math.min(last.yTop, line.yTop);
                    last.yBottom = Math.max(last.yBottom, line.yBottom);
                    last.xLeft = Math.min(last.xLeft, line.xLeft);
                    last.xRight = Math.max(last.xRight, line.xRight);
                    // Merge the word boxes too (kept x-sorted) so a row split by OCR
                    // into two lines still exposes every word for band anchoring.
                    if (line.words?.length) {
                        last.words = [...(last.words ?? []), ...line.words].sort((a, b) => a.xLeft - b.xLeft);
                    }
                }
                continue;
            }
        }
        mergedLines.push({ ...line });
    }

    return { allLines, mergedLines, frameScale, firstPageUri, firstPageWidth, firstPageHeight, pageMetas };
}
