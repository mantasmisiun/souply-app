import { Platform } from 'react-native';
import {
    parseRimiReceipt,
    isRimiReceipt,
} from '../shared/parsers/rimiParser';
import {
    parseMaximaReceipt,
    isMaximaReceipt,
} from '../shared/parsers/maximaParser';
import {
    parseNorfaReceipt,
    isNorfaReceipt,
} from '../shared/parsers/norfaParser';
import {
    parseLidlReceipt,
    isLidlReceipt,
} from '../shared/parsers/lidlParser';
import {
    parseIkiReceipt,
    isIkiReceipt,
} from '../shared/parsers/ikiParser';
import { detectChainByVatCode } from '../shared/parsers/chainVatFallback';
import { ensembleSecondOpinion } from './parseEnsemble';
import { sectionReocrIfFlagged , graftRicherFields } from './sectionReocr';
import { maybeReocrProducts, maybeReocrFooter, maybeReocrHeader, type ReocrOutcome } from './productReocr';
import { makeProductStripReocr, reportReocrOutcome } from './productReocrDevice';
import { refineFooterBands } from './footerBandRefine';
import { PRODUCT_REOCR_ENABLED } from '../constants/flags';
import { devLog } from './devLog';

/**
 * THE single scan→parse orchestration, shared verbatim by the Analyze screen
 * (app/receipt-process.tsx) and the dev batch harness (app/dev/receipt-batch).
 *
 * The batch test is JUST A DIFFERENT UI over this exact flow — an inspector
 * with dry runs. Nothing here may fork per entry point: parser options, chain
 * detection order, ensemble wiring, the rimi photo section re-OCR gate and
 * the IKI whole-section re-OCR chain all live HERE, once. If you need a step
 * to behave differently in one entry point, that is a bug in the making —
 * push the difference into an explicit option on this module instead.
 *
 * What stays outside (per entry point): UI gates/prompts, uploads, masking,
 * store resolution, snapshots/truth (batch), logging chrome.
 */

/** Fragment merger ALWAYS on: Android's document-mode OCR (tiled + fused)
 *  fragments and double-reads rows exactly like iOS MLKit. Validated per
 *  chain against the Android truth corpora (2026-07-11/12). */
export const SCAN_PARSER_OPTS = { iosOcr: true };
export const SCAN_LIDL_PARSER_OPTS = { iosOcr: true };

export type ScanChain = 'rimi' | 'maxima' | 'norfa' | 'lidl' | 'iki';

const CHAIN_IDS: Record<ScanChain, number> = { maxima: 1, rimi: 2, iki: 3, norfa: 4, lidl: 5 };

/**
 * Canonical chain detection — the LIVE order (rimi → maxima → norfa → lidl →
 * iki) plus the VAT-code fallback. The batch previously used a different
 * order (iki third) and had no VAT fallback; unified here.
 */
export function detectReceiptChain(lineTexts: string[]): { chain: ScanChain | null; chainId: number | null } {
    const chain: ScanChain | null =
        isRimiReceipt(lineTexts) ? 'rimi' :
        isMaximaReceipt(lineTexts) ? 'maxima' :
        isNorfaReceipt(lineTexts) ? 'norfa' :
        isLidlReceipt(lineTexts) ? 'lidl' :
        isIkiReceipt(lineTexts) ? 'iki' :
        null;
    if (chain) return { chain, chainId: CHAIN_IDS[chain] };
    const vat = detectChainByVatCode(lineTexts)?.chainId ?? null;
    const byVat = (Object.entries(CHAIN_IDS) as [ScanChain, number][]).find(([, id]) => id === vat);
    return { chain: byVat?.[0] ?? null, chainId: vat };
}

/** Minimal OCR-result surface the flow needs (matches ReceiptOcrResult). */
export interface ScanOcrInput {
    allLines: any[];
    mergedLines: any[];
    pageMetas: { uri: string; pixelWidth: number; pixelHeight: number }[];
}

export interface ParseChainArgs {
    ocr: ScanOcrInput;
    /** Original page image uris — the ensemble re-reads them. */
    imageUris: string[];
    /** Document mode (PDF pages). Photos = false — MUST match the primary
     *  OCR's flag or the ensemble's second read diverges from it. */
    document: boolean;
    /** Optional gate between the IKI ensemble and its whole-section re-OCR —
     *  the live screen runs its user-facing ensure* checks here. Return false
     *  to stop (the caller owns the abort UX). */
    beforeIkiReocr?: (parsed: any) => Promise<boolean>;
    /** Report accepted/rejected IKI re-OCR passes to the dev telemetry
     *  endpoint (live scans only — batch dry runs stay silent). */
    reportIkiReocr?: boolean;
}

export interface ParseChainResult {
    parsed: any;
    /** Set when the ensemble's second engine won — its OCR result, for the
     *  caller's wordsDump / persisted-lines parity. */
    secondOcr: { allLines: any[]; mergedLines: any[] } | null;
    /** Post-re-OCR IKI lines (merged space) when passes accepted changes. */
    ikiLines: any[] | null;
    /** Rimi section re-OCR's respliced lines when it applied — display-only
     *  (band snapshots); the live screen keeps parsing the original lines. */
    sectionOcrLines: any[] | null;
    /** True when beforeIkiReocr vetoed continuation. */
    ikiGateFailed: boolean;
}

const chainLines = (o: { allLines: any[]; mergedLines: any[] }, chain: ScanChain) =>
    (chain === 'iki' ? o.mergedLines : o.allLines);

