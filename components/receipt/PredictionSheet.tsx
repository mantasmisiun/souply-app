import { Fragment, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { ProductImage } from '../ProductImage';
import { SheetTitle } from './SheetTitle';
import { useTheme, spacing, radius, typography, withAlpha, DIVIDER_ITEM_HEIGHT, type AppTheme } from '../../constants/theme';
import { formatEuro } from '../../utils/formatCurrency';
import { formatItemAmount } from '../../utils/amountDisplay';
import type { TripScore } from '../../utils/tripsApi';

/**
 * Contents of the "Prognozė" bottom sheet (hosted in an autoHeight <GlassSheet>).
 * Turns the single forecast-delta card into a per-item breakdown. Each row is a
 * plan→actual FLOW: the planned name (bought name muted underneath when the match
 * resolved a different product), then `amount · €planned → amount · €actual` with
 * the price surprise as a coloured pill (0 when none). A changed amount is tinted.
 * A hero sums the two totals and a note frames the metric as a guide.
 */

export function PredictionSheet({ score }: { score: TripScore }) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const predicted = score.predictedMatchedTotal ?? 0;
    const actual = score.actualMatchedTotal ?? 0;
    const totalDelta = Math.round((actual - predicted) * 100) / 100;
    const accuracy = predicted > 0
        ? Math.max(0, Math.round((1 - Math.abs(actual - predicted) / predicted) * 100))
        : null;

    // Priced matches, biggest surprise first. delta = actual − predicted.
    const rows = useMemo(() =>
        score.pairs
            .filter(p => p.listPrice != null && p.listPrice > 0)
            .map(p => ({
                key: `${p.listItemId}:${p.receiptItemId}`,
                planName: p.listName ?? p.productName ?? '—',
                buyName: p.receiptName,
                imageUris: p.imageUrls,
                // listQty is a PACK COUNT (2 × 250 g), so show it against the
                // SP pack size, never as "2 kg". Bought side = the receipt line's
                // own unit/amount/weighable.
                plannedAmount: formatItemAmount({ quantity: p.listQty, isWeighable: p.isWeighable, unit: p.listPackUnit, packAmount: p.listPackAmount, canonicalStep: p.canonicalStep }),
                boughtAmount: formatItemAmount({ quantity: p.receiptQty, isWeighable: p.receiptWeighable, unit: p.receiptUnit, packAmount: p.receiptAmount }),
                predicted: p.listPrice as number,
                actual: p.receiptPrice,
                delta: Math.round((p.receiptPrice - (p.listPrice as number)) * 100) / 100,
                qtyDiff: Math.round(p.listQty * 1000) !== Math.round(p.receiptQty * 1000),
            }))
            .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)),
        [score.pairs]);

    // Green = cheaper than forecast, red = pricier, neutral = on the nose.
    const costColor = (delta: number) =>
        Math.abs(delta) < 0.005 ? colors.textSecondary : delta > 0 ? colors.error : colors.success;
    const signed = (delta: number) =>
        Math.abs(delta) < 0.005 ? '0' : `${delta > 0 ? '+' : '−'}${formatEuro(Math.abs(delta))}`;

    return (
        <View style={styles.body}>
            <View style={styles.padded}>
                <SheetTitle title={t('predictionSheet.title')} />

                {/* Hero: planned total → actual total, with the net surprise. */}
                <View style={styles.hero}>
                    <View style={styles.heroSide}>
                        <Text style={styles.heroLbl}>{t('predictionSheet.planned')}</Text>
                        <Text style={styles.heroVal}>{formatEuro(predicted)}</Text>
                    </View>
                    <Ionicons name="arrow-forward" size={16} color={colors.textMuted} />
                    <View style={styles.heroSide}>
                        <Text style={styles.heroLbl}>{t('predictionSheet.actual')}</Text>
                        <Text style={[styles.heroVal, { color: costColor(totalDelta) }]}>{formatEuro(actual)}</Text>
                    </View>
                    <View style={[styles.deltaChip, { backgroundColor: withAlpha(costColor(totalDelta), 0.14) }]}>
                        <Text style={[styles.deltaChipText, { color: costColor(totalDelta) }]}>{signed(totalDelta)}</Text>
                    </View>
                </View>
                {accuracy != null && (
                    <Text style={styles.accuracy}>{t('predictionSheet.accuracy', { pct: accuracy, count: rows.length })}</Text>
                )}

                <View style={styles.note}>
                    <Ionicons name="information-circle-outline" size={18} color={colors.textSecondary} />
                    <Text style={styles.noteText}>{t('predictionSheet.note')}</Text>
                </View>
            </View>

            {rows.map((r, i) => (
                <Fragment key={r.key}>
                {i > 0 && <View style={styles.sep} />}
                <View style={styles.row}>
                    <ProductImage
                        uris={r.imageUris}
                        imageStyle={styles.thumb}
                        placeholderStyle={styles.thumbPh}
                        emojiStyle={styles.thumbEmoji}
                    />
                    <View style={{ flex: 1, minWidth: 0 }}>
                        <View style={styles.topLine}>
                            <View style={{ flex: 1, minWidth: 0 }}>
                                <Text style={styles.name} numberOfLines={1}>{r.planName}</Text>
                                {!!r.buyName && r.buyName !== r.planName && (
                                    <Text style={styles.alt} numberOfLines={1}>{t('predictionSheet.boughtAs', { name: r.buyName })}</Text>
                                )}
                            </View>
                            <View style={[styles.pill, { backgroundColor: withAlpha(costColor(r.delta), 0.14) }]}>
                                <Text style={[styles.pillText, { color: costColor(r.delta) }]}>{signed(r.delta)}</Text>
                            </View>
                        </View>
                        <View style={styles.flow}>
                            <Text style={styles.seg}>
                                <Text style={styles.segQty}>{`${r.plannedAmount} · `}</Text>
                                <Text style={styles.segPrice}>{formatEuro(r.predicted)}</Text>
                            </Text>
                            <Ionicons name="arrow-forward" size={13} color={colors.textMuted} />
                            <Text style={styles.seg}>
                                <Text style={[styles.segQty, r.qtyDiff && { color: colors.primary, fontWeight: '700' }]}>{`${r.boughtAmount} · `}</Text>
                                <Text style={styles.segPrice}>{formatEuro(r.actual)}</Text>
                            </Text>
                        </View>
                    </View>
                </View>
                </Fragment>
            ))}
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    body: { gap: spacing.xs },
    padded: { paddingHorizontal: spacing.lg, gap: spacing.md, paddingTop: spacing.xs, marginBottom: spacing.xs },

    hero: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    heroSide: { gap: 1 },
    heroLbl: { ...typography.labelSmall, color: c.textSecondary },
    heroVal: { fontSize: 20, fontWeight: '800', color: c.textPrimary, fontVariant: ['tabular-nums'] },
    deltaChip: { marginLeft: 'auto', borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 3 },
    deltaChipText: { ...typography.bodySmall, fontWeight: '800', fontVariant: ['tabular-nums'] },
    accuracy: { ...typography.labelSmall, color: c.textSecondary },

    note: {
        flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm,
        backgroundColor: withAlpha(c.textSecondary, 0.08), borderRadius: radius.md,
        paddingVertical: spacing.sm, paddingHorizontal: spacing.md,
    },
    noteText: { flex: 1, ...typography.labelSmall, color: c.textSecondary, lineHeight: 17 },

    row: { flexDirection: 'row', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, alignItems: 'flex-start' },
    // Canonical item divider (theme dividerItem), inset past the thumbnail.
    sep: { height: DIVIDER_ITEM_HEIGHT, backgroundColor: c.dividerItem, marginLeft: spacing.lg + 38 + spacing.md, marginRight: spacing.lg },
    thumb: { width: 38, height: 38, borderRadius: 9 },
    thumbPh: { width: 38, height: 38, borderRadius: 9, backgroundColor: c.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
    thumbEmoji: { fontSize: 20, opacity: 0.5 },
    topLine: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
    name: { ...typography.bodySmall, fontWeight: '700', color: c.textPrimary },
    alt: { ...typography.labelSmall, color: c.textSecondary, marginTop: 1 },
    pill: { borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 3 },
    pillText: { ...typography.bodySmall, fontWeight: '800', fontVariant: ['tabular-nums'] },
    flow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 6, flexWrap: 'wrap' },
    seg: { ...typography.bodySmall, fontVariant: ['tabular-nums'] },
    segQty: { color: c.textSecondary },
    segPrice: { fontWeight: '700', color: c.textPrimary },
});
