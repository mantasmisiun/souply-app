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

import { Ionicons } from '@expo/vector-icons';
import TextRecognition from '@react-native-ml-kit/text-recognition';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Image,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { ocrImageTiled } from '../../utils/mlkitOcr';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import {
    isIkiReceipt,
    parseIkiReceipt,
} from '@shared/parsers/ikiParser';
import {
    isMaximaReceipt,
    parseMaximaReceipt,
    findProductBands,
    traceProductBands,
    traceMaximaExtract,
    extractMaximaProduct,
} from '@shared/parsers/maximaParser';
import {
    setReceiptSnapshot,
    makeSnapshotKey,
    type PageMeta,
    type BandResult,
} from '../../utils/parserTestSnapshot';
import {
    isRimiReceipt,
    parseRimiReceipt,
    findReceiptBandsRimi,
    traceReceiptBandsRimi,
    extractRimiProduct,
    traceRimiExtract,
} from '@shared/parsers/rimiParser';
import {
    isNorfaReceipt,
    parseNorfaReceipt,
    findReceiptBandsNorfa,
    traceReceiptBandsNorfa,
    extractNorfaProduct,
    traceNorfaExtract,
} from '@shared/parsers/norfaParser';
import {
    isLidlReceipt,
    parseLidlReceipt,
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

// Why HTTP instead of reading staged files locally: every local-read
// path (file:// URIs through expo-file-system, fetch(), MLKit) runs
// into scoped-storage or FUSE restrictions on Samsung/OneUI and
// Android 13+. Serving the staged PNGs over the dev API's new
// /receipts-batch static route sidesteps all of it — the phone just
// fetches manifest.json and downloads each page into its own cache
// before OCR, same trust boundary as the existing API calls.
const HTTP_BATCH_ROOT = `${API_BASE_URL}/receipts-batch`;
const HTTP_TRUTH_ROOT = `${API_BASE_URL}/receipts-truth`;
const CHAINS = ['maxima', 'rimi', 'norfa', 'lidl'] as const;
type ChainName = (typeof CHAINS)[number];

// Chain ids mirror the StoreChain table. Maxima=1, Rimi=2, IKI=3,
// Norfa=4. Lidl set to 5 — confirm with
// `SELECT id FROM StoreChain WHERE name LIKE '%Lidl%'` and update if
// different.
const CHAIN_ID: Record<ChainName, number> = { maxima: 1, rimi: 2, norfa: 4, lidl: 5 };

interface ManifestEntry {
    sourcePdf: string;
    pages: string[];
}

interface PageLine {
    text: string;
    yTop: number;
    yBottom: number;
    xLeft: number;
    xRight: number;
}

interface ParsedProductSnapshot {
    name: string;
    price: number;
    promoPrice: number | null;
    quantity: number;
    unit: string;
    pricePerUnit: number | null;
}

interface RowStatus {
    sourcePdf: string;
    chain: ChainName;
    state: 'pending' | 'running' | 'done' | 'error' | 'no-chain';
    message?: string;
    /** V2 step 1 output: number of product bands detected. Tap a row
     *  to inspect the bands visually on the receipt-detail screen. */
    bandsV2Count?: number;
    /** Comparison vs hand-annotated truth file (if present alongside
     *  the PDF/PNG). null if no truth file or comparison failed. */
    comparison?: ParserComparison | null;
    /** Snapshot of parser-emitted products (lean fields used by the
     *  truth comparison). Persisted into the _results JSON so the
     *  truth files can be reconstructed when the parser is treated
     *  as authoritative. */
    parsedProducts?: ParsedProductSnapshot[];
}

const loadTruth = async (
    chain: ChainName,
    sourcePdf: string,
): Promise<TruthFile | null> => {
    // Strip extension; truth file is `<basename>.truth.json` next to
    // the PDF/PNG in shared/receipts/<chain>/.
    const base = sourcePdf.replace(/\.(pdf|png|jpg|jpeg)$/i, '');
    const url = `${HTTP_TRUTH_ROOT}/${chain}/${base}.truth.json`;
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        return (await res.json()) as TruthFile;
    } catch {
        return null;
    }
};

