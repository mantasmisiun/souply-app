/**
 * Dev-only: per-receipt detail view that surfaces V2's full output
 * — band y-coords (step 1) AND extracted products (step 2). Tapping
 * a row in the Kvitų paketinis testas screen lands here.
 *
 * Layout:
 *   1. Header: PDF name + meta.
 *   2. Collapsible "Visa kvito apžvalga" — the full receipt
 *      image(s) with V2 band rectangles overlaid + the y-coord
 *      list. Hidden by default; tap the chevron to expand.
 *   3. Per-product list — one row per band, each row showing
 *      the cropped band image (the OCR region the data came from)
 *      plus the structured product fields (name, price, qty, unit,
 *      pricePerUnit, promoPrice, reconcile state) and any
 *      warnings the extractor surfaced.
 *
 * Rendering is 100% SHARED with the Analyze screen — the receipt-with-bands
 * view is ReceiptPhotoView (the Kvitas tab component) and each product's
 * band crop is BandCropImage (the Prekės tab component), both fed the same
 * inputs the live screen passes (final-parse regions + page metas). The only
 * screen-local work is projection: each staged page is downloaded and
 * normalized into OCR pixel space (normalizeLoadedImage — the same helper
 * the saved-receipt viewer uses), and multi-page regions shift into their
 * page's local y space. Band/crop APPEARANCE can never diverge from the app.
 */

import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
    Dimensions,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { API_BASE_URL } from '../../config/api';
import { devLog } from '../../utils/devLog';
import ReceiptPhotoView from '../../components/receipt/ReceiptPhotoView';
import { BandCropImage } from '../../components/receipt/BandCropImage';
import { normalizeLoadedImage, type PageMeta as ImagePageMeta } from '../../utils/receiptImage';
import {
    compareItemTruth,
    isItemTruthFile,
    truthFromParsed,
    footerFromParsed,
    type ItemTruthFile,
    type ProductTruthComparison,
} from '../../utils/itemTruth';
import { useTheme, type AppTheme } from '../../constants/theme';
import {
    getReceiptSnapshot,
    makeSnapshotKey,
    type BandResult,
    type PageMeta,
    type ReceiptSnapshot,
    type SnapshotRegion,
} from '../../utils/parserTestSnapshot';
import type { ProductBand } from '@shared/parsers/maximaParser';
import type { RimiBandKind, RimiReceiptBand } from '@shared/parsers/rimiParser';
import type { NorfaReceiptBand } from '@shared/parsers/norfaParser';
import type { LidlReceiptBand } from '@shared/parsers/lidlParser';
import type { MaskBand } from '@shared/parsers/cardMaskDetection';

// Kinds emitted by any chain's V2 parser. Rimi/Norfa/Lidl share
// structurally-identical band-kind unions; the overlay colour map
// is shared too.
type TaggedBandKind =
    | RimiBandKind
    | NorfaReceiptBand['kind']
    | LidlReceiptBand['kind'];

type BandLike = ProductBand | RimiReceiptBand | NorfaReceiptBand | LidlReceiptBand;

/** Card width for the shared BandCropImage (products section pads 12 a side). */
const DETAIL_CARD_WIDTH = Dimensions.get('window').width - 24;

/** Page index a parser-space yTop falls on (multi-page y concat). */
const pageIdxFor = (yTop: number, pages: PageMeta[]): number => {
    for (let i = pages.length - 1; i >= 0; i--) {
        if (yTop >= pages[i].yOffsetInParserSpace) return i;
    }
    return 0;
};

/** Shift every y field of a region into one page's local pixel space. */
const shiftRegion = (r: SnapshotRegion, off: number): SnapshotRegion => ({
    ...r,
    yTop: r.yTop - off,
    yBottom: r.yBottom - off,
    yLeftTop: r.yLeftTop != null ? r.yLeftTop - off : undefined,
    yRightTop: r.yRightTop != null ? r.yRightTop - off : undefined,
    yLeftBottom: r.yLeftBottom != null ? r.yLeftBottom - off : undefined,
    yRightBottom: r.yRightBottom != null ? r.yRightBottom - off : undefined,
    yMidTop: r.yMidTop != null ? r.yMidTop - off : undefined,
    yMidBottom: r.yMidBottom != null ? r.yMidBottom - off : undefined,
    yMidTopR: r.yMidTopR != null ? r.yMidTopR - off : undefined,
    yMidBottomR: r.yMidBottomR != null ? r.yMidBottomR - off : undefined,
});

/** Bucket regions per page for the shared ReceiptPhotoView (one per page). */
const bucketRegionsByPage = (
    regions: SnapshotRegion[],
    pages: PageMeta[],
): SnapshotRegion[][] => {
    const perPage: SnapshotRegion[][] = pages.map(() => []);
    for (const r of regions) {
        const pi = pageIdxFor(r.yTop, pages);
        perPage[pi].push(shiftRegion(r, pages[pi].yOffsetInParserSpace));
    }
    return perPage;
};

/** Solid redaction-box colour per mask kind. */
const maskKindColor = (kind: MaskBand['kind']): string =>
    kind === 'bank' ? '#C62828' : kind === 'loyalty' ? '#EF6C00' : '#6A1B9A';

