import { Fragment, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ChainLogoChip } from '../ChainLogoChip';
import { ProductImage } from '../ProductImage';
import { SheetTitle } from './SheetTitle';
import { useTheme, spacing, radius, typography, withAlpha, DIVIDER_ITEM_HEIGHT, type AppTheme } from '../../constants/theme';
import { chainIdByName } from '../../utils/chainBrandName';

export interface PlanReconcileItem {
    key: string;
    name: string;
    /** Image URL(s) — a single URL as [url], or the product's imageUrls array /
     *  JSON string. Falls back to the 🫜 placeholder when none load. */
    imageUris: (string | null)[] | string | null;
    /** Small caption under the name (qty / size). */
    meta?: string | null;
    /** Chain (for the top-left badge on multi-store trips). */
    chainId?: number | null;
    chainName?: string | null;
    /** true → green ✓ (planned / bought); false → ✗ (impulse / missed). */
    ok: boolean;
}

/**
 * Shared plan-vs-actual reconciliation sheet (hosted in an autoHeight
 * <GlassSheet>) — the Impulse and Missed sheets are the same shape, differing
 * only in data source, the ✗ colour, the legend wording and the note:
 *   • Impulse: receipt items, red ✗ = bought-but-not-planned, green ✓ = on plan.
 *   • Missed:  plan items, grey ✗ = planned-but-not-bought, green ✓ = bought.
 * Items that need attention (✗) sort to the top. Cards mirror the Kvitai
 * identified-items list (thumbnail · name · qty) with the marker on the right.
 */
export function PlanReconcileSheet({
    title, items, okLabel, badLabel, badColor, showChainBadge = false, note,
}: {
    title: string;
    items: PlanReconcileItem[];
    okLabel: string;
    badLabel: string;
    /** The ✗ colour: error (impulse) or a muted grey (missed). */
    badColor: string;
    showChainBadge?: boolean;
    note?: string;
}) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    // Attention-first: ✗ rows on top, otherwise first-seen order preserved.
    const ordered = useMemo(
        () => items.map((it, i) => ({ it, i })).sort((a, b) => Number(a.it.ok) - Number(b.it.ok) || a.i - b.i).map(x => x.it),
        [items],
    );

    return (
        <View style={styles.body}>
            <View style={styles.padded}>
                <SheetTitle title={title} count={items.length} />
                {/* Legend — what each marker means. */}
                <View style={styles.legend}>
                    <View style={styles.legendItem}>
                        <Ionicons name="checkmark-circle" size={16} color={colors.success} />
                        <Text style={styles.legendText}>{okLabel}</Text>
                    </View>
                    <View style={styles.legendItem}>
                        <Ionicons name="close-circle" size={16} color={badColor} />
                        <Text style={styles.legendText}>{badLabel}</Text>
                    </View>
                </View>
                {!!note && (
                    <View style={styles.note}>
                        <Ionicons name="information-circle-outline" size={18} color={colors.textSecondary} />
                        <Text style={styles.noteText}>{note}</Text>
                    </View>
                )}
            </View>

            {ordered.map((it, i) => (
                <Fragment key={it.key}>
                {i > 0 && <View style={styles.sep} />}
                <View style={styles.itemRow}>
                    <View style={styles.thumbWrap}>
                        <ProductImage
                            uris={it.imageUris}
                            imageStyle={styles.itemImage}
                            placeholderStyle={styles.itemImagePlaceholder}
                            emojiStyle={styles.itemEmoji}
                        />
                        {showChainBadge && !!it.chainName && (
                            <View style={styles.itemBadge}>
                                <ChainLogoChip chainId={it.chainId ?? chainIdByName(it.chainName) ?? 0} name={it.chainName} size={18} />
                            </View>
                        )}
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={[styles.itemName, !it.ok && styles.itemNameBad]} numberOfLines={1}>{it.name}</Text>
                        {!!it.meta && <Text style={styles.itemMeta}>{it.meta}</Text>}
                    </View>
                    <Ionicons
                        name={it.ok ? 'checkmark-circle' : 'close-circle'}
                        size={22}
                        color={it.ok ? colors.success : badColor}
                    />
                </View>
                </Fragment>
            ))}
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    body: { gap: spacing.xs },
    // Horizontal inset comes from the sheet's SheetContent wrapper — none here.
    padded: { gap: spacing.md, marginBottom: spacing.xs },
    legend: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
    legendItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    legendText: { ...typography.labelSmall, color: c.textSecondary },
    note: {
        flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm,
        backgroundColor: withAlpha(c.textSecondary, 0.08), borderRadius: radius.md,
        paddingVertical: spacing.sm, paddingHorizontal: spacing.md,
    },
    noteText: { flex: 1, ...typography.labelSmall, color: c.textSecondary, lineHeight: 17 },

    // Canonical item divider (theme dividerItem), inset past the thumbnail.
    sep: { height: DIVIDER_ITEM_HEIGHT, backgroundColor: c.dividerItem, marginLeft: 40 + spacing.md },
    itemRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
    thumbWrap: { width: 40, height: 40 },
    itemImage: { width: 40, height: 40, borderRadius: 10 },
    itemImagePlaceholder: {
        width: 40, height: 40, borderRadius: 10,
        backgroundColor: c.surfaceMuted, alignItems: 'center', justifyContent: 'center',
    },
    itemEmoji: { fontSize: 22, opacity: 0.5 },
    itemBadge: { position: 'absolute', top: -5, left: -5, borderRadius: 11, padding: 1.5, backgroundColor: c.cardBackground },
    itemName: { ...typography.bodySmall, fontWeight: '600', color: c.textPrimary },
    itemNameBad: { color: c.textSecondary },
    itemMeta: { ...typography.labelSmall, color: c.textSecondary, marginTop: 1 },
});
