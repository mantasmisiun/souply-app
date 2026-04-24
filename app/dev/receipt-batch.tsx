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
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import {
    isIkiReceipt,
    parseIkiReceipt,
} from '../../../shared/parsers/ikiParser';
import {
    isMaximaReceipt,
    parseMaximaReceipt,
} from '../../../shared/parsers/maximaParser';
import {
    isRimiReceipt,
    parseRimiReceipt,
} from '../../../shared/parsers/rimiParser';
import {
    isNorfaReceipt,
    parseNorfaReceipt,
} from '../../../shared/parsers/norfaParser';
import {
    isLidlReceipt,
    parseLidlReceipt,
} from '../../../shared/parsers/lidlParser';
import { useTheme, type AppTheme } from '../../constants/theme';

// Why HTTP instead of reading staged files locally: every local-read
// path (file:// URIs through expo-file-system, fetch(), MLKit) runs
// into scoped-storage or FUSE restrictions on Samsung/OneUI and
// Android 13+. Serving the staged PNGs over the dev API's new
// /receipts-batch static route sidesteps all of it — the phone just
// fetches manifest.json and downloads each page into its own cache
// before OCR, same trust boundary as the existing API calls.
const HTTP_BATCH_ROOT = `${API_BASE_URL}/receipts-batch`;
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

interface RowStatus {
    sourcePdf: string;
    chain: ChainName;
    state: 'pending' | 'running' | 'done' | 'error' | 'no-chain';
    message?: string;
    productCount?: number;
    matched?: number;
    unmatched?: number;
}

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
 * OCR one PNG → `PageLine[]` in image-pixel space. Scale heuristic
 * mirrors receipt-process.tsx: Android's BitmapFactory may downsample
 * by a power of 2, so we estimate MLKit→pixel scale from text extent
 * and snap to the nearest 1/{1,2,4,8}. Without this, frame coords
 * carry through as off-by-multiple and parser heuristics that depend
 * on y-thresholds (header/footer detection) start misfiring.
 */
const ocrImage = async (uri: string): Promise<PageLine[]> => {
    const rotated = await ensurePortrait(uri);
    const { width, height } = await new Promise<{ width: number; height: number }>(
        (resolve, reject) => {
            Image.getSize(rotated, (w, h) => resolve({ width: w, height: h }), reject);
        }
    );
    const pageResult = await TextRecognition.recognize(rotated);

    let mlkitMaxX = 0;
    let mlkitMaxY = 0;
    for (const block of pageResult.blocks) {
        for (const line of block.lines) {
            if (line.frame) {
                mlkitMaxX = Math.max(mlkitMaxX, line.frame.left + line.frame.width);
                mlkitMaxY = Math.max(mlkitMaxY, line.frame.top + line.frame.height);
            }
        }
    }
    const scaleX = mlkitMaxX > 0 ? width / mlkitMaxX : 1;
    const scaleY = mlkitMaxY > 0 ? height / mlkitMaxY : 1;
    const estimatedScale = Math.min(1, scaleX, scaleY);
    const roundedInv = Math.max(1, Math.min(8, Math.round(1 / estimatedScale)));
    const frameScale = 1 / roundedInv;

    const lines: PageLine[] = [];
    for (const block of pageResult.blocks) {
        for (const line of block.lines) {
            if (line.frame && line.text.trim()) {
                lines.push({
                    text: line.text.trim(),
                    yTop: line.frame.top * frameScale,
                    yBottom: (line.frame.top + line.frame.height) * frameScale,
                    xLeft: line.frame.left * frameScale,
                    xRight: (line.frame.left + line.frame.width) * frameScale,
                });
            }
        }
    }
    lines.sort((a, b) => a.yTop - b.yTop);
    return lines;
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

        // Download each page into the app's cache, OCR it, then
        // clean the cache entry. MLKit needs a local file path
        // (won't fetch over https itself), so the HTTP-delivered PNG
        // is saved to cacheDirectory for the duration of OCR only.
        const allLines: PageLine[] = [];
        const cachedUris: string[] = [];
        let yOffset = 0;
        try {
            for (const pageName of entry.pages) {
                const localUri = await downloadPageToCache(row.chain, pageName);
                cachedUris.push(localUri);
                const pageLines = await ocrImage(localUri);
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
            // Cleanup regardless of OCR success/failure — leaving 50+
            // MB of PNGs in cache per run adds up fast.
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
        const json = await res.json();
        return {
            ...row,
            state: 'done',
            productCount: json.productCount,
            matched: json.matchedCount,
            unmatched: json.unmatchedCount,
        };
    };

    const runBatch = async () => {
        if (statuses.length === 0) {
            Alert.alert('Nieko nėra', 'Pirma paleiskite `npm run receipts:stage`.');
            return;
        }
        setRunning(true);
        abortRef.current = false;
        await activateKeepAwakeAsync('receipt-batch');
        try {
            for (let i = 0; i < statuses.length; i++) {
                if (abortRef.current) break;
                setStatuses((prev) => {
                    const next = [...prev];
                    next[i] = { ...next[i], state: 'running' };
                    return next;
                });
                try {
                    const result = await processOne(i);
                    setStatuses((prev) => {
                        const next = [...prev];
                        next[i] = result;
                        return next;
                    });
                } catch (e: any) {
                    setStatuses((prev) => {
                        const next = [...prev];
                        next[i] = { ...next[i], state: 'error', message: e?.message ?? String(e) };
                        return next;
                    });
                }
            }

            // Finalize once per chain that had any activity.
            const chainsDone = new Set(statuses.map((s) => s.chain));
            for (const chain of chainsDone) {
                try {
                    await fetch(`${API_BASE_URL}/api/receipts/batch-log/finalize`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chain }),
                    });
                } catch {}
            }
        } finally {
            deactivateKeepAwake('receipt-batch');
            setRunning(false);
        }
    };

    const stop = () => {
        abortRef.current = true;
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
                {statuses.map((s, idx) => (
                    <View key={`${s.chain}-${s.sourcePdf}-${idx}`} style={styles.row}>
                        <StatusIcon state={s.state} colors={colors} />
                        <View style={{ flex: 1 }}>
                            <Text style={styles.rowName}>{s.sourcePdf}</Text>
                            <Text style={styles.rowMeta}>
                                {s.chain}
                                {s.state === 'done' &&
                                    ` · ${s.productCount} preki${s.productCount === 1 ? 'ė' : 'ės'} · ${s.matched} match · ${s.unmatched} unmatched`}
                                {s.message && ` · ${s.message}`}
                            </Text>
                        </View>
                    </View>
                ))}
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