/**
 * Per-kind overlay colour. Picked to be visually distinct on the
 * thermal-receipt-grey background while keeping enough
 * transparency that the underlying text stays legible.
 */
const bandKindColor = (kind: TaggedBandKind | undefined, fallback: string): {
    border: string;
    fill: string;
} => {
    switch (kind) {
        case 'store-name':
            return { border: '#1976D2', fill: 'rgba(25, 118, 210, 0.10)' };
        case 'store-address':
            return { border: '#0288D1', fill: 'rgba(2, 136, 209, 0.10)' };
        case 'product':
            return { border: fallback, fill: 'rgba(235, 103, 132, 0.08)' };
        case 'receipt-no':
            return { border: '#7B1FA2', fill: 'rgba(123, 31, 162, 0.10)' };
        case 'datetime':
            return { border: '#388E3C', fill: 'rgba(56, 142, 60, 0.10)' };
        case 'total':
            return { border: '#E65100', fill: 'rgba(230, 81, 0, 0.12)' };
        default:
            return { border: fallback, fill: 'rgba(235, 103, 132, 0.08)' };
    }
};

type StatusKind = 'OK' | 'NOTE' | 'WARN' | 'SKIP';

const deriveStatus = (band: BandResult): StatusKind => {
    if (!band.product) return 'SKIP';
    if (band.warnings.some((w) => w.startsWith('reconcile MISMATCH'))) return 'WARN';
    if (band.warnings.length > 0) return 'NOTE';
    return 'OK';
};

