import * as FileSystem from 'expo-file-system/legacy';
import { API_BASE_URL } from '../config/api';
import { ocrImageTiled, type OcrLine } from '../utils/mlkitOcr';
import { isRimiReceipt, parseRimiReceipt } from '../shared/parsers/rimiParser';
import { isMaximaReceipt, parseMaximaReceipt } from '../shared/parsers/maximaParser';
import { isIkiReceipt, parseIkiReceipt } from '../shared/parsers/ikiParser';
import { isNorfaReceipt, parseNorfaReceipt } from '../shared/parsers/norfaParser';
import { isLidlReceipt, parseLidlReceipt } from '../shared/parsers/lidlParser';

/**
 * Light-weight OCR + parser dispatch for the account-recovery flow.
 *
 * Unlike the full receipt-process pipeline (which also matches every
 * product, computes price comparisons, and persists everything), this
 * extractor only needs the three fields that form the recovery match
 * key: receiptNo, date, total. We feed those to POST /api/users/recover
 * and the server does the rest.
 *
 * Inputs: a local file URI (`file://…`) pointing at either an image
 * (JPG/PNG) or a PDF. PDFs are flattened to PNG pages via the existing
 * `/api/receipts/pdf-to-image` endpoint (same path the share-intent
 * flow in _layout.tsx uses).
 *
 * Output: `RecoveryReceiptExtract` on success, `null` when OCR can't
 * land a chain or the parser can't find all three fields. The slot UI
 * surfaces a re-upload prompt in the null case.
 */

export interface RecoveryReceiptExtract {
    receiptNo: string;
    date: string;   // YYYY-MM-DD
    total: number;
    /** Resolved chain id (1=Maxima, 2=Rimi, 3=Iki, 4=Norfa, 5=Lidl).
     *  Server doesn't need it — the 2-chain rule operates on what the
     *  *stored* receipts say — but the recover screen uses it to display
     *  the chain logo on the slot card and to enforce client-side that
     *  the user hasn't picked 3 obviously-same-chain receipts. */
    chainHint: 1 | 2 | 3 | 4 | 5;
    chainName: 'Maxima' | 'Rimi' | 'Iki' | 'Norfa' | 'Lidl';
}

/**
 * Convert a PDF file:// URI to an array of PNG file:// URIs by sending
 * its base64 contents to the server's pdf-to-image endpoint. Mirrors
 * the share-intent flow in _layout.tsx so the same conversion code
 * path handles both surfaces.
 */
