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
 * Cropping: each band region is pre-cropped via expo-image-
 * manipulator into its own small PNG (1080 × bandHeight px).
 * Earlier the crop was done at render time by overflow:hidden +
 * a negative-`top` Image inside an aspectRatio-constrained
 * container — but RN on Android downsamples large images during
 * decode based on the visible rectangle, so feeding the whole
 * page PNG to a band-shaped container threw away most of the
 * source pixels and produced barely-readable crops on phone-
 * photographed receipts (Lidl). The pre-crop file is small
 * enough to dodge the downsample heuristic, so the band's
 * source pixels render at native resolution.
 *
 * Multi-page receipts: each band knows which page it's on via
 * the page's yOffsetInParserSpace; the crop pulls from that
 * page's PNG.
 */

import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
    Image,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { API_BASE_URL } from '../../config/api';
import { devLog } from '../../utils/devLog';
import { useTheme, type AppTheme } from '../../constants/theme';
import {
    getReceiptSnapshot,
    makeSnapshotKey,
    type BandResult,
    type PageMeta,
    type ReceiptSnapshot,
} from '../../utils/parserTestSnapshot';
import type { ProductBand } from '@shared/parsers/maximaParser';
import type { RimiBandKind, RimiReceiptBand } from '@shared/parsers/rimiParser';
import type { NorfaReceiptBand } from '@shared/parsers/norfaParser';
import type { LidlReceiptBand } from '@shared/parsers/lidlParser';

// Kinds emitted by any chain's V2 parser. Rimi/Norfa/Lidl share
// structurally-identical band-kind unions; the overlay colour map
// is shared too.
type TaggedBandKind =
    | RimiBandKind
    | NorfaReceiptBand['kind']
    | LidlReceiptBand['kind'];

interface BandOnPage {
    bandIdx: number;
    /** yTop relative to THIS page's pixel space (yOffset already removed). */
    yTopOnPage: number;
    /** yBottom relative to THIS page's pixel space. */
    yBottomOnPage: number;
    /** Index of the page this band falls on (into snap.pages). */
    pageIdx: number;
    /**
     * Optional band kind (Rimi/Norfa V2 — Maxima bands are all
     * `product`). Drives the overlay rectangle's colour so the
     * user can verify each region kind landed on the right slice
     * of the receipt.
     */
    kind?: TaggedBandKind;
    /** Short label rendered inside the rectangle (band #, `addr`, …). */
    label?: string;
}

/**
 * Bucket each band onto the page whose y-offset range contains
 * its yTop. Returns parallel arrays: per-page band lists (for the
 * full-receipt overlay) and a flat list keyed by bandIdx (for the
 * per-product crops, where order must match `snap.bands`).
 *
 * Accepts either Maxima-style ProductBand[] (no kind / label) or
 * Rimi/Norfa-style typed bands (kind + label). The kind / label,
 * when present, flows through to the overlay so each rectangle
 * gets a colour and inline tag.
 */
type BandLike = ProductBand | RimiReceiptBand | NorfaReceiptBand | LidlReceiptBand;