export default function ReceiptDetailScreen() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    // Default-expanded: the full-receipt overlay is the primary
    // debugging surface while iterating on band geometry. Step 2
    // (per-product extraction) collapses to the product list once
    // bands are stable.
    const [overviewExpanded, setOverviewExpanded] = useState(true);

    const { chain, sourcePdf } = useLocalSearchParams<{
        chain: string;
        sourcePdf: string;
    }>();
    const snap: ReceiptSnapshot | null = useMemo(() => {
        if (!chain || !sourcePdf) return null;
        return getReceiptSnapshot(makeSnapshotKey(chain, sourcePdf));
    }, [chain, sourcePdf]);

    // Two separate band lists serve different surfaces:
    //   - `overlayBands`: every typed band (store-name, address,
    //     products, receipt-no, datetime, total) for the colour-
    //     coded full-receipt overlay. On Maxima this just shows
    //     product bands since Maxima's parser only emits products.
    //   - `productCropBands`: ONLY product bands, in the same
    //     order as `snap.bands`. The per-product list iterates
    //     `snap.bands` by index and looks up the matching bucketed
    //     coords here. Without this split, Rimi product 1's crop
    //     would land on store-name's y-range (taggedBands index 0).
    const overlayBands = useMemo<BandLike[]>(() => {
        if (!snap) return [];
        if (snap.taggedBands && snap.taggedBands.length > 0) return snap.taggedBands;
        return snap.bands.map((b) => b.band);
    }, [snap]);
    // Regions in the EXACT shape the Analyze screen hands ReceiptPhotoView /
    // BandCropImage. New snapshots carry them verbatim from the final parse;
    // a legacy fallback derives flat product regions from the band list.
    const effRegions = useMemo(() => {
        if (!snap) return null;
        if (snap.regions) return snap.regions;
        const p0 = snap.pages[0];
        const flat = (b: { yTop: number; yBottom: number }): SnapshotRegion => ({
            yTop: b.yTop,
            yBottom: b.yBottom,
            xLeft: p0?.receiptXLeft ?? 0,
            xRight: p0?.receiptXRight ?? (p0?.pixelWidth ?? 0),
            kind: 'product',
        });
        return {
            header: [] as SnapshotRegion[],
            products: snap.bands.map((b) => flat(b.band)) as (SnapshotRegion | null)[],
            footer: [] as SnapshotRegion[],
            skipped: [] as SnapshotRegion[],
        };
    }, [snap]);
    // Per-page buckets for the shared photo view — multi-page receipts render
    // one ReceiptPhotoView per page, regions shifted into page-local y space.
    const regionsByPage = useMemo(() => {
        if (!snap || !effRegions) return null;
        const products = effRegions.products.filter(Boolean) as SnapshotRegion[];
        return {
            header: bucketRegionsByPage(effRegions.header, snap.pages),
            products: bucketRegionsByPage(products, snap.pages),
            footer: bucketRegionsByPage(effRegions.footer, snap.pages),
            skipped: bucketRegionsByPage(effRegions.skipped, snap.pages),
            masks: bucketRegionsByPage((snap.maskBands ?? []) as unknown as SnapshotRegion[], snap.pages),
        };
    }, [snap, effRegions]);

    // ── ITEM TRUTH (v2): fetch the receipt's approval file, compare the
    // FINAL parsed products (snapshot.products) against it, and let each
    // product row checkmark/overwrite/remove its assertion. Writes go
    // through the dev API into shared/receipts/<chain>/ (git-versioned).
    const [truth, setTruth] = useState<ItemTruthFile | null>(null);
    useEffect(() => {
        if (!snap) return;
        let cancelled = false;
        (async () => {
            try {
                const base = snap.sourcePdf.replace(/\.(pdf|png|jpg|jpeg)$/i, '');
                // PER-PLATFORM truth: Android reads (and saves to) its own
                // .truth.android.json — bootstrapped as a copy of the iOS
                // truth — so each OCR/parser combo is scored against a truth
                // in ITS OWN OCR flavor and only genuine diffs need review.
                // Falls back to the base (iOS) truth when no copy exists yet.
                const names = Platform.OS === 'android'
                    ? [`${base}.truth.android.json`, `${base}.truth.json`]
                    : [`${base}.truth.json`];
                for (const n of names) {
                    const res = await fetch(`${API_BASE_URL}/receipts-truth/${snap.chain}/${n}`);
                    if (!res.ok) continue;
                    const j = await res.json();
                    if (!cancelled && isItemTruthFile(j)) setTruth(j);
                    break;
                }
            } catch { /* no truth yet */ }
        })();
        return () => { cancelled = true; };
    }, [snap]);

    const truthCmp = useMemo(
        () => (snap?.products ? compareItemTruth(truth, snap.products, snap.footer ?? null) : null),
        [truth, snap],
    );
    // Band rows display extract-level products; assertions target the FINAL
    // parse (snapshot.products). Map band index → final-product index by
    // counting non-skip bands.
    const bandToProductIdx = useMemo(() => {
        let n = 0;
        return (snap?.bands ?? []).map((b) => (b.product ? n++ : -1));
    }, [snap]);

    const saveTruth = async (next: ItemTruthFile | null) => {
        setTruth(next);
        try {
            await fetch(`${API_BASE_URL}/receipts-truth-set`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chain: snap?.chain, file: snap?.sourcePdf, truth: next, platform: Platform.OS }),
            });
        } catch (e) {
            console.warn('[truth] save failed:', e);
        }
    };
    const editableTruth = (): ItemTruthFile => (
        truth
            ? { ...truth, products: [...truth.products] }
            : { version: 2, source: snap?.sourcePdf ?? '', products: [], footer: null }
    );
    const checkProduct = (productIdx: number) => {
        if (!snap?.products || !truthCmp) return;
        const t = editableTruth();
        const item = truthFromParsed(snap.products[productIdx], new Date().toISOString());
        const existing = truthCmp.perProduct[productIdx]?.truthIdx;
        if (existing != null) t.products[existing] = item;
        else t.products.push(item);
        void saveTruth(t);
    };
    const uncheckProduct = (productIdx: number) => {
        if (!truthCmp) return;
        const existing = truthCmp.perProduct[productIdx]?.truthIdx;
        if (existing == null) return;
        const t = editableTruth();
        t.products.splice(existing, 1);
        void saveTruth(t.products.length || t.footer ? t : null);
    };
    const checkFooter = () => {
        if (!snap?.footer) return;
        const t = editableTruth();
        t.footer = footerFromParsed(snap.footer, new Date().toISOString());
        void saveTruth(t);
    };
    const uncheckFooter = () => {
        const t = editableTruth();
        t.footer = null;
        void saveTruth(t.products.length ? t : null);
    };

    // iOS ImageManipulator refuses HTTP URIs and aborts with the
    // cryptic `calling the 'renderAsync' function has failed`. Cache
    // each batch-staging page to local FS once, hand the file:// URI
    // down to ProductRow. While the download is in flight the row's
    // uri stays empty and the crop effect bails — that's fine, it
    // re-runs as soon as state populates.
    const [localPageUris, setLocalPageUris] = useState<Record<string, string>>({});
    useEffect(() => {
        if (!snap) return;
        let cancelled = false;
        (async () => {
            const cacheDir = FileSystem.cacheDirectory ?? '';
            for (const page of snap.pages) {
                const src = `${API_BASE_URL}/receipts-batch/${snap.chain}/${encodeURIComponent(page.name)}`;
                const dest = `${cacheDir}batch-${snap.chain}-${page.name}`;
                try {
                    devLog('receipt-detail.downloadStart', { src, dest });
                    const dl = await FileSystem.downloadAsync(src, dest);
                    devLog('receipt-detail.downloadResult', {
                        name: page.name,
                        uri: dl?.uri,
                        status: dl?.status,
                        size: dl?.headers?.['Content-Length'] ?? dl?.headers?.['content-length'],
                    });
                    if (cancelled) return;
                    if (dl?.status === 200 && dl?.uri) {
                        // Project the downloaded file into the OCR's pixel space
                        // (rotate-portrait + resize to the parsed dims) — the SAME
                        // normalization the Analyze screen runs on a saved receipt's
                        // photo (utils/receiptImage), so every region aligns 1:1
                        // with zero per-surface scale math.
                        const norm = await normalizeLoadedImage(dl.uri, page.pixelWidth, page.pixelHeight);
                        if (cancelled) return;
                        setLocalPageUris((prev) => ({ ...prev, [page.name]: norm.uri }));
                    }
                } catch (e: any) {
                    devLog('receipt-detail.downloadThrew', { name: page.name, err: e?.message ?? String(e) });
                }
            }
        })();
        return () => { cancelled = true; };
    }, [snap]);

    // receiptImage.PageMeta view over the snapshot pages + normalized local
    // files — the shared BandCropImage picks the page and crops in OCR space.
    const imagePages = useMemo<ImagePageMeta[]>(() => {
        if (!snap) return [];
        return snap.pages.map((p) => ({
            uri: localPageUris[p.name] ?? '',
            pixelWidth: p.pixelWidth,
            pixelHeight: p.pixelHeight,
            frameScale: p.frameScale ?? 1,
            yOffsetScaled: p.yOffsetInParserSpace,
            pageMaxYScaled: p.pageMaxY ?? p.pixelHeight,
            receiptXLeftScaled: p.receiptXLeft ?? 0,
            receiptXRightScaled: p.receiptXRight ?? p.pixelWidth,
        }));
    }, [snap, localPageUris]);

    if (!snap || !effRegions || !regionsByPage) {
        return (
            <View style={styles.centered}>
                <Stack.Screen options={{ title: 'Detalė' }} />
                <Text style={styles.emptyText}>
                    Snapshot nerastas. Paleiskite paketinį testą iš naujo,
                    tada palieskite eilutę.
                </Text>
            </View>
        );
    }

    const productCount = snap.bands.filter((b) => b.product !== null).length;
    const skipCount = snap.bands.length - productCount;
    // Show the per-product list whenever there are bands with
    // extracted products. Both Maxima and Rimi run step 2 now, so
    // both populate `bands` with structured product info.
    const showProductsList = snap.bands.length > 0;
    const isTaggedReceipt = !!(snap.taggedBands && snap.taggedBands.length > 0);

    return (
        <ScrollView style={styles.container}>
            <Stack.Screen options={{ title: snap.sourcePdf }} />

            {/* Header */}
            <View style={styles.header}>
                <Text style={styles.headerTitle}>{snap.sourcePdf}</Text>
                <Text style={styles.headerMeta}>
                    {isTaggedReceipt
                        ? `${snap.taggedBands!.length} band${snap.taggedBands!.length === 1 ? 'a' : 'os'}`
                        : `${snap.bands.length} band${snap.bands.length === 1 ? 'a' : 'os'} · ${productCount} prek${productCount === 1 ? 'ė' : 'ės'}${skipCount > 0 ? ` · ${skipCount} praleist${skipCount === 1 ? 'a' : 'os'}` : ''}`}
                    {snap.pages.length > 1 ? ` · ${snap.pages.length} puslapiai` : ''}
                </Text>
            </View>

            {/* Collapsible: full receipt with band overlay */}
            <TouchableOpacity
                style={styles.overviewHeader}
                onPress={() => setOverviewExpanded((v) => !v)}
                activeOpacity={0.6}
            >
                <Ionicons
                    name={overviewExpanded ? 'chevron-down' : 'chevron-forward'}
                    size={16}
                    color={colors.textSecondary}
                />
                <Text style={styles.overviewHeaderText}>Visa kvito apžvalga</Text>
            </TouchableOpacity>
            {overviewExpanded && (
                <View>
                    {snap.pages.map((page, pageIdx) => {
                        const localUri = localPageUris[page.name] ?? null;
                        return (
                            <View key={page.name} style={styles.pageWrap}>
                                {snap.pages.length > 1 && (
                                    <Text style={styles.pageLabel}>
                                        Puslapis {pageIdx + 1}
                                    </Text>
                                )}
                                {/* THE Analyze Kvitas-tab component, fed the same
                                    region sets the live screen passes — bands (incl.
                                    skewed IKI parallelograms and the total/date/
                                    receipt-no footer bands) can never render
                                    differently between the two surfaces. */}
                                <ReceiptPhotoView
                                    imageUri={localUri}
                                    imageDims={{ width: page.pixelWidth, height: page.pixelHeight }}
                                    loading={!localUri}
                                    headerRegions={regionsByPage.header[pageIdx] ?? []}
                                    productRegions={regionsByPage.products[pageIdx] ?? []}
                                    footerRegions={regionsByPage.footer[pageIdx] ?? []}
                                    skippedRegions={regionsByPage.skipped[pageIdx] ?? []}
                                    maskRegions={regionsByPage.masks[pageIdx] ?? []}
                                    drawMasks
                                />
                            </View>
                        );
                    })}
                    {/* Footer (suma/data/nr/recon) truth card — directly under
                        the receipt photo so it's inspectable in one glance.
                        Whole card is tappable: tap = approve current values,
                        long-press = remove the assertion. */}
                    {snap.footer && truthCmp && (
                        <TouchableOpacity
                            style={styles.footerTruthCard}
                            onPress={truthCmp.footer !== 'match' ? checkFooter : undefined}
                            onLongPress={truthCmp.footer !== 'none' ? uncheckFooter : undefined}
                            delayLongPress={450}
                            activeOpacity={0.7}
                        >
                            <View style={styles.truthCheck}>
                                {truthCmp.footer === 'differ' && (
                                    <Ionicons name="warning" size={16} color={colors.error} />
                                )}
                                <Ionicons
                                    name={truthCmp.footer === 'none' ? 'ellipse-outline' : 'checkmark-circle'}
                                    size={22}
                                    color={truthCmp.footer === 'match' ? colors.success : truthCmp.footer === 'differ' ? colors.error : colors.textMuted}
                                />
                            </View>
                            <View style={{ flex: 1 }}>
                                <Text style={styles.productName}>
                                    Suma €{snap.footer.total ?? '—'} · {snap.footer.date ?? '—'} · nr {snap.footer.receiptNo ?? '—'} · recon {snap.footer.reconciled === true ? '✓' : snap.footer.reconciled === false ? `✗ (Δ${snap.footer.reconDelta ?? '?'})` : '—'}
                                </Text>
                                {truthCmp.footer === 'differ' && truthCmp.footerDiffs.map((d, i) => (
                                    <Text key={i} style={styles.truthDiffText}>{d}</Text>
                                ))}
                            </View>
                        </TouchableOpacity>
                    )}
                    <View style={styles.bandsSection}>
                        <Text style={styles.sectionTitle}>V2 bandų y koordinatės</Text>
                        {isTaggedReceipt
                            ? snap.taggedBands!.map((b, idx) => (
                                  <View key={idx} style={styles.bandRow}>
                                      <View
                                          style={[
                                              styles.bandIdxBadge,
                                              { backgroundColor: bandKindColor(b.kind, colors.primary).border },
                                          ]}
                                      >
                                          <Text style={styles.bandIdxText}>{b.label}</Text>
                                      </View>
                                      <Text style={styles.bandText}>
                                          {b.kind}
                                          <Text style={styles.bandTextDim}>
                                              {'  '}y {Math.round(b.yTop)}–{Math.round(b.yBottom)} (Δ {Math.round(b.yBottom - b.yTop)} px)
                                          </Text>
                                      </Text>
                                  </View>
                              ))
                            : snap.bands.map((b, idx) => (
                                  <View key={idx} style={styles.bandRow}>
                                      <View style={styles.bandIdxBadge}>
                                          <Text style={styles.bandIdxText}>{idx + 1}</Text>
                                      </View>
                                      <Text style={styles.bandText}>
                                          y {Math.round(b.band.yTop)}–{Math.round(b.band.yBottom)}
                                          <Text style={styles.bandTextDim}>
                                              {' '}
                                              (Δ {Math.round(b.band.yBottom - b.band.yTop)} px)
                                          </Text>
                                      </Text>
                                  </View>
                              ))}
                    </View>
                    {/* Card / loyalty mask bands — the redaction preview
                        the real upload flow will burn into the image. */}
                    <View style={styles.bandsSection}>
                        <Text style={styles.sectionTitle}>
                            🛡 Maskuojamos juostos
                            {snap.maskBands?.length
                                ? ` (${snap.maskBands.length})`
                                : ''}
                        </Text>
                        {!snap.maskBands || snap.maskBands.length === 0 ? (
                            <Text style={styles.emptyText}>
                                Banko / lojalumo kortelės neaptiktos.
                            </Text>
                        ) : (
                            snap.maskBands.map((b, idx) => (
                                <View key={idx} style={styles.bandRow}>
                                    <View
                                        style={[
                                            styles.bandIdxBadge,
                                            { backgroundColor: maskKindColor(b.kind) },
                                        ]}
                                    >
                                        <Text style={styles.bandIdxText}>{b.label}</Text>
                                    </View>
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.bandText}>
                                            y {Math.round(b.yTop)}–{Math.round(b.yBottom)}
                                            <Text style={styles.bandTextDim}>
                                                {'  '}via {b.reasons.join(', ')}
                                            </Text>
                                        </Text>
                                        <Text style={styles.bandTextDim} numberOfLines={2}>
                                            “{b.text}”
                                        </Text>
                                    </View>
                                </View>
                            ))
                        )}
                    </View>
                </View>
            )}

            {/* Product list — disabled while we're tuning band
                geometry for a non-Maxima chain. Maxima still shows
                its products section since step 2 ships products. */}
            {showProductsList && (
                <View style={styles.productsSection}>
                    <Text style={styles.sectionTitle}>Produktai</Text>
                    {truthCmp && truthCmp.missing.length > 0 && (
                        <View style={styles.truthMissingBox}>
                            {truthCmp.missing.map((m, i) => (
                                <Text key={i} style={styles.truthMissingText}>
                                    ⚠ dingo iš parse: {m.name} — €{m.price.toFixed(2)} × {m.quantity} {m.unit}
                                </Text>
                            ))}
                        </View>
                    )}
                    {snap.bands.length === 0 && (
                        <Text style={styles.emptyText}>V2 nerado bandų.</Text>
                    )}
                    {snap.bands.map((bandResult, idx) => {
                        const productIdx = bandToProductIdx[idx];
                        const cmp = productIdx >= 0 ? truthCmp?.perProduct[productIdx] ?? null : null;
                        const finalProduct = productIdx >= 0 ? snap.products?.[productIdx] ?? null : null;
                        // Crop region: the FINAL parsed product's own band — the
                        // one the Analyze Prekės tab crops. Skip bands (and legacy
                        // snapshots) fall back to a flat extract-band region at the
                        // page's content x-bounds.
                        const bandPage = snap.pages[pageIdxFor(bandResult.band.yTop, snap.pages)];
                        const region: SnapshotRegion =
                            (productIdx >= 0 ? effRegions.products[productIdx] ?? null : null)
                            ?? {
                                yTop: bandResult.band.yTop,
                                yBottom: bandResult.band.yBottom,
                                xLeft: bandPage?.receiptXLeft ?? 0,
                                xRight: bandPage?.receiptXRight ?? (bandPage?.pixelWidth ?? 0),
                            };
                        return (
                            <ProductRow
                                key={idx}
                                bandIdx={idx}
                                bandResult={bandResult}
                                finalProduct={finalProduct}
                                pages={imagePages}
                                region={region}
                                colors={colors}
                                styles={styles}
                                truthCmp={cmp}
                                onTruthCheck={productIdx >= 0 ? () => checkProduct(productIdx) : undefined}
                                onTruthRemove={productIdx >= 0 ? () => uncheckProduct(productIdx) : undefined}
                            />
                        );
                    })}
                </View>
            )}
        </ScrollView>
    );
}

