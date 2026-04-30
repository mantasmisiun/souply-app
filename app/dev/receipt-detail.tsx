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
 * Cropping: each band's image is the same page PNG masked by an
 * overflow:hidden container. Container sets aspectRatio so its
 * height matches the band's natural display ratio; once onLayout
 * resolves the actual rendered container width, the inner Image
 * is sized in pixels (`pageHeight × scale` tall) and positioned
 * with a negative pixel `top` so the band's yTop lands at
 * container y=0. Pixel-driven positioning sidesteps the RN quirk
 * where percentage `top` + aspectRatio on absolutely-positioned
 * children drifts by ~one OCR line height. No image
 * manipulation, no extra files.
 *
 * Multi-page receipts: each band knows which page it's on via
 * the page's yOffsetInParserSpace; the crop pulls from that
 * page's PNG.
 */

import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import {
    Image,
    type LayoutChangeEvent,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { API_BASE_URL } from '../../config/api';
import { useTheme, type AppTheme } from '../../constants/theme';
import {
    getReceiptSnapshot,
    makeSnapshotKey,
    type BandResult,
    type PageMeta,
    type ReceiptSnapshot,
} from '../../utils/parserTestSnapshot';
import type { ProductBand } from '../../../shared/parsers/maximaParser';

interface BandOnPage {
    bandIdx: number;
    /** yTop relative to THIS page's pixel space (yOffset already removed). */
    yTopOnPage: number;
    /** yBottom relative to THIS page's pixel space. */
    yBottomOnPage: number;
    /** Index of the page this band falls on (into snap.pages). */
    pageIdx: number;
}

/**
 * Bucket each V2 band onto the page whose y-offset range contains
 * its yTop. Returns parallel arrays: per-page band lists (for the
 * full-receipt overlay) and a flat list keyed by bandIdx (for the
 * per-product crops, where order must match `snap.bands`).
 */
const bucketBandsByPage = (
    bands: ProductBand[],
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
        const onPage: BandOnPage = {
            bandIdx: bi,
            yTopOnPage: band.yTop - offset,
            yBottomOnPage: band.yBottom - offset,
            pageIdx,
        };
        perPage[pageIdx].push(onPage);
        perBand.push(onPage);
    }
    return { perPage, perBand };
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
    const [overviewExpanded, setOverviewExpanded] = useState(false);

    const { chain, sourcePdf } = useLocalSearchParams<{
        chain: string;
        sourcePdf: string;
    }>();
    const snap: ReceiptSnapshot | null = useMemo(() => {
        if (!chain || !sourcePdf) return null;
        return getReceiptSnapshot(makeSnapshotKey(chain, sourcePdf));
    }, [chain, sourcePdf]);

    const allBands = useMemo<ProductBand[]>(
        () => (snap ? snap.bands.map((b) => b.band) : []),
        [snap],
    );
    const buckets = useMemo(
        () => (snap ? bucketBandsByPage(allBands, snap.pages) : null),
        [snap, allBands],
    );

    if (!snap || !buckets) {
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

    return (
        <ScrollView style={styles.container}>
            <Stack.Screen options={{ title: snap.sourcePdf }} />

            {/* Header */}
            <View style={styles.header}>
                <Text style={styles.headerTitle}>{snap.sourcePdf}</Text>
                <Text style={styles.headerMeta}>
                    {snap.bands.length} band
                    {snap.bands.length === 1 ? 'a' : 'os'} ·{' '}
                    {productCount} prek{productCount === 1 ? 'ė' : 'ės'}
                    {skipCount > 0 ? ` · ${skipCount} praleist${skipCount === 1 ? 'a' : 'os'}` : ''}
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
                                    bands={buckets.perPage[pageIdx]}
                                    colors={colors}
                                />
                            </View>
                        );
                    })}
                    <View style={styles.bandsSection}>
                        <Text style={styles.sectionTitle}>V2 bandų y koordinatės</Text>
                        {snap.bands.map((b, idx) => (
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

            {/* Product list */}
            <View style={styles.productsSection}>
                <Text style={styles.sectionTitle}>Produktai</Text>
                {snap.bands.length === 0 && (
                    <Text style={styles.emptyText}>V2 nerado bandų.</Text>
                )}
                {snap.bands.map((bandResult, idx) => {
                    const onPage = buckets.perBand[idx];
                    const page = snap.pages[onPage.pageIdx];
                    const url = `${API_BASE_URL}/receipts-batch/${snap.chain}/${encodeURIComponent(page.name)}`;
                    return (
                        <ProductRow
                            key={idx}
                            bandIdx={idx}
                            bandResult={bandResult}
                            uri={url}
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
    const [containerWidth, setContainerWidth] = useState<number | null>(null);
    const onLayout = (e: LayoutChangeEvent) => {
        const w = e.nativeEvent.layout.width;
        if (w > 0 && w !== containerWidth) setContainerWidth(w);
    };
    const scale = containerWidth !== null ? containerWidth / pageWidth : 0;

    return (
        <View style={styles.productRow}>
            <View
                onLayout={onLayout}
                style={[
                    styles.cropContainer,
                    { aspectRatio: cropAspect, borderColor: statusColor(status, colors) },
                ]}
            >
                {containerWidth !== null && (
                    <Image
                        source={{ uri }}
                        style={{
                            position: 'absolute',
                            left: 0,
                            width: containerWidth,
                            height: pageHeight * scale,
                            top: -yTopOnPage * scale,
                        }}
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
                        <Text style={styles.productName} numberOfLines={2}>
                            {product.name}
                        </Text>
                    ) : (
                        <Text style={styles.productSkipName} numberOfLines={2}>
                            {bandResult.warnings.find((w) => w.startsWith('skip:')) ?? 'praleista'}
                        </Text>
                    )}
                </View>
                {product && (
                    <View style={styles.productFields}>
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
                            borderColor: colors.primary,
                            backgroundColor: 'rgba(235, 103, 132, 0.08)',
                        }}
                    >
                        <View
                            style={{
                                position: 'absolute',
                                left: 2,
                                top: 2,
                                paddingHorizontal: 4,
                                paddingVertical: 1,
                                backgroundColor: colors.primary,
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
                                {b.bandIdx + 1}
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