export async function parseChainReceipt(chain: ScanChain, args: ParseChainArgs): Promise<ParseChainResult> {
    const { ocr, imageUris, document } = args;
    const linesFor = (o: { allLines: any[]; mergedLines: any[] }) => chainLines(o, chain);
    const parseFor = (lines: any[]): any => {
        switch (chain) {
            case 'rimi': return parseRimiReceipt(lines);
            case 'maxima': return parseMaximaReceipt(lines, SCAN_PARSER_OPTS);
            case 'norfa': return parseNorfaReceipt(lines);
            case 'lidl': return parseLidlReceipt(lines, SCAN_LIDL_PARSER_OPTS);
            case 'iki': return parseIkiReceipt(lines);
        }
    };

    let parsed = parseFor(linesFor(ocr));
    const primaryParsed = parsed;
    let secondOcr: ParseChainResult['secondOcr'] = null;

    // Phase-5 ensemble — flagged primary parse → second engine → the
    // receipt's own arithmetic arbitrates. Identical wiring for every chain.
    {
        const outcome = await ensembleSecondOpinion(
            parsed,
            imageUris,
            (second: any) => parseFor(linesFor(second)),
            { document, stripHealing: true, primaryLines: ocr.allLines },
        );
        if (outcome.engine === 'second' && outcome.secondOcr) {
            parsed = outcome.parsed;
            secondOcr = outcome.secondOcr as ParseChainResult['secondOcr'];
        }
    }

    // RIMI photo section re-OCR — recon failure OR the merger's fused/
    // mixed-read suspects; single-page photos only. (The function's internal
    // gate mirrors this condition.) Always fed the PRIMARY read's lines,
    // even when the ensemble's second engine won the parse.
    let sectionOcrLines: any[] | null = null;
    if (chain === 'rimi' && !document && imageUris.length === 1 && ocr.pageMetas[0]
        && (parsed.footer?.reconciled === false || ((parsed.footer as any)?.ocrSuspects ?? 0) > 0)) {
        const o = await sectionReocrIfFlagged(
            parsed,
            ocr.allLines as any,
            ocr.pageMetas[0].uri,
            ocr.pageMetas[0].pixelWidth,
            ocr.pageMetas[0].pixelHeight,
            'auto',
            (ls: any) => parseRimiReceipt(ls as any),
        );
        if (o.applied) { parsed = o.parsed; sectionOcrLines = o.lines as any[]; }
    }

    // RIMI name graft from the primary read — later lanes may win the
    // arithmetic while dropping a name row. (Live behavior: rimi only.)
    if (chain === 'rimi' && parsed !== primaryParsed) {
        parsed = graftRicherFields(primaryParsed as any, parsed as any);
    }

    let ikiLines: any[] | null = null;
    let ikiGateFailed = false;
    if (chain === 'iki') {
        if (args.beforeIkiReocr && !(await args.beforeIkiReocr(parsed))) {
            return { parsed, secondOcr, ikiLines, sectionOcrLines, ikiGateFailed: true };
        }
        // IKI whole-section product re-OCR — flagged sections re-crop +
        // upscale + re-read; accepted only if strictly better. Android-only,
        // flag-gated. Passes run on the PRIMARY read's merged lines.
        if (PRODUCT_REOCR_ENABLED && Platform.OS === 'android' && ocr.pageMetas[0]) {
            const reOcr = makeProductStripReocr(
                ocr.pageMetas[0].uri,
                ocr.pageMetas[0].pixelWidth,
                ocr.pageMetas[0].pixelHeight,
            );
            let lines = ocr.mergedLines as any[];
            const passes: [string, () => Promise<ReocrOutcome>][] = [
                ['products', () => maybeReocrProducts(parsed as any, lines, reOcr, { reasons: ['no-name', 'no-price', 'amount-in-name', 'collapsed-band', 'garbled-name'] })],
                ['footer', () => maybeReocrFooter(parsed as any, lines, reOcr, { reconcileThreshold: 1.0 })],
                ['header', () => maybeReocrHeader(parsed as any, lines, reOcr)],
                ['products-recon', () => maybeReocrProducts(parsed as any, lines, reOcr, { reconcileThreshold: 1.0 })],
            ];
            for (const [label, run] of passes) {
                try {
                    const o = await run();
                    devLog(`scanFlow.productReocr.${label}`, { accepted: o.accepted, detail: o.detail });
                    if (args.reportIkiReocr) void reportReocrOutcome(parsed.footer?.receiptNo, o.accepted, o.detail);
                    if (o.accepted) { parsed = o.parsed; lines = o.lines as any[]; ikiLines = lines; }
                } catch { /* fail-safe: keep prior parse */ }
            }
        }
        // Footer field bands (date/time/receiptNo/total) — rebuild each from a
        // fresh ISOLATED strip re-OCR; fail-safe (keeps the parser's band when
        // the re-OCR misses). These lineRegions ARE the Mokėti/date/receiptNo
        // overlay bands, so they must be part of the shared flow.
        if (ocr.pageMetas[0]) {
            parsed.footer.lineRegions = await refineFooterBands(
                ocr.pageMetas[0].uri,
                parsed.footer.lineRegions,
                { date: parsed.footer.date, time: parsed.footer.time, receiptNo: parsed.footer.receiptNo, total: parsed.footer.total },
                ocr.pageMetas[0].pixelWidth,
                ocr.pageMetas[0].pixelHeight,
            );
        }
    }

    return { parsed, secondOcr, ikiLines, sectionOcrLines, ikiGateFailed };
}