/**
 * One product row: cropped band image on top, structured fields below.
 * The crop IS the Analyze Prekės-tab component (BandCropImage) fed the same
 * page metas + parsed region — batch crops can never diverge from the app's.
 */
const ProductRow = ({
    bandIdx,
    bandResult,
    finalProduct,
    pages,
    region,
    colors,
    styles,
    truthCmp,
    onTruthCheck,
    onTruthRemove,
}: {
    bandIdx: number;
    bandResult: BandResult;
    pages: ImagePageMeta[];
    region: SnapshotRegion;
    colors: AppTheme;
    styles: ReturnType<typeof makeStyles>;
    finalProduct?: NonNullable<ReceiptSnapshot['products']>[number] | null;
    truthCmp?: ProductTruthComparison | null;
    onTruthCheck?: () => void;
    onTruthRemove?: () => void;
}) => {
    const status = deriveStatus(bandResult);
    const product = bandResult.product;
    // DISPLAY the FINAL parsed product when available — the band's own
    // extract-level product predates parse-level heals (Galut salvage, ppu
    // normalization, grafts), and showing it made rimi-30-04-2026-2's Cukrus
    // look discount-less while the shipped parse (and the truth assertions)
    // had akcija 0.65. Final products are per-unit normalized: totals are
    // price×qty. Falls back to the extract product on old snapshots.
    const fp = finalProduct ?? null;
    const round2 = (v: number) => Math.round(v * 100) / 100;
    // BandCropImage picks its page by yOffset — hold rendering until that
    // page's local file has downloaded + normalized (an empty uri would
    // fail the crop instead of retrying).
    const cropPage = pages[pages.length ? Math.max(0, pages.findIndex((p, i) =>
        region.yTop >= p.yOffsetScaled
        && (i === pages.length - 1 || region.yTop < pages[i + 1].yOffsetScaled))) : 0];
    const pageReady = !!cropPage?.uri;

    return (
        <View style={styles.productRow}>
            <View style={[styles.cropContainer, { borderColor: statusColor(status, colors) }]}>
                {pageReady && (
                    <BandCropImage
                        pages={pages}
                        region={region}
                        cardWidth={DETAIL_CARD_WIDTH}
                    />
                )}
            </View>
            <View style={styles.productMeta}>
                <View style={styles.productMetaHeader}>
                    <StatusIcon status={status} colors={colors} />
                    <Text style={styles.productBandLabel}>
                        #{bandIdx + 1}
                    </Text>
                    {product ? (
                        // Full name, no clamp — truth review needs to see
                        // every character; a "…" can hide the exact garble
                        // being judged.
                        <Text style={styles.productName}>
                            {fp?.name ?? product.name}
                        </Text>
                    ) : (
                        <Text style={styles.productSkipName}>
                            {skipLabel(bandResult.warnings)}
                        </Text>
                    )}
                    {product && truthCmp && (
                        // Item-truth checkmark: tap = approve current values
                        // (creates/overwrites the assertion), long-press =
                        // remove the assertion. Red warning = truth differs.
                        <TouchableOpacity
                            style={styles.truthCheck}
                            onPress={truthCmp.state !== 'match' ? onTruthCheck : undefined}
                            onLongPress={truthCmp.state !== 'unchecked' ? onTruthRemove : undefined}
                            delayLongPress={450}
                        >
                            {truthCmp.state === 'differ' && (
                                <Ionicons name="warning" size={16} color={colors.error} />
                            )}
                            {/* near = same product, cross-OCR-engine name flavor:
                                amber check — SKIPPABLE, but tap re-asserts with
                                this engine's read if you prefer it. */}
                            <Ionicons
                                name={truthCmp.state === 'unchecked' ? 'ellipse-outline' : 'checkmark-circle'}
                                size={22}
                                color={
                                    truthCmp.state === 'match' ? colors.success
                                    : truthCmp.state === 'near' ? colors.warning
                                    : truthCmp.state === 'differ' ? colors.error
                                    : colors.textMuted
                                }
                            />
                        </TouchableOpacity>
                    )}
                </View>
                {(truthCmp?.state === 'differ' || truthCmp?.state === 'near') && truthCmp.diffs.length > 0 && (
                    <View style={styles.truthDiffBox}>
                        {truthCmp.diffs.map((d, i) => (
                            <Text key={i} style={styles.truthDiffText}>{d}</Text>
                        ))}
                    </View>
                )}
                {product && (
                    <View style={styles.productFields}>
                        {/*
                          Parser-extracted pack size from the name. Final-parse
                          values when the snapshot carries them (post-heals);
                          extract-level fallback otherwise.
                        */}
                        <Text style={styles.productPackSize}>
                            {fp
                                ? (fp.parsedAmount != null && fp.parsedUnit ? `${fp.parsedAmount} ${fp.parsedUnit}` : '—')
                                : ((product as any).parsedAmount != null && (product as any).parsedUnit
                                    ? `${(product as any).parsedAmount} ${(product as any).parsedUnit}`
                                    : '—')}
                        </Text>
                        {fp ? (
                            // FINAL product: price is per-unit normalized —
                            // line total = price × qty.
                            <Text style={styles.productPriceLine}>
                                <Text style={styles.productPpu}>
                                    €{fp.price.toFixed(2)}
                                    {fp.quantity !== 1 || fp.unit === 'kg' ? `/${fp.unit}` : ''}
                                </Text>
                                <Text style={styles.productSecondary}>
                                    {' × '}
                                    {formatQty(fp.quantity)} {fp.unit}
                                    {' = '}
                                </Text>
                                <Text style={styles.productTotal}>
                                    €{round2(fp.price * fp.quantity).toFixed(2)}
                                </Text>
                            </Text>
                        ) : (
                            <Text style={styles.productPriceLine}>
                                <Text style={styles.productPpu}>
                                    €{(product.pricePerUnit ?? product.price).toFixed(2)}
                                    {product.pricePerUnit !== null ? `/${product.unit}` : ''}
                                </Text>
                                <Text style={styles.productSecondary}>
                                    {' × '}
                                    {formatQty(product.quantity)} {product.unit}
                                    {' = '}
                                </Text>
                                <Text style={styles.productTotal}>
                                    €{product.price.toFixed(2)}
                                </Text>
                            </Text>
                        )}
                        {fp ? (fp.promoPrice != null && (
                            <Text style={styles.productPromoLine}>
                                <Text style={styles.productPromoLabel}>akcija </Text>
                                <Text style={styles.productPpu}>
                                    €{fp.promoPrice.toFixed(2)}
                                    {fp.quantity !== 1 || fp.unit === 'kg' ? `/${fp.unit}` : ''}
                                </Text>
                                <Text style={styles.productSecondary}>
                                    {' × '}
                                    {formatQty(fp.quantity)} {fp.unit}
                                    {' = '}
                                </Text>
                                <Text style={styles.productTotal}>
                                    €{round2(fp.promoPrice * fp.quantity).toFixed(2)}
                                </Text>
                            </Text>
                        )) : (product.promoPrice !== null && (
                            <Text style={styles.productPromoLine}>
                                <Text style={styles.productPromoLabel}>akcija </Text>
                                <Text style={styles.productPpu}>
                                    €{(product.promoPrice / product.quantity).toFixed(2)}
                                    {product.pricePerUnit !== null ? `/${product.unit}` : ''}
                                </Text>
                                <Text style={styles.productSecondary}>
                                    {' × '}
                                    {formatQty(product.quantity)} {product.unit}
                                    {' = '}
                                </Text>
                                <Text style={styles.productTotal}>
                                    €{product.promoPrice.toFixed(2)}
                                </Text>
                            </Text>
                        ))}
                    </View>
                )}
                {bandResult.warnings.length > 0 && (
                    <View style={styles.warnings}>
                        {bandResult.warnings.map((w, i) => (
                            <Text key={i} style={styles.warningText}>
                                {w}
                            </Text>
                        ))}
                    </View>
                )}
            </View>
        </View>
    );
};

