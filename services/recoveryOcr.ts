import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { API_BASE_URL } from '../config/api';
import { ocrReceiptPages, type LineWithFrame } from '../utils/receiptOcrPipeline';
import { isRimiReceipt, parseRimiReceipt } from '../shared/parsers/rimiParser';
import { isMaximaReceipt, parseMaximaReceipt } from '../shared/parsers/maximaParser';
import { isIkiReceipt, parseIkiReceipt } from '../shared/parsers/ikiParser';
import { isNorfaReceipt, parseNorfaReceipt } from '../shared/parsers/norfaParser';
import { isLidlReceipt, parseLidlReceipt } from '../shared/parsers/lidlParser';
import { detectChainByVatCode } from '../shared/parsers/chainVatFallback';

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
    receiptNo: string;          // canonical id (= receiptNos[0]); shown on the slot card
    receiptNos?: string[];      // every identifier the receipt printed (sent for the server tiebreaker)
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

/**
 * Run chain detection on the merged line texts and dispatch to the matching
 * parser. This MIRRORS the Analyze-queue dispatch in
 * `receiptProcessingService.processOneReceipt` EXACTLY — same detection order,
 * the same VAT-code fallback, and the same allLines-vs-mergedLines split per
 * chain — so the recovery total can't drift from the stored upload total.
 * Returns the three recovery fields when extraction is clean; null otherwise.
 */
function detectAndParse(
    allLines: LineWithFrame[],
    mergedLines: LineWithFrame[],
): RecoveryReceiptExtract | null {
    const lineTexts = mergedLines.map(l => l.text);

    const chainId =
        isRimiReceipt(lineTexts) ? 2 :
        isMaximaReceipt(lineTexts) ? 1 :
        isNorfaReceipt(lineTexts) ? 4 :
        isLidlReceipt(lineTexts) ? 5 :
        isIkiReceipt(lineTexts) ? 3 :
        (detectChainByVatCode(lineTexts)?.chainId ?? null);

    // iOS MLKit splits rows into near-same-y fragments; the Maxima+Lidl parsers carry
    // the merger behind this flag — the SAME flag every interactive parse site passes.
    // Without it an iOS recovery re-parse produces a different total/receiptNo than the
    // stored upload and the recovery match key silently misses.
    const PARSER_OPTS = { iosOcr: Platform.OS === 'ios' };
    if (chainId === 2) return packFields(parseRimiReceipt(allLines).footer, 2, 'Rimi');
    if (chainId === 1) return packFields(parseMaximaReceipt(allLines, PARSER_OPTS).footer, 1, 'Maxima');
    if (chainId === 4) return packFields(parseNorfaReceipt(allLines).footer, 4, 'Norfa');
    if (chainId === 5) return packFields(parseLidlReceipt(allLines, PARSER_OPTS).footer, 5, 'Lidl');
    if (chainId === 3) return packFields(parseIkiReceipt(mergedLines).footer, 3, 'Iki');
    return null;
}

/**
 * Normalise per-chain footer shapes into the wire-format the server
 * expects. Returns null when any required field is missing — the slot
 * UI shows a "couldn't read receipt" state and asks the user to pick
 * another file.
 */
function packFields(
    footer: { total: number | null; date: string; receiptNo: string; receiptNos?: string[] },
    chainId: 1 | 2 | 3 | 4 | 5,
    chainName: RecoveryReceiptExtract['chainName'],
): RecoveryReceiptExtract | null {
    // The "needs a receipt number" requirement is satisfied by ANY identifier — a receipt that
    // printed only a "Kvitas" (Kvito Nr. OCR-dropped) is still usable for recovery.
    const receiptNos = (Array.isArray(footer.receiptNos) ? footer.receiptNos : [])
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .map((v) => v.trim());
    const receiptNo = (footer.receiptNo ?? '').trim() || receiptNos[0] || '';
    if (!receiptNo) return null;

    // Parsers emit date as YYYY-MM-DD on success, '' on failure.
    const date = (footer.date ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

    const total = footer.total;
    if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null;

    return { receiptNo, receiptNos: receiptNos.length ? receiptNos : undefined, date, total, chainHint: chainId, chainName };
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

        const { allLines, mergedLines } = await ocrReceiptPages(pageUris);
        if (mergedLines.filter(l => l.text.trim().length > 0).length < 3) {
            return null;
        }

        return detectAndParse(allLines, mergedLines);
    } catch (e) {
        console.warn('[recoveryOcr] extraction failed:', (e as Error)?.message);
        return null;
    }
}