const readManifest = async (chain: ChainName): Promise<ManifestEntry[]> => {
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
 * OCR one PNG → `PageLine[]` + native pixel dims (after the rotate
 * step). Dims are needed by the dev receipt-detail screen to scale
 * V2's band y-coords (in image-pixel space) to display-pixel space
 * when overlaying band rectangles on the rendered image.
 */
const ocrImage = async (
    uri: string,
): Promise<{ lines: PageLine[]; pixelWidth: number; pixelHeight: number }> => {
    const rotated = await ensurePortrait(uri);
    const result = await ocrImageTiled(rotated);
    return {
        lines: result.lines,
        pixelWidth: result.pixelWidth,
        pixelHeight: result.pixelHeight,
    };
};

/**
 * Rotate sideways photos upright before OCR. Scanned-PDF pages are
 * already portrait; phone photos are where this matters. Heuristic: if
 * the image is wider than tall, OCR both rotations and pick whichever
 * produces more non-trivial text lines.
 */
const ensurePortrait = async (uri: string): Promise<string> => {
    const { width, height } = await new Promise<{ width: number; height: number }>(
        (resolve, reject) => {
            Image.getSize(uri, (w, h) => resolve({ width: w, height: h }), reject);
        }
    );
    if (height >= width) return uri;
    const cw = await ImageManipulator.manipulateAsync(uri, [{ rotate: 90 }], {
        compress: 1,
        format: ImageManipulator.SaveFormat.JPEG,
    });
    const ccw = await ImageManipulator.manipulateAsync(uri, [{ rotate: -90 }], {
        compress: 1,
        format: ImageManipulator.SaveFormat.JPEG,
    });
    const [cwRes, ccwRes] = await Promise.all([
        TextRecognition.recognize(cw.uri),
        TextRecognition.recognize(ccw.uri),
    ]);
    const count = (r: any) =>
        r.blocks.reduce(
            (acc: number, b: any) => acc + b.lines.filter((l: any) => l.text.trim().length >= 3).length,
            0
        );
    return count(cwRes) >= count(ccwRes) ? cw.uri : ccw.uri;
};

const detectChain = (lines: PageLine[]): ChainName | null => {
    const texts = lines.map((l) => l.text);
    // Rimi / Maxima checked before Norfa — their headers are strict
    // enough that false-positives on a Norfa receipt are unlikely, but
    // Norfa's `NORFOS` token is narrower so keeping it near the end
    // makes the ordering symmetric with how isXReceipt detectors
    // became over time.
    if (isRimiReceipt(texts)) return 'rimi';
    if (isMaximaReceipt(texts)) return 'maxima';
    if (isIkiReceipt(texts)) return 'iki' as ChainName;
    if (isNorfaReceipt(texts)) return 'norfa';
    if (isLidlReceipt(texts)) return 'lidl';
    return null;
};

const runParser = (chain: ChainName | 'iki', lines: PageLine[]) => {
    if (chain === 'maxima') return parseMaximaReceipt(lines as any);
    if (chain === 'rimi') return parseRimiReceipt(lines as any);
    if (chain === 'iki') return parseIkiReceipt(lines as any);
    if (chain === 'norfa') return parseNorfaReceipt(lines as any);
    if (chain === 'lidl') return parseLidlReceipt(lines as any);
    return null;
};

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
            const url = `${API_BASE_URL}/api/store-products/match?chainId=${chainId}&name=${encodeURIComponent(p.name ?? '')}${p.quantity ? `&amount=${p.quantity}` : ''}${p.unit ? `&unit=${encodeURIComponent(p.unit)}` : ''}`;
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

        // Download each page into the app's cache, OCR it, then clean
        // the cache entry. MLKit needs a local file path (won't fetch
        // over https itself), so the HTTP-delivered PNG is saved to
        // cacheDirectory for the duration of OCR only.
        const allLines: PageLine[] = [];
        const cachedUris: string[] = [];
        const pageMetas: PageMeta[] = []; // for snapshot → detail screen
        let yOffset = 0;
        try {
            for (const pageName of entry.pages) {
                const localUri = await downloadPageToCache(row.chain, pageName);
                cachedUris.push(localUri);
                const { lines: pageLines, pixelWidth, pixelHeight } = await ocrImage(localUri);
                pageMetas.push({
                    name: pageName,
                    pixelWidth,
                    pixelHeight,
                    yOffsetInParserSpace: yOffset,
                });
                const maxY = pageLines.reduce((m, l) => Math.max(m, l.yBottom), 0);
                for (const l of pageLines) {
                    allLines.push({
                        ...l,
                        yTop: l.yTop + yOffset,
                        yBottom: l.yBottom + yOffset,
                    });
                }
                yOffset += maxY + 50;
            }
        } finally {
            for (const u of cachedUris) {
                FileSystem.deleteAsync(u, { idempotent: true }).catch(() => {});
            }
        }

        const detected = detectChain(allLines);
        if (!detected) {
            return { ...row, state: 'no-chain', message: 'isXReceipt detectors all false' };
        }

        const parsed = runParser(detected, allLines);
        if (!parsed) {
            return { ...row, state: 'error', message: 'parser returned null' };
        }

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
            if (truth) {
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
            }
        } catch (e: any) {
            console.warn(`[score] ${row.sourcePdf} comparison failed:`, e);
            status.comparison = null;
        }

        // V2 step 1 + step 2 (Maxima only today): identify product
        // band boundaries (step 1) and convert each band into a
        // structured product (step 2) with reconcile self-check.
        // Snapshot stores band y-coords for the receipt-detail
        // overlay; full traces dumped to console for diagnosis.
        if (detected === 'maxima') {
            try {
                const planV2 = findProductBands(allLines as any);
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
                    const trace = traceProductBands(allLines as any);
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
                setReceiptSnapshot(makeSnapshotKey(row.chain, row.sourcePdf), {
                    chain: row.chain,
                    sourcePdf: row.sourcePdf,
                    pages: pageMetas,
                    bands,
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
                const planV2 = findReceiptBandsLidl(allLines as any);
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
                    taggedBands: planV2.bands,
                });
            } catch (e) {
                console.warn('[batch] Lidl V2 step 1+2 failed:', e);
            }
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
                        body: JSON.stringify({ chain }),
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
                const runId = `${chain}-${isoStamp}`;
                const payload = {
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
                <ActivityIndicator size="large" color={colors.primary} />
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
                        s.chain === 'norfa' || s.chain === 'lidl') && s.state === 'done';
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
                                    {s.state === 'done' && s.comparison && (
                                        ` · score ${s.comparison.score.toFixed(2)} ` +
                                        `(${s.comparison.productsCorrect}/` +
                                        `${s.comparison.productsCorrect + s.comparison.productsMissed})`
                                    )}
                                    {s.state === 'done' && s.comparison === null &&
                                        ' · be truth'}
                                    {s.message && ` · ${s.message}`}
                                </Text>
                            </View>
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
    if (state === 'running') return <ActivityIndicator size="small" color={colors.primary} />;
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