const formatQty = (q: number): string => {
    // Weighable receipts give 0.304 etc.; integer multi-pack stays as N.
    if (Number.isInteger(q)) return String(q);
    return q.toFixed(3).replace(/\.?0+$/, '');
};

const statusColor = (s: StatusKind, c: AppTheme): string => {
    if (s === 'OK') return c.success;
    if (s === 'NOTE') return c.textSecondary;
    if (s === 'WARN') return c.error;
    return c.textMuted; // SKIP
};

/**
 * Map a parser `skip:*` warning to a human-readable label for the
 * "no product extracted" row. Defaults to the raw warning text so
 * any new skip code shows up verbatim during dev before we localise.
 */
const SKIP_LABELS: Record<string, string> = {
    'skip:ocr-price-dropped': 'Neatpažinta kaina',
    'skip:taisymas-refund': 'Taisymo grąžinimas',
    'skip:non-catalog': 'Nekatalogo įrašas',
    'skip:deposit-only': 'Tik užstatas',
};
function skipLabel(warnings: string[]): string {
    const w = warnings.find((x) => x.startsWith('skip:'));
    if (!w) return 'praleista';
    const code = w.split(/[\s"]/, 1)[0]; // strip any trailing text after the code
    return SKIP_LABELS[code] ?? w;
}

const StatusIcon = ({ status, colors }: { status: StatusKind; colors: AppTheme }) => {
    const color = statusColor(status, colors);
    if (status === 'OK')
        return <Ionicons name="checkmark-circle" size={18} color={color} />;
    if (status === 'NOTE')
        return <Ionicons name="information-circle" size={18} color={color} />;
    if (status === 'WARN')
        return <Ionicons name="warning" size={18} color={color} />;
    return <Ionicons name="close-circle-outline" size={18} color={color} />;
};

const makeStyles = (c: AppTheme) =>
    StyleSheet.create({
        container: { flex: 1, backgroundColor: c.pageBackground },
        centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
        header: {
            padding: 14,
            backgroundColor: c.cardBackground,
            borderBottomWidth: 1,
            borderBottomColor: c.borderSubtle,
        },
        headerTitle: { fontSize: 14, fontWeight: '600', color: c.textPrimary },
        headerMeta: { fontSize: 11, color: c.textSecondary, marginTop: 2 },

        overviewHeader: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            paddingVertical: 12,
            paddingHorizontal: 14,
            backgroundColor: c.cardBackground,
            borderBottomWidth: 1,
            borderBottomColor: c.borderSubtle,
        },
        overviewHeaderText: { fontSize: 13, color: c.textPrimary, fontWeight: '500' },

        pageWrap: {
            paddingHorizontal: 12,
            paddingTop: 12,
            backgroundColor: c.cardBackground,
        },
        pageLabel: { fontSize: 11, color: c.textSecondary, marginBottom: 4 },

        bandsSection: {
            padding: 12,
        },
        sectionTitle: {
            fontSize: 13,
            fontWeight: '600',
            color: c.textPrimary,
            marginBottom: 8,
        },
        emptyText: { fontSize: 13, color: c.textMuted, textAlign: 'center' },

        bandRow: {
            flexDirection: 'row',
            gap: 10,
            alignItems: 'center',
            paddingVertical: 8,
            paddingHorizontal: 12,
            backgroundColor: c.cardBackground,
            borderRadius: 8,
            marginBottom: 4,
        },
        bandIdxBadge: {
            width: 22,
            height: 22,
            borderRadius: 11,
            backgroundColor: c.primary,
            alignItems: 'center',
            justifyContent: 'center',
        },
        bandIdxText: { color: c.onPrimary, fontSize: 11, fontWeight: '700' },
        bandText: { fontSize: 12, color: c.textPrimary, fontFamily: 'monospace' },
        bandTextDim: { color: c.textMuted },

        productsSection: { padding: 12 },
        productRow: {
            backgroundColor: c.cardBackground,
            borderRadius: 8,
            marginBottom: 10,
            overflow: 'hidden',
        },
        cropContainer: {
            width: '100%',
            overflow: 'hidden',
            backgroundColor: c.pageBackground,
            borderTopWidth: 2,
        },
        cropErrorText: {
            position: 'absolute',
            top: 4,
            left: 4,
            fontSize: 10,
            color: c.error,
            backgroundColor: 'rgba(255, 255, 255, 0.7)',
            paddingHorizontal: 4,
        },
        productMeta: { padding: 10 },
        productMetaHeader: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
        },
        productBandLabel: {
            fontSize: 11,
            color: c.textMuted,
            fontFamily: 'monospace',
            minWidth: 28,
        },
        productName: {
            flex: 1,
            fontSize: 14,
            fontWeight: '600',
            color: c.textPrimary,
        },
        productSkipName: {
            flex: 1,
            fontSize: 13,
            fontStyle: 'italic',
            color: c.textMuted,
        },
        productFields: { marginTop: 6 },
        productPackSize: {
            fontSize: 12,
            fontWeight: '600',
            color: c.textSecondary,
            fontFamily: 'monospace',
            marginBottom: 4,
        },
        productPriceLine: { fontSize: 13, color: c.textPrimary },
        productPromoLine: { fontSize: 13, color: c.textPrimary, marginTop: 2 },
        productPromoLabel: { color: c.error, fontWeight: '700' },
        productPpu: { fontWeight: '600' },
        productTotal: { fontWeight: '700' },
        productSecondary: { color: c.textSecondary, fontWeight: '400' },

        warnings: {
            marginTop: 6,
            paddingTop: 6,
            borderTopWidth: 1,
            borderTopColor: c.borderSubtle,
        },
        warningText: {
            fontSize: 11,
            color: c.textSecondary,
            fontFamily: 'monospace',
            marginBottom: 2,
        },
        truthCheck: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 2,
            paddingLeft: 8,
            paddingVertical: 2,
        },
        truthDiffBox: {
            marginTop: 4,
            padding: 6,
            borderRadius: 6,
            backgroundColor: c.error + '18',
        },
        truthDiffText: {
            fontSize: 11,
            color: c.error,
            fontFamily: 'monospace',
            marginBottom: 1,
        },
        truthMissingBox: {
            marginBottom: 8,
            padding: 8,
            borderRadius: 8,
            backgroundColor: c.error + '22',
        },
        truthMissingText: {
            fontSize: 12,
            color: c.error,
            marginBottom: 2,
        },
        footerTruthCard: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            marginTop: 10,
            padding: 10,
            borderRadius: 8,
            backgroundColor: c.surfaceMuted,
        },
    });