const bucketBandsByPage = (
    bands: BandLike[],
    pages: PageMeta[],
): { perPage: BandOnPage[][]; perBand: BandOnPage[] } => {
    const perPage: BandOnPage[][] = pages.map(() => []);
    const perBand: BandOnPage[] = [];
    for (let bi = 0; bi < bands.length; bi++) {
        const band = bands[bi];
        let pageIdx = 0;
        for (let i = pages.length - 1; i >= 0; i--) {
            if (band.yTop >= pages[i].yOffsetInParserSpace) {
                pageIdx = i;
                break;
            }
        }
        const offset = pages[pageIdx].yOffsetInParserSpace;
        const tagged = band as Partial<RimiReceiptBand & NorfaReceiptBand & LidlReceiptBand>;
        const onPage: BandOnPage = {
            bandIdx: bi,
            yTopOnPage: band.yTop - offset,
            yBottomOnPage: band.yBottom - offset,
            pageIdx,
            kind: tagged.kind,
            label: tagged.label ?? `${bi + 1}`,
        };
        perPage[pageIdx].push(onPage);
        perBand.push(onPage);
    }
    return { perPage, perBand };
};

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
    const productCropBands = useMemo<BandLike[]>(
        () => (snap ? snap.bands.map((b) => b.band) : []),
        [snap],
    );
    const overlayBuckets = useMemo(
        () => (snap ? bucketBandsByPage(overlayBands, snap.pages) : null),
        [snap, overlayBands],
    );
    const productBuckets = useMemo(
        () => (snap ? bucketBandsByPage(productCropBands, snap.pages) : null),
        [snap, productCropBands],
    );

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
                        setLocalPageUris((prev) => ({ ...prev, [page.name]: dl.uri }));
                    }
                } catch (e: any) {
                    devLog('receipt-detail.downloadThrew', { name: page.name, err: e?.message ?? String(e) });
                }
            }
        })();
        return () => { cancelled = true; };
    }, [snap]);

    if (!snap || !overlayBuckets || !productBuckets) {
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
                        const url = `${API_BASE_URL}/receipts-batch/${snap.chain}/${encodeURIComponent(page.name)}`;
                        return (
                            <View key={page.name} style={styles.pageWrap}>
                                {snap.pages.length > 1 && (
                                    <Text style={styles.pageLabel}>
                                        Puslapis {pageIdx + 1}
                                    </Text>
                                )}
                                <ImageWithBands
                                    uri={url}
                                    pageWidth={page.pixelWidth}
                                    pageHeight={page.pixelHeight}
                                    bands={overlayBuckets.perPage[pageIdx]}
                                    colors={colors}
                                />
                            </View>
                        );
                    })}
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
                </View>
            )}

            {/* Product list — disabled while we're tuning band
                geometry for a non-Maxima chain. Maxima still shows
                its products section since step 2 ships products. */}
            {showProductsList && (
                <View style={styles.productsSection}>
                    <Text style={styles.sectionTitle}>Produktai</Text>
                    {snap.bands.length === 0 && (
                        <Text style={styles.emptyText}>V2 nerado bandų.</Text>
                    )}
                    {snap.bands.map((bandResult, idx) => {
                        const onPage = productBuckets.perBand[idx];
                        const page = snap.pages[onPage.pageIdx];
                        // file:// URI once the page has cached locally;
                        // empty string before that — ProductRow's crop
                        // effect bails on empty and re-runs on update.
                        const localUri = localPageUris[page.name] ?? '';
                        return (
                            <ProductRow
                                key={idx}
                                bandIdx={idx}
                                bandResult={bandResult}
                                uri={localUri}
                                pageWidth={page.pixelWidth}
                                pageHeight={page.pixelHeight}
                                yTopOnPage={onPage.yTopOnPage}
                                yBottomOnPage={onPage.yBottomOnPage}
                                colors={colors}
                                styles={styles}
                            />
                        );
                    })}
                </View>
            )}
        </ScrollView>
    );
}

/**
 * One product row: cropped band image on top, structured fields
 * below. The crop is implemented with overflow:hidden + an
 * absolutely-positioned <Image> whose pixel dimensions and y
 * offset are computed once the container's actual rendered width
 * is known via onLayout. Pixel values avoid the percentage/
 * aspectRatio interaction quirks that were producing a one-line
 * vertical drift on RN with absolutely-positioned children.
 */