async function pdfToImageUris(pdfUri: string): Promise<string[]> {
    const base64 = await FileSystem.readAsStringAsync(pdfUri, {
        encoding: FileSystem.EncodingType.Base64,
    });
    const res = await fetch(`${API_BASE_URL}/api/receipts/pdf-to-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfBase64: base64 }),
    });
    if (!res.ok) throw new Error(`pdf-to-image ${res.status}`);
    const { images } = await res.json() as { images: string[] };
    const uris: string[] = [];
    for (let i = 0; i < images.length; i++) {
        const dest = `${FileSystem.cacheDirectory}recover_pdf_page_${Date.now()}_${i}.png`;
        await FileSystem.writeAsStringAsync(dest, images[i], {
            encoding: FileSystem.EncodingType.Base64,
        });
        uris.push(dest);
    }
    return uris;
}

interface LineWithFrame extends OcrLine {}

/**
 * OCR every page, concatenate lines with y-offsets so multi-page
 * receipts (e-receipt PDFs spanning ≥2 pages) parse as one logical
 * document. Same shape as the receipt-process pipeline so the parsers
 * see input identical to the upload flow.
 */
async function ocrAllPages(pageUris: string[]): Promise<LineWithFrame[]> {
    const allLines: LineWithFrame[] = [];
    let yOffset = 0;
    for (const uri of pageUris) {
        const page = await ocrImageTiled(uri);
        let pageMaxY = 0;
        for (const line of page.lines) {
            allLines.push({
                text: line.text,
                yTop: line.yTop + yOffset,
                yBottom: line.yBottom + yOffset,
                xLeft: line.xLeft,
                xRight: line.xRight,
            });
            pageMaxY = Math.max(pageMaxY, line.yBottom + yOffset);
        }
        // +50 px buffer keeps the last line of page N safely separated
        // from the first line of page N+1 during downstream merging.
        yOffset = pageMaxY + 50;
    }
    allLines.sort((a, b) => a.yTop - b.yTop);
    return allLines;
}

/**
 * Run chain detection on the merged line texts and dispatch to the
 * matching parser. Returns the three recovery fields when extraction
 * is clean; null when any field is missing.
 */
function detectAndParse(allLines: LineWithFrame[]): RecoveryReceiptExtract | null {
    // Iki's parser internally re-merges lines by y; the other four
    // expect raw lines. The receipt-process pipeline maintains a
    // separately-merged `mergedLines` for Iki — for recovery we feed
    // both shapes when needed and rely on chain detection to pick the
    // right path.
    const merged = mergeAdjacentLines(allLines);
    const lineTexts = merged.map(l => l.text);

    if (isRimiReceipt(lineTexts)) {
        const f = parseRimiReceipt(allLines).footer;
        return packFields(f, 2, 'Rimi');
    }
    if (isMaximaReceipt(lineTexts)) {
        const f = parseMaximaReceipt(allLines).footer;
        return packFields(f, 1, 'Maxima');
    }
    if (isNorfaReceipt(lineTexts)) {
        const f = parseNorfaReceipt(allLines).footer;
        return packFields(f, 4, 'Norfa');
    }
    if (isLidlReceipt(lineTexts)) {
        const f = parseLidlReceipt(allLines).footer;
        return packFields(f, 5, 'Lidl');
    }
    if (isIkiReceipt(lineTexts)) {
        const f = parseIkiReceipt(merged).footer;
        return packFields(f, 3, 'Iki');
    }
    return null;
}

/**
 * Same "merge adjacent y-equal lines" pass receipt-process.tsx runs
 * inline. Kept here so the recovery flow doesn't depend on that file.
 */
function mergeAdjacentLines(allLines: LineWithFrame[]): LineWithFrame[] {
    const merged: LineWithFrame[] = [];
    const PRICE_RE = /^\d+[.,]\s?\d{2}\s*[AB]\s*$/;
    const ROW_THRESHOLD = 30;
    for (const line of allLines) {
        if (merged.length > 0) {
            const last = merged[merged.length - 1];
            if (Math.abs(line.yTop - last.yTop) < ROW_THRESHOLD) {
                if (PRICE_RE.test(line.text)) {
                    merged.push({ ...line });
                } else if (PRICE_RE.test(last.text)) {
                    merged.splice(merged.length - 1, 0, { ...line });
                } else {
                    last.text = last.text + ' ' + line.text;
                    last.yTop = Math.min(last.yTop, line.yTop);
                    last.yBottom = Math.max(last.yBottom, line.yBottom);
                    last.xLeft = Math.min(last.xLeft, line.xLeft);
                    last.xRight = Math.max(last.xRight, line.xRight);
                }
                continue;
            }
        }
        merged.push({ ...line });
    }
    return merged;
}

/**
 * Normalise per-chain footer shapes into the wire-format the server
 * expects. Returns null when any required field is missing — the slot
 * UI shows a "couldn't read receipt" state and asks the user to pick
 * another file.
 */
function packFields(
    footer: { total: number | null; date: string; receiptNo: string },
    chainId: 1 | 2 | 3 | 4 | 5,
    chainName: RecoveryReceiptExtract['chainName'],
): RecoveryReceiptExtract | null {
    const receiptNo = (footer.receiptNo ?? '').trim();
    if (!receiptNo) return null;

    // Parsers emit date as YYYY-MM-DD on success, '' on failure.
    const date = (footer.date ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

    const total = footer.total;
    if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null;

    return { receiptNo, date, total, chainHint: chainId, chainName };
}

/**
 * Public entry point. Accepts an image or PDF file URI, returns the
 * extraction or null. Errors during OCR / PDF expansion / parser
 * dispatch are caught and surfaced as null — the recover screen
 * doesn't care *why* extraction failed; it only renders an empty slot.
 */
export async function extractRecoveryFieldsFromFile(
    fileUri: string,
): Promise<RecoveryReceiptExtract | null> {
    try {
        const isPdf = fileUri.toLowerCase().endsWith('.pdf');
        const pageUris = isPdf ? await pdfToImageUris(fileUri) : [fileUri];
        if (pageUris.length === 0) return null;

        const allLines = await ocrAllPages(pageUris);
        if (allLines.filter(l => l.text.trim().length > 0).length < 3) {
            return null;
        }

        return detectAndParse(allLines);
    } catch (e) {
        console.warn('[recoveryOcr] extraction failed:', (e as Error)?.message);
        return null;
    }
}
