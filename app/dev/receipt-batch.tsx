/**
 * Dev-only: batch-run receipt PNGs through the real MLKit OCR pipeline,
 * parse with the chain parser, match candidates via the backend, and
 * POST each result to /api/receipts/batch-log for disk-side logging.
 * Never interactive — purpose is to surface parser/resolver bugs
 * against a known PDF corpus without tedious one-by-one phone taps.
 *
 * Storage layout (pushed by `npm run receipts:stage`):
 *   /sdcard/Download/receipts_batch/
 *     maxima/
 *       manifest.json  ← [{sourcePdf, pages:["<name>.png",...]}]
 *       <name>.png
 *     rimi/
 *       manifest.json
 *       <name>.png
 *
 * We re-implement the minimum OCR→lines→parse→match path here rather
 * than refactor receipt-process.tsx (1200+ lines of UI-coupled logic).
 * This covers parser/resolver debugging; the column/region/histogram
 * heuristics in receipt-process.tsx stay untested by this harness, but
 * none of those affect which `MaximaProduct[]` the parser emits.
 */

import {
    Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import { activateKeepAwakeAsync,
    deactivateKeepAwake } from 'expo-keep-awake';
import { Stack,
    useRouter } from 'expo-router';
import { useCallback,
    useMemo,
    useRef,
    useState } from 'react';
import {
    Alert,
    Platform,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { API_BASE_URL } from '../../config/api';
import { ocrReceiptPages } from '../../utils/receiptOcrPipeline';
import { devicePdfAvailable, convertPdfOnDevice } from '../../utils/receiptPdf';
import {
    detectReceiptChain,
    parseChainReceipt,
    SCAN_PARSER_OPTS,
    SCAN_LIDL_PARSER_OPTS,
} from '../../utils/receiptScanFlow';
import { compareItemTruth, isItemTruthFile } from '../../utils/itemTruth';
import { getUserId } from '../../config/user';
import {
    findProductBands,
    traceProductBands,
    traceMaximaExtract,
    extractMaximaProduct,
} from '@shared/parsers/maximaParser';
import {
    setReceiptSnapshot,
    getReceiptSnapshot,
    makeSnapshotKey,
    type PageMeta,
    type BandResult,
} from '../../utils/parserTestSnapshot';
import {
    detectCardMaskBands,
    traceCardMaskBands,
} from '@shared/parsers/cardMaskDetection';
import {
    findReceiptBandsRimi,
    traceReceiptBandsRimi,
    extractRimiProduct,
    traceRimiExtract,
} from '@shared/parsers/rimiParser';
import {
    findReceiptBandsNorfa,
    traceReceiptBandsNorfa,
    extractNorfaProduct,
    traceNorfaExtract,
} from '@shared/parsers/norfaParser';
import {
    findReceiptBandsLidl,
    traceReceiptBandsLidl,
    extractLidlProduct,
    traceLidlExtract,
} from '@shared/parsers/lidlParser';
import { useTheme, type AppTheme } from '../../constants/theme';
import {
    compareToTruth,
    type TruthFile,
    type ParserComparison,
} from '../../utils/compareToTruth';

// Parser options come from the SHARED scan flow (utils/receiptScanFlow) —
// the batch's band planners/tracers below must run the exact opts the
// real parse ran, so there is a single source of truth.
const PARSER_OPTS = SCAN_PARSER_OPTS;
const LIDL_PARSER_OPTS = SCAN_LIDL_PARSER_OPTS;

// Why HTTP instead of reading staged files locally: every local-read
// path (file:// URIs through expo-file-system, fetch(), MLKit) runs
// into scoped-storage or FUSE restrictions on Samsung/OneUI and
// Android 13+. Serving the staged PNGs over the dev API's new
// /receipts-batch static route sidesteps all of it — the phone just
// fetches manifest.json and downloads each page into its own cache
// before OCR, same trust boundary as the existing API calls.
const HTTP_BATCH_ROOT = `${API_BASE_URL}/receipts-batch`;
const HTTP_TRUTH_ROOT = `${API_BASE_URL}/receipts-truth`;
// Ship device-converted pages to the dev machine's debug drop-box
// (receipts/_logs/<chain>/<file>/device-converted-pN.png). Costs seconds per
// page (base64 + LAN POST) — enable only when inspecting conversion output.
const SHIP_CONVERTED_PAGES_DEBUG = false;

const CHAINS = ['maxima', 'rimi', 'iki', 'norfa', 'lidl'] as const;
type ChainName = (typeof CHAINS)[number];

// Chain ids mirror the StoreChain table. Maxima=1, Rimi=2, IKI=3,
// Norfa=4. Lidl set to 5 — confirm with
// `SELECT id FROM StoreChain WHERE name LIKE '%Lidl%'` and update if
// different.
const CHAIN_ID: Record<ChainName, number> = { maxima: 1, rimi: 2, iki: 3, norfa: 4, lidl: 5 };

// Map Maxima's LabeledRegion kinds → the detail overlay's colour kinds
// (store-name/store-address/datetime/receipt-no/total), so its header +
// footer fields render the same way Rimi/Norfa/Lidl typed bands do.
const MAXIMA_FIELD_KIND: Record<string, string> = {
    storeName: 'store-name',
    storeAddress: 'store-address',
    storeCode: 'store-name',
    total: 'total',
    date: 'datetime',
    time: 'datetime',
    dateTime: 'datetime',
    receiptNo: 'receipt-no',
};

interface ManifestEntry {
    sourcePdf: string;
    pages: string[];
    /** Raw staged PDF (when the source was a PDF) — lets a device with the
     *  souply-receipt-pdf module convert ON-DEVICE, the production share path. */
    pdf?: string;
}

interface PageLine {
    text: string;
    yTop: number;
    yBottom: number;
    xLeft: number;
    xRight: number;
    yLeftTop?: number;
    yRightTop?: number;
    yLeftBottom?: number;
    yRightBottom?: number;
    words?: { text: string; xLeft: number; xRight: number; yTop: number; yBottom: number }[];
}

interface ParsedProductSnapshot {
    name: string;
    price: number;
    promoPrice: number | null;
    quantity: number;
    unit: string;
    pricePerUnit: number | null;
    /** Parser-extracted pack size from the name (e.g. 32/rit for ZEWA,
     *  990/ml for SOMAT). Surfaced in the results JSON so a reader can
     *  see at a glance whether `extractPackSize` caught the token. */
    parsedAmount?: number | null;
    parsedUnit?: string | null;
}

interface RowStatus {
    sourcePdf: string;
    chain: ChainName;
    state: 'pending' | 'running' | 'done' | 'error' | 'no-chain';
    message?: string;
    /** V2 step 1 output: number of product bands detected. Tap a row
     *  to inspect the bands visually on the receipt-detail screen. */
    bandsV2Count?: number;
    /** Number of bank/loyalty-card redaction bands detected. Tap a row
     *  to see them drawn over the receipt on the detail screen. */
    maskBandCount?: number;
    /** Comparison vs hand-annotated truth file (if present alongside
     *  the PDF/PNG). null if no truth file or comparison failed. */
    comparison?: ParserComparison | null;
    /** `true` when the matched truth file was auto-bootstrapped by
     *  the dev script (not hand-curated). Carried into the per-receipt
     *  entry of the results JSON so a reader can tell which scores
     *  reflect parser-vs-reality and which are parser-vs-parser's
     *  prior self. */
    truthProvisional?: boolean;
    /** Snapshot of parser-emitted products (lean fields used by the
     *  truth comparison). Persisted into the _results JSON so the
     *  truth files can be reconstructed when the parser is treated
     *  as authoritative. */
    parsedProducts?: ParsedProductSnapshot[];
    /** v2 item-truth roll-up (drives the ✓/⚠/○ list icon). */
    truthSummary?: 'ok' | 'attention' | 'partial' | 'none';
    truthDiffer?: number;
    truthMissing?: number;
}

const loadTruth = async (
    chain: ChainName,
    sourcePdf: string,
): Promise<TruthFile | null> => {
    // Strip extension; truth file is `<basename>.truth.json` next to
    // the PDF/PNG in shared/receipts/<chain>/. Android prefers its own
    // .truth.android.json flavor copy (see receipt-detail's fetch note).
    const base = sourcePdf.replace(/\.(pdf|png|jpg|jpeg)$/i, '');
    const names = Platform.OS === 'android'
        ? [`${base}.truth.android.json`, `${base}.truth.json`]
        : [`${base}.truth.json`];
    for (const n of names) {
        try {
            const res = await fetch(`${HTTP_TRUTH_ROOT}/${chain}/${n}`);
            if (!res.ok) continue;
            return (await res.json()) as TruthFile;
        } catch { /* try next */ }
    }
    return null;
};

const readManifest = async (chain: ChainName): Promise<ManifestEntry[]> => {
    if (!__DEV__) return []; // local dev HTTP server not available in production/OTA builds
    const url = `${HTTP_BATCH_ROOT}/${chain}/manifest.json`;
    try {
        const res = await fetch(url);
        if (!res.ok) {
            console.warn(`[batch] manifest fetch ${res.status} for ${chain}`);
            return [];
        }
        const parsed = await res.json();
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.warn(`[batch] manifest read failed for ${chain}:`, e);
        return [];
    }
};

/**
 * Download one staged PNG from the dev API into app cache. Returns a
 * file:// URI the OCR call can read directly (MLKit needs a local
 * path, it won't fetch https:// itself). Caller is responsible for
 * cleanup after OCR completes.
 */
const downloadPageToCache = async (chain: ChainName, pageName: string): Promise<string> => {
    const url = `${HTTP_BATCH_ROOT}/${chain}/${encodeURIComponent(pageName)}`;
    const safe = pageName.replace(/[^A-Za-z0-9._-]/g, '_');
    const dest = `${FileSystem.cacheDirectory}batch_${Date.now()}_${safe}`;
    const { uri } = await FileSystem.downloadAsync(url, dest);
    return uri;
};

/**
 * (Per-page OCR goes through the SHARED ocrReceiptPages pipeline, and chain
 * detection + parse/ensemble/re-OCR through the SHARED receiptScanFlow —
 * the batch runs exactly what the Analyze scan runs, it only renders and
 * scores the result differently.)
 */

/**
 * Per-product candidate match via the backend's /match endpoint (same
 * one the normal receipt-process flow uses). Runs sequentially to avoid
 * a thundering-herd against the dev API.
 */
const fetchAltMatches = async (
    chainId: number,
    products: any[]
): Promise<any[]> => {
    const enriched: any[] = [];
    for (const p of products) {
        try {
            // Prefer the parser-extracted pack size (parsedAmount /
            // parsedUnit — e.g. 32 / rit for ZEWA, 990 / ml for SOMAT)
            // over the receipt-line quantity. Pack size is the right
            // signal for SP variant discrimination; receipt-line
            // quantity is how much the user bought (often 1 vnt or a
            // weighed fraction) and produces misleading matcher
            // penalties when fed in.
            const matchAmount = p.parsedAmount ?? null;
            const matchUnit = p.parsedUnit ?? null;
            // by-WEIGHT line (sold per kg) → matcher skips packaged SPs — the
            // SAME weighable gate the Analyze scan sends (parity requirement).
            const wParam = p.unit === 'kg' ? '&weighable=1' : '';
            const url = `${API_BASE_URL}/api/store-products/match?chainId=${chainId}&name=${encodeURIComponent(p.name ?? '')}${matchAmount !== null && matchUnit ? `&amount=${matchAmount}&unit=${encodeURIComponent(matchUnit)}` : ''}${wParam}`;
            const res = await fetch(url);
            const body = await res.json().catch(() => ({}));
            const matches = Array.isArray(body?.matches) ? body.matches : [];
            enriched.push({
                ...p,
                storeProductId: null,
                matchConfirmed: false,
                priceVerified: false,
                altMatches: matches.map((m: any) => ({
                    storeProductId: m.storeProductId,
                    productId: m.productId ?? null,
                    storeProductName: m.storeProductName ?? null,
                    confidence: m.confidence,
                })),
            });
        } catch {
            enriched.push({ ...p, altMatches: [] });
        }
    }
    return enriched;
};

/**
 * Resolve header.storeAddress to a Store id via the existing /match
 * endpoint. Same code path production uses.
 */
const matchStoreId = async (chainId: number, address: string | null): Promise<number | null> => {
    if (!address) return null;
    try {
        const url = `${API_BASE_URL}/api/stores/match?chainId=${chainId}&address=${encodeURIComponent(address)}`;
        const res = await fetch(url);
        const body = await res.json();
        return body?.match?.storeId ?? null;
    } catch {
        return null;
    }
};

export default function ReceiptBatchScreen() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    const [statuses, setStatuses] = useState<RowStatus[]>([]);
    const [loading, setLoading] = useState(true);
    const [running, setRunning] = useState(false);
    const [persist, setPersist] = useState(false);
    // A/B lever: ON = convert staged raw PDFs on-device (the production share
    // path: lossless wrapper extraction + CI enhancement / PDFKit render);
    // OFF = use the server-converted staged PNGs. Only shown when the native
    // module is in this build.
    const [devicePdf, setDevicePdf] = useState(true);
    const abortRef = useRef(false);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            // Manifest comes over HTTP from the dev API's /receipts-batch
            // static route. No storage permission or ADB push needed.
            const all: RowStatus[] = [];
            for (const chain of CHAINS) {
                const manifest = await readManifest(chain);
                for (const entry of manifest) {
                    all.push({
                        sourcePdf: entry.sourcePdf,
                        chain,
                        state: 'pending',
                    });
                }
            }
            setStatuses(all);
        } finally {
            setLoading(false);
        }
    }, []);

    // Load manifests on mount.
    useMemo(() => { refresh(); }, [refresh]);

    const processOne = async (idx: number): Promise<RowStatus> => {
        const row = statuses[idx];
        const manifest = await readManifest(row.chain);
        const entry = manifest.find((m) => m.sourcePdf === row.sourcePdf);
        if (!entry) {
            return { ...row, state: 'error', message: 'missing from manifest' };
        }

        // Download each page into the app's cache, then run the SAME shared
        // pipeline the Analyze scan uses (ocrReceiptPages: rotate → enhanced
        // OCR → y-offset concat → row merge → per-page x-bounds) — the batch
        // must never branch off the real scan, or its results stop predicting
        // what a user sees in Analyze. Cache files stay alive until after the
        // ensemble (it re-reads them with the second engine).
        const cachedUris: string[] = [];
        let allLines: PageLine[] = [];
        let pageMetas: PageMeta[] = []; // for snapshot → detail screen
        let detected: ChainName | 'iki' | null = null;
        let parsed: any = null;
        try {
            if (devicePdf && devicePdfAvailable() && entry.pdf) {
                // Production share-flow parity: pull the RAW pdf and convert
                // on-device (wrapper extraction + enhancement, or PDFKit
                // render). Falls back to the staged PNGs on any failure.
                try {
                    const pdfUri = await downloadPageToCache(row.chain, entry.pdf);
                    const { pages, method } = await convertPdfOnDevice(pdfUri);
                    console.log(`[batch] ${row.sourcePdf}: on-device pdf convert (${method}, ${pages.length} p)`);
                    cachedUris.push(...pages);
                    FileSystem.deleteAsync(pdfUri, { idempotent: true }).catch(() => {});
                    // DEBUG drop-box: ship the converted pixels back to the dev
                    // machine so the native conversion chain output can be
                    // inspected there (receipts/_logs/<chain>/<file>/…png).
                    // OFF by default: base64ing a multi-MB page and POSTing it
                    // added seconds PER PAGE to every batch run — flip the
                    // const only when actively inspecting the native output.
                    for (let p = 0; SHIP_CONVERTED_PAGES_DEBUG && p < pages.length; p++) {
                        try {
                            const pngBase64 = await FileSystem.readAsStringAsync(pages[p], {
                                encoding: FileSystem.EncodingType.Base64,
                            });
                            await fetch(`${API_BASE_URL}/receipts-batch-debug`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ chain: row.chain, file: row.sourcePdf, page: p + 1, pngBase64 }),
                            });
                        } catch { /* debug-only, best effort */ }
                    }
                } catch (e) {
                    console.warn(`[batch] ${row.sourcePdf}: device convert failed → staged PNGs`, e);
                }
            }
            if (cachedUris.length === 0) {
                for (const pageName of entry.pages) {
                    cachedUris.push(await downloadPageToCache(row.chain, pageName));
                }
            }
            // stripHealing for ALL sources — photos included: their engine-
            // dropped rows only heal through strips, and the splice guards
            // (dedupe, sliver filter, anchor preservation) carry the risk.
            // document mode PER SOURCE (live parity): a live Analyze PHOTO runs
            // ocrImageEnhanced with document:false (fromPdfParam !== '1');
            // only PDF pages run document mode. The batch used to force
            // document:true for photos too — different OCR sizing than live.
            const isPdfSource = !!entry.pdf;
            const ocr = await ocrReceiptPages(cachedUris, 'auto', { document: isPdfSource, stripHealing: true });
            allLines = ocr.allLines as PageLine[];
            pageMetas = ocr.pageMetas.map((m, i) => ({
                name: entry.pages[i],
                pixelWidth: m.pixelWidth,
                pixelHeight: m.pixelHeight,
                yOffsetInParserSpace: m.yOffsetScaled,
                receiptXLeft: m.receiptXLeftScaled,
                receiptXRight: m.receiptXRightScaled,
                frameScale: m.frameScale,
                pageMaxY: m.pageMaxYScaled,
            }));

            // Chain detection reads the MERGED line texts — same input as the
            // live scan (its lineTexts come from ocrResult.mergedLines).
            detected = detectReceiptChain(ocr.mergedLines.map((l) => l.text)).chain;
            if (!detected) {
                return { ...row, state: 'no-chain', message: 'chain detectors (incl. VAT fallback) all missed' };
            }

            // THE shared scan flow — the exact chain-specific parse → ensemble
            // → section/whole-section re-OCR → graft chain the Analyze screen
            // runs (utils/receiptScanFlow). The batch adds no orchestration of
            // its own; it only renders and scores the result.
            const flow = await parseChainReceipt(detected, {
                ocr: { allLines: ocr.allLines, mergedLines: ocr.mergedLines, pageMetas: ocr.pageMetas },
                imageUris: cachedUris,
                document: isPdfSource,
            });
            parsed = flow.parsed;
            if (!parsed) {
                return { ...row, state: 'error', message: 'parser returned null' };
            }
            // Snapshot/band lines follow the winning read: second-engine OCR
            // when the ensemble flipped, then the rimi section re-OCR's
            // respliced lines when that applied.
            if (flow.secondOcr) allLines = flow.secondOcr.allLines as PageLine[];
            if (flow.sectionOcrLines) allLines = flow.sectionOcrLines as PageLine[];
        } finally {
            for (const u of cachedUris) {
                FileSystem.deleteAsync(u, { idempotent: true }).catch(() => {});
            }
        }
        if (!detected || !parsed) return { ...row, state: 'error', message: 'unreachable' };

        const chainId = CHAIN_ID[detected as ChainName] ?? 3;
        const storeId = await matchStoreId(chainId, parsed.header?.storeAddress ?? null);
        const productsWithMatches = await fetchAltMatches(chainId, parsed.products);

        const parsedData = {
            header: {
                chainId,
                chainName: detected.toUpperCase(),
                storeId,
                storeCode: parsed.header?.storeCode ?? null,
                storeAddress: parsed.header?.storeAddress ?? null,
                rawText: parsed.header?.rawText ?? null,
            },
            products: productsWithMatches,
            footer: {
                total: parsed.footer?.total ?? null,
                date: parsed.footer?.date ?? null,
                time: parsed.footer?.time ?? null,
                receiptNo: parsed.footer?.receiptNo ?? null,
                totalSavings: (parsed.footer as any)?.totalSavings ?? null,
                rawText: parsed.footer?.rawText ?? null,
                // Parser self-verification — the report generator prefers
                // these over its own naive sum (recon-aware chains only).
                reconciled: (parsed.footer as any)?.reconciled ?? null,
                reconDelta: (parsed.footer as any)?.reconDelta ?? null,
                // Fused/mixed-read events the merger saw — persisted so the
                // section re-OCR gate's state is visible in the log blobs.
                ocrSuspects: (parsed.footer as any)?.ocrSuspects ?? null,
            },
        };

        const userId = persist ? await getUserId() : undefined;
        const body = {
            chain: row.chain,
            filename: row.sourcePdf,
            rawLines: allLines,
            parsedData,
            dryRun: !persist,
            userId,
            // Per-combo tracking: the server keeps rawLines.<platform>.json /
            // parsedData.<platform>.json copies so iOS and Android runs stop
            // clobbering each other's OCR snapshots.
            platform: Platform.OS,
        };
        const res = await fetch(`${API_BASE_URL}/api/receipts/batch-log`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const err = await res.text();
            return { ...row, state: 'error', message: `HTTP ${res.status}: ${err.slice(0, 120)}` };
        }
        // Discard the batch-log response body — we only need the
        // POST as a side effect (server-side logging when Persist is
        // on). Scoring is done on-device against the truth file.
        await res.json().catch(() => {});
        const status: RowStatus = {
            ...row,
            state: 'done',
            parsedProducts: parsed.products.map((p: any) => ({
                name: p.name,
                price: p.price,
                promoPrice: p.promoPrice ?? null,
                quantity: p.quantity,
                unit: p.unit,
                pricePerUnit: p.pricePerUnit ?? null,
                parsedAmount: p.parsedAmount ?? null,
                parsedUnit: p.parsedUnit ?? null,
            })),
        };

        // Score the parser output against the hand-annotated truth
        // file (when present). Truth lives at
        // shared/receipts/<chain>/<basename>.truth.json and is served
        // by the dev API's /receipts-truth route. Score is reported
        // per row in the UI and aggregated per chain at run end into
        // a single JSON pushed to /api/parser-test/results.
        try {
            const truth = await loadTruth(row.chain, row.sourcePdf);
            if (truth && isItemTruthFile(truth)) {
                // v2 PER-ITEM truth (checkmarked on the detail screen):
                // compare only the asserted items; roll-up drives the list icon.
                const cmp = compareItemTruth(truth, parsed.products as any, parsed.footer as any);
                status.truthSummary = cmp.summary;
                status.truthDiffer =
                    cmp.perProduct.filter((p) => p.state === 'differ').length +
                    (cmp.footer === 'differ' ? 1 : 0);
                status.truthMissing = cmp.missing.length;
                console.log(
                    `[truth] ${row.chain}/${row.sourcePdf}: ${cmp.summary}` +
                    ` (differ=${status.truthDiffer} missing=${cmp.missing.length})`,
                );
            } else if (truth) {
                status.truthProvisional = truth.provisional === true;
                const parsedTotal = parsed.footer?.total ?? null;
                status.comparison = compareToTruth(
                    parsed.products as any,
                    parsedTotal,
                    truth,
                );
                console.log(
                    `[score] ${row.chain}/${row.sourcePdf}: ` +
                        `score=${status.comparison.score}, ` +
                        `correct=${status.comparison.productsCorrect}/` +
                        `${truth.products.length}, ` +
                        `parsed=${status.comparison.productCount}`,
                );
            } else {
                status.comparison = null;
                status.truthSummary = 'none';
            }
        } catch (e: any) {
            console.warn(`[score] ${row.sourcePdf} comparison failed:`, e);
            status.comparison = null;
        }

        // FINAL-parse extras every chain's snapshot carries — the detail
        // screen's item-truth checkmarks assert these values.
        const snapProducts = status.parsedProducts;
        const snapFooter = {
            total: parsed.footer?.total ?? null,
            date: parsed.footer?.date ?? null,
            receiptNo: parsed.footer?.receiptNo ?? null,
            reconciled: (parsed.footer as any)?.reconciled ?? null,
            reconDelta: (parsed.footer as any)?.reconDelta ?? null,
        };
        // The EXACT region sets the Analyze screen hands ReceiptPhotoView /
        // BandCropImage (header lineRegions∥region, per-product regions 1:1
        // with snapProducts, footer lineRegions∥region, skipped) — the dev
        // detail screen renders through the SAME components with these.
        const snapRegions = {
            header: Array.isArray((parsed.header as any)?.lineRegions)
                ? (parsed.header as any).lineRegions
                : parsed.header?.region ? [parsed.header.region] : [],
            products: (parsed.products ?? []).map((p: any) => p.region ?? null),
            footer: ((parsed.footer as any)?.lineRegions?.length ?? 0) > 0
                ? (parsed.footer as any).lineRegions
                : (parsed.footer as any)?.region ? [(parsed.footer as any).region] : [],
            skipped: (parsed as any).skippedRegions ?? [],
        };

        // V2 step 1 + step 2 (Maxima only today): identify product
        // band boundaries (step 1) and convert each band into a
        // structured product (step 2) with reconcile self-check.
        // Snapshot stores band y-coords for the receipt-detail
        // overlay; full traces dumped to console for diagnosis.
        if (detected === 'maxima') {
            try {
                const planV2 = findProductBands(allLines as any, PARSER_OPTS);
                status.bandsV2Count = planV2.bands.length;
                const ranges = planV2.bands
                    .map((b, i) => `#${i + 1} ${Math.round(b.yTop)}-${Math.round(b.yBottom)}`)
                    .join(', ');
                console.log(`[V2] ${row.sourcePdf}: ${planV2.bands.length} bands [${ranges}]`);
                // Full per-line trace + extract dump. Both wrapped
                // in fenced ```text``` blocks so the user can paste
                // back into chat verbatim. Distinct begin/end markers
                // prefixed with the receipt filename so multiple
                // receipts in one Metro log are unambiguous to slice
                // apart.
                try {
                    const trace = traceProductBands(allLines as any, PARSER_OPTS);
                    console.log(
                        `[V2-TRACE BEGIN ${row.sourcePdf}]\n\`\`\`text\n${trace}\n\`\`\`\n[V2-TRACE END ${row.sourcePdf}]`,
                    );
                } catch (e) {
                    console.warn(`[V2-TRACE] ${row.sourcePdf} trace failed:`, e);
                }
                try {
                    const extract = traceMaximaExtract(allLines as any);
                    console.log(
                        `[V2-EXTRACT BEGIN ${row.sourcePdf}]\n\`\`\`text\n${extract}\n\`\`\`\n[V2-EXTRACT END ${row.sourcePdf}]`,
                    );
                } catch (e) {
                    console.warn(`[V2-EXTRACT] ${row.sourcePdf} extract failed:`, e);
                }
                // Per-band extraction. 1:1 with planV2.bands and
                // planV2.internals — same ordering, same indices —
                // so the detail screen can render product info
                // alongside the band's cropped image without an
                // extra correlation step.
                const bands: BandResult[] = planV2.bands.map((band, i) => {
                    const { product, warnings } = extractMaximaProduct(planV2.internals[i]);
                    return { band, product, warnings };
                });
                // Maxima has no typed-band parser like Rimi/Norfa/Lidl, but
                // its header/footer parse tracks per-field source-line bboxes
                // (storeAddress/storeCode/total/date/time/receiptNo). Convert
                // those + the product bands into taggedBands so the overlay
                // shows ALL recognised regions — a visual check that the
                // parser still finds store/address/total/date/receiptNo.
                const fieldRegions = [
                    ...((parsed.header as any)?.lineRegions ?? []),
                    ...((parsed.footer as any)?.lineRegions ?? []),
                ];
                const fieldBands = fieldRegions.map((r: any) => ({
                    kind: MAXIMA_FIELD_KIND[r.kind] ?? 'product',
                    label: r.kind,
                    yTop: r.yTop,
                    yBottom: r.yBottom,
                }));
                const productTagged = planV2.bands.map((b, i) => ({
                    kind: 'product',
                    label: `#${i + 1}`,
                    yTop: b.yTop,
                    yBottom: b.yBottom,
                }));
                setReceiptSnapshot(makeSnapshotKey(row.chain, row.sourcePdf), {
                    chain: row.chain,
                    sourcePdf: row.sourcePdf,
                    pages: pageMetas,
                    bands,
                    products: snapProducts,
                    footer: snapFooter,
                    regions: snapRegions,
                    taggedBands: [...fieldBands, ...productTagged] as any,
                });
            } catch (e) {
                console.warn('[batch] V2 step 1+2 failed:', e);
            }
        }

        // Rimi V2 step 1 + step 2: typed bands across the whole
        // receipt (`store-name`, `store-address`, `product`,
        // `receipt-no`, `datetime`, `total`) for the visual overlay,
        // plus per-product extraction (name, price, promoPrice,
        // qty, unit, ppu) with reconcile self-check
        // (anchor − Nuol.savings ≈ Galut.kaina).
        if (detected === 'rimi') {
            try {
                const planV2 = findReceiptBandsRimi(allLines as any);
                status.bandsV2Count = planV2.bands.length;
                const summary = planV2.bands
                    .map((b) => `${b.label}=${Math.round(b.yTop)}-${Math.round(b.yBottom)}`)
                    .join(', ');
                console.log(
                    `[Rimi V2] ${row.sourcePdf}: ${planV2.bands.length} bands [${summary}]`,
                );
                try {
                    const trace = traceReceiptBandsRimi(allLines as any);
                    console.log(
                        `[Rimi V2-TRACE BEGIN ${row.sourcePdf}]\n\`\`\`text\n${trace}\n\`\`\`\n[Rimi V2-TRACE END ${row.sourcePdf}]`,
                    );
                } catch (e) {
                    console.warn(`[Rimi V2-TRACE] ${row.sourcePdf} trace failed:`, e);
                }
                try {
                    const extract = traceRimiExtract(allLines as any);
                    console.log(
                        `[Rimi V2-EXTRACT BEGIN ${row.sourcePdf}]\n\`\`\`text\n${extract}\n\`\`\`\n[Rimi V2-EXTRACT END ${row.sourcePdf}]`,
                    );
                } catch (e) {
                    console.warn(`[Rimi V2-EXTRACT] ${row.sourcePdf} trace failed:`, e);
                }
                // Build BandResult[] for the per-product list — 1:1
                // with the product-kind subset of taggedBands and
                // 1:1 with productInternals (same iteration order
                // through computeBandsContext).
                const productBands = planV2.bands.filter((b) => b.kind === 'product');
                const bands: BandResult[] = productBands.map((band, i) => {
                    const internal = planV2.productInternals[i];
                    const { product, warnings } = extractRimiProduct(internal);
                    return {
                        band: { yTop: band.yTop, yBottom: band.yBottom },
                        product,
                        warnings,
                    };
                });
                setReceiptSnapshot(makeSnapshotKey(row.chain, row.sourcePdf), {
                    chain: row.chain,
                    sourcePdf: row.sourcePdf,
                    pages: pageMetas,
                    bands,
                    products: snapProducts,
                    footer: snapFooter,
                    regions: snapRegions,
                    taggedBands: planV2.bands,
                });
            } catch (e) {
                console.warn('[batch] Rimi V2 step 1+2 failed:', e);
            }
        }

        // Norfa V2 step 1 + step 2: typed bands across the whole
        // receipt (store-name, store-address, product, receipt-no,
        // datetime, total) for the visual overlay, plus per-product
        // extraction (name, price, promoPrice from Nuolaida discount,
        // qty/unit/ppu from WEIGHABLE).
        if (detected === 'norfa') {
            try {
                const planV2 = findReceiptBandsNorfa(allLines as any);
                status.bandsV2Count = planV2.bands.length;
                const summary = planV2.bands
                    .map((b) => `${b.label}=${Math.round(b.yTop)}-${Math.round(b.yBottom)}`)
                    .join(', ');
                console.log(
                    `[Norfa V2] ${row.sourcePdf}: ${planV2.bands.length} bands [${summary}]`,
                );
                try {
                    const trace = traceReceiptBandsNorfa(allLines as any);
                    console.log(
                        `[Norfa V2-TRACE BEGIN ${row.sourcePdf}]\n\`\`\`text\n${trace}\n\`\`\`\n[Norfa V2-TRACE END ${row.sourcePdf}]`,
                    );
                } catch (e) {
                    console.warn(`[Norfa V2-TRACE] ${row.sourcePdf} trace failed:`, e);
                }
                try {
                    const extract = traceNorfaExtract(allLines as any);
                    console.log(
                        `[Norfa V2-EXTRACT BEGIN ${row.sourcePdf}]\n\`\`\`text\n${extract}\n\`\`\`\n[Norfa V2-EXTRACT END ${row.sourcePdf}]`,
                    );
                } catch (e) {
                    console.warn(`[Norfa V2-EXTRACT] ${row.sourcePdf} trace failed:`, e);
                }
                // Build BandResult[] for the per-product list — 1:1
                // with the product-kind subset of taggedBands and
                // 1:1 with productInternals (same iteration order
                // through computeBandsContextV2).
                const productBands = planV2.bands.filter((b) => b.kind === 'product');
                const bands: BandResult[] = productBands.map((band, i) => {
                    const internal = planV2.productInternals[i];
                    const { product, warnings } = extractNorfaProduct(internal);
                    return {
                        band: { yTop: band.yTop, yBottom: band.yBottom },
                        product,
                        warnings,
                    };
                });
                setReceiptSnapshot(makeSnapshotKey(row.chain, row.sourcePdf), {
                    chain: row.chain,
                    sourcePdf: row.sourcePdf,
                    pages: pageMetas,
                    bands,
                    products: snapProducts,
                    footer: snapFooter,
                    regions: snapRegions,
                    taggedBands: planV2.bands,
                });
            } catch (e) {
                console.warn('[batch] Norfa V2 step 1+2 failed:', e);
            }
        }

        // Lidl V2 step 1 + step 2: typed bands across the whole
        // receipt (store-name, store-address, product, receipt-no,
        // datetime, total) for the visual overlay, plus per-product
        // extraction (name, price, promoPrice from Lidl Plus
        // voucher discount, qty/unit/ppu from UNIT_LINE_RE).
        // Deposit-return clusters (`Išimta` / `Užstato grąžinimas`)
        // are dropped entirely per project policy.
        if (detected === 'lidl') {
            try {
                const planV2 = findReceiptBandsLidl(allLines as any, LIDL_PARSER_OPTS);
                status.bandsV2Count = planV2.bands.length;
                const summary = planV2.bands
                    .map((b) => `${b.label}=${Math.round(b.yTop)}-${Math.round(b.yBottom)}`)
                    .join(', ');
                console.log(
                    `[Lidl V2] ${row.sourcePdf}: ${planV2.bands.length} bands [${summary}]`,
                );
                try {
                    const trace = traceReceiptBandsLidl(allLines as any);
                    console.log(
                        `[Lidl V2-TRACE BEGIN ${row.sourcePdf}]\n\`\`\`text\n${trace}\n\`\`\`\n[Lidl V2-TRACE END ${row.sourcePdf}]`,
                    );
                } catch (e) {
                    console.warn(`[Lidl V2-TRACE] ${row.sourcePdf} trace failed:`, e);
                }
                try {
                    const extract = traceLidlExtract(allLines as any);
                    console.log(
                        `[Lidl V2-EXTRACT BEGIN ${row.sourcePdf}]\n\`\`\`text\n${extract}\n\`\`\`\n[Lidl V2-EXTRACT END ${row.sourcePdf}]`,
                    );
                } catch (e) {
                    console.warn(`[Lidl V2-EXTRACT] ${row.sourcePdf} trace failed:`, e);
                }
                // Build BandResult[] for the per-product list — 1:1
                // with the product-kind subset of taggedBands and
                // 1:1 with productInternals (same iteration order).
                const productBands = planV2.bands.filter((b) => b.kind === 'product');
                const bands: BandResult[] = productBands.map((band, i) => {
                    const internal = planV2.productInternals[i];
                    const { product, warnings } = extractLidlProduct(internal);
                    return {
                        band: { yTop: band.yTop, yBottom: band.yBottom },
                        product,
                        warnings,
                    };
                });
                setReceiptSnapshot(makeSnapshotKey(row.chain, row.sourcePdf), {
                    chain: row.chain,
                    sourcePdf: row.sourcePdf,
                    pages: pageMetas,
                    bands,
                    products: snapProducts,
                    footer: snapFooter,
                    regions: snapRegions,
                    taggedBands: planV2.bands,
                });
            } catch (e) {
                console.warn('[batch] Lidl V2 step 1+2 failed:', e);
            }
        }

        // IKI snapshot: no V2 band planner here — each parsed product already
        // carries its merged-line region, which IS the band (same page-pixel
        // space as the page images, so the detail screen's crops line up).
        // 1:1 bands↔products keeps the detail's band→product index mapping
        // trivially aligned for the item-truth checkmarks.
        if (detected === 'iki') {
            try {
                const ikiProducts = (parsed.products ?? []) as any[];
                const bands: BandResult[] = ikiProducts.map((p) => ({
                    band: {
                        yTop: p.region?.yTop ?? 0,
                        yBottom: p.region?.yBottom ?? 0,
                    },
                    product: p,
                    warnings: [],
                }));
                status.bandsV2Count = bands.length;
                setReceiptSnapshot(makeSnapshotKey(row.chain, row.sourcePdf), {
                    chain: row.chain,
                    sourcePdf: row.sourcePdf,
                    pages: pageMetas,
                    bands,
                    products: snapProducts,
                    footer: snapFooter,
                    regions: snapRegions,
                });
            } catch (e) {
                console.warn('[batch] iki snapshot failed:', e);
            }
        }

        // ── Card / loyalty MASK DETECTION (all chains) ──────────────
        // Find the bank-card + loyalty-card Y-bands that the real upload
        // flow will redact, and attach them to the snapshot so the detail
        // screen draws them over the receipt — this is the surface for
        // eyeballing masking-detection accuracy on real receipts. Runs
        // for every chain (including iki, which has no V2 snapshot yet),
        // so a minimal snapshot is created when one doesn't exist.
        try {
            const maskBands = detectCardMaskBands(allLines as any, detected);
            status.maskBandCount = maskBands.length;
            console.log(
                `[MASK BEGIN ${row.sourcePdf}]\n\`\`\`text\n${traceCardMaskBands(maskBands)}\n\`\`\`\n[MASK END ${row.sourcePdf}]`,
            );
            const key = makeSnapshotKey(row.chain, row.sourcePdf);
            const existing = getReceiptSnapshot(key);
            if (existing) {
                setReceiptSnapshot(key, { ...existing, maskBands });
            } else {
                setReceiptSnapshot(key, {
                    chain: row.chain,
                    sourcePdf: row.sourcePdf,
                    pages: pageMetas,
                    bands: [],
                    maskBands,
                });
            }
        } catch (e) {
            console.warn('[batch] mask detection failed:', e);
        }
        return status;
    };

    const runBatch = async () => {
        if (statuses.length === 0) {
            Alert.alert('Nieko nėra', 'Pirma paleiskite `npm run receipts:stage`.');
            return;
        }
        setRunning(true);
        abortRef.current = false;
        await activateKeepAwakeAsync('receipt-batch');
        // Collected per-row results in run order. We can't read
        // `statuses` after the loop because setStatuses is async and
        // batched — local accumulator is the source of truth for
        // post-run aggregation.
        const finalRows: RowStatus[] = [];
        try {
            for (let i = 0; i < statuses.length; i++) {
                if (abortRef.current) break;
                setStatuses((prev) => {
                    const next = [...prev];
                    next[i] = { ...next[i], state: 'running' };
                    return next;
                });
                let rowResult: RowStatus;
                try {
                    rowResult = await processOne(i);
                } catch (e: any) {
                    rowResult = {
                        ...statuses[i],
                        state: 'error',
                        message: e?.message ?? String(e),
                    };
                }
                finalRows.push(rowResult);
                setStatuses((prev) => {
                    const next = [...prev];
                    next[i] = rowResult;
                    return next;
                });
            }

            // Finalize once per chain that had any activity.
            const chainsDone = new Set(finalRows.map((s) => s.chain));
            for (const chain of chainsDone) {
                try {
                    await fetch(`${API_BASE_URL}/api/receipts/batch-log/finalize`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        // platform → _baseline.<platform>.json: run-over-run
                        // diffs always compare the SAME OCR/parser combo.
                        body: JSON.stringify({ chain, platform: Platform.OS }),
                    });
                } catch {}
            }

            // Aggregate per chain and POST a single results JSON per
            // chain (only chains that had at least one truth-scored
            // receipt). Lands at shared/receipts/_results/<runId>.json
            // for the doc generator to consume.
            const isoStamp = new Date().toISOString().replace(/[:.]/g, '-');
            for (const chain of chainsDone) {
                const chainRows = finalRows.filter(
                    (r) => r.chain === chain && r.comparison,
                );
                if (chainRows.length === 0) continue;

                let productsCorrectTotal = 0;
                let productsTruthTotal = 0;
                const receipts = chainRows.map((r) => {
                    const c = r.comparison!;
                    productsCorrectTotal += c.productsCorrect;
                    // truthCount = correct + missed (greedy pairing
                    // covers everything). Avoids re-fetching truth.
                    productsTruthTotal += c.productsCorrect + c.productsMissed;
                    return {
                        pdf: r.sourcePdf,
                        truthProductCount: c.productsCorrect + c.productsMissed,
                        truthProvisional: r.truthProvisional === true,
                        v2: {
                            productCount: c.productCount,
                            productsCorrect: c.productsCorrect,
                            productsMissed: c.productsMissed,
                            productsExtra: c.productsExtra,
                            pricesCorrect: c.pricesCorrect,
                            promoPricesCorrect: c.promoPricesCorrect,
                            quantitiesCorrect: c.quantitiesCorrect,
                            unitsCorrect: c.unitsCorrect,
                            weighableCorrect: c.weighableCorrect,
                            totalAmountDelta: c.totalAmountDelta,
                            totalAmountParsed: c.totalAmountParsed,
                            totalAmountTruth: c.totalAmountTruth,
                            score: c.score,
                            issues: c.issues,
                            // Full parser output for this receipt — lets a
                            // human (or the doc generator) reconstruct the
                            // truth file when the parser is treated as
                            // authoritative.
                            parsedProducts: r.parsedProducts ?? [],
                        },
                    };
                });
                const denom = Math.max(productsTruthTotal, 1);
                const aggregateScore =
                    Math.round((productsCorrectTotal / denom) * 1000) / 1000;
                // Platform in the runId AND payload: _results files sort into
                // per-combo series (rimi-android-…, rimi-ios-…) for diffing.
                const runId = `${chain}-${Platform.OS}-${isoStamp}`;
                const payload = {
                    platform: Platform.OS,
                    $schema: 'parser-test-v1',
                    runId,
                    completedAt: new Date().toISOString(),
                    summary: {
                        v2: {
                            score: aggregateScore,
                            productsCorrectTotal,
                            productsTruthTotal,
                        },
                        receiptsTested: chainRows.length,
                    },
                    receipts,
                };
                try {
                    await fetch(`${API_BASE_URL}/api/parser-test/results`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                    });
                    console.log(
                        `[results] saved ${runId}: score=${aggregateScore} ` +
                            `(${productsCorrectTotal}/${productsTruthTotal})`,
                    );
                } catch (e) {
                    console.warn(`[results] POST failed for ${runId}:`, e);
                }
            }
        } finally {
            deactivateKeepAwake('receipt-batch');
            setRunning(false);
        }
    };

    const stop = () => {
        abortRef.current = true;
    };

    const runSingle = async (idx: number) => {
        if (running) return;
        setRunning(true);
        setStatuses(prev => {
            const next = [...prev];
            next[idx] = { ...next[idx], state: 'running' };
            return next;
        });
        await activateKeepAwakeAsync('receipt-batch');
        try {
            const result = await processOne(idx);
            setStatuses(prev => {
                const next = [...prev];
                next[idx] = result;
                return next;
            });
        } catch (e: any) {
            setStatuses(prev => {
                const next = [...prev];
                next[idx] = { ...next[idx], state: 'error', message: e?.message ?? String(e) };
                return next;
            });
        } finally {
            deactivateKeepAwake('receipt-batch');
            setRunning(false);
        }
    };

    if (loading) {
        return (
            <View style={styles.centered}>
                <Stack.Screen options={{ title: 'Kvitų paketinis testas' }} />
                <MaterialProgress size="large" color={colors.primary} />
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <Stack.Screen options={{ title: 'Kvitų paketinis testas' }} />

            <View style={styles.topBar}>
                <Text style={styles.countText}>
                    {statuses.length} kvit{statuses.length === 1 ? 'as' : 'ai'}
                </Text>
                <View style={styles.persistRow}>
                    <Text style={styles.persistLabel}>Persist</Text>
                    <Switch value={persist} onValueChange={setPersist} disabled={running} />
                </View>
                {devicePdfAvailable() && (
                    <View style={styles.persistRow}>
                        <Text style={styles.persistLabel}>PDF įreng.</Text>
                        <Switch value={devicePdf} onValueChange={setDevicePdf} disabled={running} />
                    </View>
                )}
                <TouchableOpacity
                    style={[styles.button, running ? styles.buttonStop : styles.buttonStart]}
                    onPress={running ? stop : runBatch}
                >
                    <Text style={styles.buttonText}>{running ? 'Stop' : 'Start'}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.refreshButton} onPress={refresh} disabled={running}>
                    <Ionicons name="refresh" size={20} color={colors.textPrimary} />
                </TouchableOpacity>
            </View>

            <ScrollView style={styles.list}>
                {statuses.length === 0 && (
                    <Text style={styles.emptyHint}>
                        Nerasta nė vieno kvito. Patikrinkite, ar `npm run receipts:stage` pavyko.
                    </Text>
                )}
                {statuses.map((s, idx) => {
                    const canNavigate = (s.chain === 'maxima' || s.chain === 'rimi' ||
                        s.chain === 'norfa' || s.chain === 'lidl' || s.chain === 'iki') && s.state === 'done';
                    const canRun = s.state === 'pending' || s.state === 'error' || s.state === 'no-chain';
                    return (
                        <TouchableOpacity
                            key={`${s.chain}-${s.sourcePdf}-${idx}`}
                            style={styles.row}
                            disabled={running || (!canNavigate && !canRun)}
                            onPress={() => {
                                if (canNavigate) {
                                    router.push({
                                        pathname: '/dev/receipt-detail',
                                        params: { chain: s.chain, sourcePdf: s.sourcePdf },
                                    });
                                } else if (canRun) {
                                    runSingle(idx);
                                }
                            }}
                            activeOpacity={0.7}
                        >
                            <StatusIcon state={s.state} colors={colors} />
                            <View style={{ flex: 1 }}>
                                <Text style={styles.rowName}>{s.sourcePdf}</Text>
                                <Text style={styles.rowMeta}>
                                    {s.chain}
                                    {s.state === 'done' && s.bandsV2Count !== undefined &&
                                        ` · ${s.bandsV2Count} band${s.bandsV2Count === 1 ? 'a' : 'os'}`}
                                    {s.state === 'done' && s.maskBandCount !== undefined &&
                                        ` · 🛡${s.maskBandCount}`}
                                    {s.state === 'done' && s.comparison && (
                                        ` · score ${s.comparison.score.toFixed(2)} ` +
                                        `(${s.comparison.productsCorrect}/` +
                                        `${s.comparison.productsCorrect + s.comparison.productsMissed})`
                                    )}
                                    {s.state === 'done' && s.truthSummary === 'attention' &&
                                        ` · ⚠ ${s.truthDiffer ?? 0} skiriasi${s.truthMissing ? `, ${s.truthMissing} dingo` : ''}`}
                                    {s.state === 'done' && s.comparison === null && s.truthSummary === 'none' &&
                                        ' · be truth'}
                                    {s.message && ` · ${s.message}`}
                                </Text>
                            </View>
                            {s.state === 'done' && s.truthSummary === 'attention' && (
                                <Ionicons name="warning" size={18} color={colors.error} />
                            )}
                            {s.state === 'done' && s.truthSummary === 'ok' && (
                                <Ionicons name="shield-checkmark" size={16} color={colors.success} />
                            )}
                            {s.state === 'done' && s.truthSummary === 'partial' && (
                                <Ionicons name="shield-half-outline" size={16} color={colors.textMuted} />
                            )}
                            {canNavigate && (
                                <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                            )}
                            {canRun && !running && (
                                <Ionicons name="play-circle-outline" size={18} color={colors.primary} />
                            )}
                        </TouchableOpacity>
                    );
                })}
            </ScrollView>
        </View>
    );
}