const ProductRow = ({
    bandIdx,
    bandResult,
    uri,
    pageWidth,
    pageHeight,
    yTopOnPage,
    yBottomOnPage,
    colors,
    styles,
}: {
    bandIdx: number;
    bandResult: BandResult;
    uri: string;
    pageWidth: number;
    pageHeight: number;
    yTopOnPage: number;
    yBottomOnPage: number;
    colors: AppTheme;
    styles: ReturnType<typeof makeStyles>;
}) => {
    const status = deriveStatus(bandResult);
    const product = bandResult.product;
    const bandHeight = Math.max(yBottomOnPage - yTopOnPage, 1);
    const cropAspect = pageWidth / bandHeight;

    // Pre-crop the band region to a separate image file via
    // expo-image-manipulator. Two reasons this is sharper than
    // the previous overflow:hidden + offset trick:
    //   1. RN on Android downsamples large images during decode
    //      based on the display rectangle. The previous path fed
    //      the WHOLE page (1080 × ~5000 px) to a band-shaped
    //      container (400 × ~10 px on phone), so the decoder
    //      threw away most of the source pixels before render.
    //      A small pre-cropped file (1080 × bandHeight) doesn't
    //      trip the downsample heuristic — RN decodes it fully.
    //   2. The negative-`top` positioning interacted oddly with
    //      RN's pixel rounding on certain DPRs, producing a
    //      ~1 line drift on long receipts. Pre-cropping makes
    //      the offset structurally zero.
    const [croppedUri, setCroppedUri] = useState<string | null>(null);
    const [cropError, setCropError] = useState<string | null>(null);
    useEffect(() => {
        // uri stays empty while the parent's per-page download is in
        // flight. Bail; the effect re-runs once it populates.
        if (!uri) return;
        let cancelled = false;
        const yTop = Math.max(0, Math.floor(yTopOnPage));
        const heightPx = Math.min(
            Math.ceil(yBottomOnPage - yTopOnPage),
            pageHeight - yTop,
        );
        if (heightPx <= 0) return;
        const cropArgs = { uri, originX: 0, originY: yTop, width: pageWidth, height: heightPx };
        devLog('receipt-detail.cropAttempt', { bandIdx, ...cropArgs });
        // JPEG output: PNG via expo-image-manipulator v14 on iOS
        // trips `calling the 'renderAsync' function has failed`
        // regardless of legacy vs new context API. JPEG output works
        // with the same source URIs in rotatePortrait and mlkitOcr's
        // tile crop, so the PNG encoder path is the broken one.
        ImageManipulator.manipulateAsync(
            uri,
            [{ crop: { originX: 0, originY: yTop, width: pageWidth, height: heightPx } }],
            { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG },
        )
            .then((res) => {
                devLog('receipt-detail.cropSuccess', { bandIdx, resultUri: res?.uri });
                if (!cancelled) setCroppedUri(res.uri);
            })
            .catch((e) => {
                const errMsg = e?.message ?? String(e);
                console.warn('[receipt-detail] band crop failed', { ...cropArgs, err: errMsg });
                devLog('receipt-detail.cropFailed', { bandIdx, ...cropArgs, err: errMsg });
                if (!cancelled) setCropError(errMsg);
            });
        return () => { cancelled = true; };
    }, [uri, yTopOnPage, yBottomOnPage, pageWidth, pageHeight, bandIdx]);

    return (
        <View style={styles.productRow}>
            <View
                style={[
                    styles.cropContainer,
                    { aspectRatio: cropAspect, borderColor: statusColor(status, colors) },
                ]}
            >
                {croppedUri && (
                    <Image
                        source={{ uri: croppedUri }}
                        style={{ width: '100%', height: '100%' }}
                        resizeMode="stretch"
                    />
                )}
                {cropError && (
                    <Text style={styles.cropErrorText} numberOfLines={5}>
                        crop failed: {cropError}
                    </Text>
                )}
            </View>
            <View style={styles.productMeta}>
                <View style={styles.productMetaHeader}>
                    <StatusIcon status={status} colors={colors} />
                    <Text style={styles.productBandLabel}>
                        #{bandIdx + 1}
                    </Text>
                    {product ? (
                        <Text style={styles.productName} numberOfLines={2}>
                            {product.name}
                        </Text>
                    ) : (
                        <Text style={styles.productSkipName} numberOfLines={2}>
                            {skipLabel(bandResult.warnings)}
                        </Text>
                    )}
                </View>
                {product && (
                    <View style={styles.productFields}>
                        {/*
                          Parser-extracted pack size from the name (e.g.
                          32 rit. for ZEWA, 990 ml for SOMAT, 250 g for
                          MILLER). Shown above the price line so the
                          discriminator the matcher uses is immediately
                          visible — easy to spot regressions where the
                          token didn't get caught. Renders "—" when
                          extractPackSize returned null (e.g. a bare
                          number with no unit suffix lost in OCR).
                        */}
                        <Text style={styles.productPackSize}>
                            {(product as any).parsedAmount != null && (product as any).parsedUnit
                                ? `${(product as any).parsedAmount} ${(product as any).parsedUnit}`
                                : '—'}
                        </Text>
                        {/*
                          Gross math: <ppu>{/unit} × <qty> <unit> = <price>.
                          For single-pack rows with no X-N line on the
                          receipt the parser leaves pricePerUnit=null;
                          we fall back to the line price as the per-pack
                          price and drop the "/unit" suffix so the line
                          reads naturally instead of "€0.49/vnt × 1 vnt".
                        */}
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
                        {product.promoPrice !== null && (
                            // Discount math sub-line: divide promoPrice by
                            // quantity to get the effective per-unit price
                            // after the per-item discount, then show the
                            // same shape as the gross line for easy compare.
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
                        )}
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

const ImageWithBands = ({
    uri,
    pageWidth,
    pageHeight,
    bands,
    colors,
}: {
    uri: string;
    pageWidth: number;
    pageHeight: number;
    bands: BandOnPage[];
    colors: AppTheme;
}) => {
    const aspect = pageWidth / pageHeight;
    return (
        <View style={{ width: '100%', aspectRatio: aspect, position: 'relative' }}>
            <Image
                source={{ uri }}
                style={{ width: '100%', height: '100%' }}
                resizeMode="contain"
            />
            {bands.map((b) => {
                const topPct = (b.yTopOnPage / pageHeight) * 100;
                const heightPct =
                    ((b.yBottomOnPage - b.yTopOnPage) / pageHeight) * 100;
                const { border, fill } = bandKindColor(b.kind, colors.primary);
                const labelText = b.label ?? `${b.bandIdx + 1}`;
                return (
                    <View
                        key={b.bandIdx}
                        pointerEvents="none"
                        style={{
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            top: `${topPct}%`,
                            height: `${heightPct}%`,
                            borderWidth: 1.5,
                            borderColor: border,
                            backgroundColor: fill,
                        }}
                    >
                        <View
                            style={{
                                position: 'absolute',
                                left: 2,
                                top: 2,
                                paddingHorizontal: 4,
                                paddingVertical: 1,
                                backgroundColor: border,
                                borderRadius: 3,
                            }}
                        >
                            <Text
                                style={{
                                    color: colors.onPrimary,
                                    fontSize: 9,
                                    fontWeight: '700',
                                }}
                            >
                                {labelText}
                            </Text>
                        </View>
                    </View>
                );
            })}
        </View>
    );
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
    });
