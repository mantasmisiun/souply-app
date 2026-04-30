/**
 * Dev-only: per-receipt detail view that visualises V2's STEP 1
 * output (band y-coordinates) on the rendered receipt PNG. Tapping a
 * row in the Kvitų paketinis testas screen lands here.
 *
 * What's shown:
 *   1. The receipt page image with V2's product bands overlaid as
 *      thin coloured rectangles. Lets the user eyeball whether each
 *      band correctly wraps "the lines for one product" (including
 *      that product's discounts and PET-deposit block, if any).
 *   2. A list of bands: index + (yTop, yBottom) in image-pixel space.
 *      No product fields yet — V2 step 2 (per-band content
 *      extraction) hasn't been built. Step 1's job is just to get the
 *      dividers right.
 *
 * Multi-page receipts: each page is rendered with its own band
 * overlay. Bands are bucketed to pages by yOffsetInParserSpace.
 */

import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import {
    Image,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import { API_BASE_URL } from '../../config/api';
import { useTheme, type AppTheme } from '../../constants/theme';
import {
    getReceiptSnapshot,
    makeSnapshotKey,
    type PageMeta,
    type ReceiptSnapshot,
} from '../../utils/parserTestSnapshot';
import type { ProductBand } from '../../../shared/parsers/maximaParserV2';

interface BandOnPage {
    bandIdx: number;
    /** yTop relative to THIS page's pixel space (yOffset already removed). */
    yTopOnPage: number;
    /** yBottom relative to THIS page's pixel space. */
    yBottomOnPage: number;
    /** Original parser-space y-range, for the band list display. */
    yTopParser: number;
    yBottomParser: number;
}

/**
 * Bucket each V2 band into the page whose y-offset range contains
 * its yTop. Single-page receipts always bucket all bands into
 * page 0. Multi-page receipts attribute each band to whichever page
 * its yTop falls in.
 */
const bucketBandsByPage = (
    bands: ProductBand[],
    pages: PageMeta[],
): BandOnPage[][] => {
    const buckets: BandOnPage[][] = pages.map(() => []);
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
        buckets[pageIdx].push({
            bandIdx: bi,
            yTopOnPage: band.yTop - offset,
            yBottomOnPage: band.yBottom - offset,
            yTopParser: band.yTop,
            yBottomParser: band.yBottom,
        });
    }
    return buckets;
};

export default function ReceiptDetailScreen() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { chain, sourcePdf } = useLocalSearchParams<{
        chain: string;
        sourcePdf: string;
    }>();
    const snap: ReceiptSnapshot | null = useMemo(() => {
        if (!chain || !sourcePdf) return null;
        return getReceiptSnapshot(makeSnapshotKey(chain, sourcePdf));
    }, [chain, sourcePdf]);

    if (!snap) {
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

    const buckets = useMemo(
        () => bucketBandsByPage(snap.bandsV2, snap.pages),
        [snap],
    );

    return (
        <ScrollView style={styles.container}>
            <Stack.Screen options={{ title: snap.sourcePdf }} />

            <View style={styles.header}>
                <Text style={styles.headerTitle}>{snap.sourcePdf}</Text>
                <Text style={styles.headerMeta}>
                    {snap.bandsV2.length} band
                    {snap.bandsV2.length === 1 ? 'a' : 'os'} · V2 step 1
                    {snap.pages.length > 1 ? ` · ${snap.pages.length} puslapiai` : ''}
                </Text>
            </View>

            {/* Per-page rendered image with V2 band overlays */}
            {snap.pages.map((page, pageIdx) => {
                const url = `${API_BASE_URL}/receipts-batch/${snap.chain}/${encodeURIComponent(page.name)}`;
                return (
                    <View key={page.name} style={styles.pageWrap}>
                        {snap.pages.length > 1 && (
                            <Text style={styles.pageLabel}>Puslapis {pageIdx + 1}</Text>
                        )}
                        <ImageWithBands
                            uri={url}
                            pageWidth={page.pixelWidth}
                            pageHeight={page.pixelHeight}
                            bands={buckets[pageIdx]}
                            colors={colors}
                        />
                    </View>
                );
            })}

            {/* Band list */}
            <View style={styles.bandsSection}>
                <Text style={styles.sectionTitle}>V2 bandų y koordinatės</Text>
                {snap.bandsV2.length === 0 && (
                    <Text style={styles.emptyText}>V2 nerado bandų.</Text>
                )}
                {snap.bandsV2.map((band, idx) => (
                    <View key={idx} style={styles.bandRow}>
                        <View style={styles.bandIdxBadge}>
                            <Text style={styles.bandIdxText}>{idx + 1}</Text>
                        </View>
                        <Text style={styles.bandText}>
                            y {Math.round(band.yTop)}–{Math.round(band.yBottom)}
                            <Text style={styles.bandTextDim}>
                                {' '}
                                (Δ {Math.round(band.yBottom - band.yTop)} px)
                            </Text>
                        </Text>
                    </View>
                ))}
            </View>
        </ScrollView>
    );
}

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
    // resizeMode='contain' fits the image to 100% width with the
    // intrinsic aspect ratio. The wrapper sets aspectRatio so the
    // overlay <View>s use percentage offsets relative to the wrapper.
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
                const heightPct = ((b.yBottomOnPage - b.yTopOnPage) / pageHeight) * 100;
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
    });