const StatusIcon = ({ state, colors }: { state: RowStatus['state']; colors: AppTheme }) => {
    if (state === 'pending') return <Ionicons name="time-outline" size={18} color={colors.textMuted} />;
    if (state === 'running') return <MaterialProgress size="small" color={colors.primary} />;
    if (state === 'done') return <Ionicons name="checkmark-circle" size={18} color={colors.success} />;
    if (state === 'no-chain') return <Ionicons name="help-circle-outline" size={18} color={colors.textSecondary} />;
    return <Ionicons name="alert-circle" size={18} color={colors.error} />;
};

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    topBar: {
        flexDirection: 'row', alignItems: 'center', gap: 10,
        padding: 12, backgroundColor: c.cardBackground,
        borderBottomWidth: 1, borderBottomColor: c.border,
    },
    countText: { fontSize: 13, color: c.textSecondary, flex: 1 },
    persistRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    persistLabel: { fontSize: 13, color: c.textSecondary },
    button: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
    buttonStart: { backgroundColor: c.primary },
    buttonStop: { backgroundColor: c.error },
    buttonText: { color: c.onPrimary, fontWeight: '600' },
    refreshButton: { padding: 6 },
    list: { flex: 1 },
    row: {
        flexDirection: 'row', alignItems: 'center', gap: 10,
        paddingVertical: 10, paddingHorizontal: 14,
        borderBottomWidth: 1, borderBottomColor: c.borderSubtle,
    },
    rowName: { fontSize: 14, color: c.textPrimary, fontWeight: '500' },
    rowMeta: { fontSize: 11, color: c.textSecondary, marginTop: 2 },
    emptyHint: { padding: 20, color: c.textMuted, textAlign: 'center', fontSize: 13 },
});
