import { useMemo } from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { ChainLogoChip } from '../ChainLogoChip';
import { useTheme, spacing, radius, typography, withAlpha, type AppTheme } from '../../constants/theme';
import { formatEuro } from '../../utils/formatCurrency';
import { chainBrandName, chainIdByName } from '../../utils/chainBrandName';
import { SheetTitle } from './SheetTitle';
import { mergeReceiptItems, mergedQtyLabel } from '../../utils/mergeReceiptItems';
import type { TripReceipt } from '../../utils/tripsApi';

/**
 * Contents of the "Prekės su akcija" bottom sheet (hosted in an autoHeight
 * <GlassSheet>). Lists this trip's discounted lines as product cards in the
 * same shape as the Kvitai identified-items list — thumbnail · name · qty — but
 * the right column shows the promo total in souply pink over the crossed-out
 * regular price. A note reminds the shopper that these are the CHAIN's own
 * discounts and that comparing the basket elsewhere can still win.
 */
export function DiscountsSheet({ receipts }: { receipts: TripReceipt[] }) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const discounted = useMemo(
        // A real discount = the regular total exceeds the paid total (cent guard
        // absorbs rounding). mergeReceiptItems keeps first-seen order.
        () => mergeReceiptItems(receipts).filter(m => m.regularTotal > m.lineTotal + 0.005),
        [receipts],
    );

    // Short brand name(s) whose promos these are — usually one store per trip.
    const chainLabel = useMemo(() => {
        const names = [...new Set(discounted.map(m => m.chainName).filter(Boolean) as string[])]
            .map(chainBrandName);
        return names.length ? names.join(', ') : t('discountsSheet.thisStore');
    }, [discounted, t]);

    // Multi-store trip → stamp each thumb with its chain badge (as in Kvitai).
    const multi = useMemo(
        () => new Set(receipts.map(r => r.chainName).filter(Boolean)).size > 1,
        [receipts],
    );

    return (
        <View style={styles.body}>
            <View style={styles.padded}>
                <SheetTitle title={t('discountsSheet.title')} count={discounted.length} />
                <View style={styles.note}>
                    <Ionicons name="information-circle-outline" size={18} color={colors.textSecondary} />
                    <Text style={styles.noteText}>{t('discountsSheet.explainer', { chain: chainLabel })}</Text>
                </View>
            </View>

            {discounted.map(m => {
                const qtyLabel = mergedQtyLabel(m);
                return (
                    <View key={m.key} style={styles.itemRow}>
                        <View style={styles.thumbWrap}>
                            {m.imageUrl
                                ? <Image source={{ uri: m.imageUrl }} style={styles.itemImage} />
                                : <View style={[styles.itemImage, styles.itemImageEmpty]} />}
                            {multi && (
                                <View style={styles.itemBadge}>
                                    <ChainLogoChip chainId={m.chainId ?? chainIdByName(m.chainName ?? '') ?? 0} name={m.chainName ?? undefined} size={18} />
                                </View>
                            )}
                        </View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={styles.itemName} numberOfLines={1}>{m.name}</Text>
                            {qtyLabel && <Text style={styles.itemMeta}>{qtyLabel}</Text>}
                        </View>
                        <View style={styles.priceCol}>
                            <Text style={styles.promoPrice}>{formatEuro(m.lineTotal)}</Text>
                            <Text style={styles.regularPrice}>{formatEuro(m.regularTotal)}</Text>
                        </View>
                    </View>
                );
            })}
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    body: { gap: spacing.xs },
    padded: { paddingHorizontal: spacing.lg, gap: spacing.md, paddingTop: spacing.xs, marginBottom: spacing.xs },
    note: {
        flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm,
        backgroundColor: withAlpha(c.textSecondary, 0.08), borderRadius: radius.md,
        paddingVertical: spacing.sm, paddingHorizontal: spacing.md,
    },
    noteText: { flex: 1, ...typography.labelSmall, color: c.textSecondary, lineHeight: 17 },

    itemRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
    thumbWrap: { width: 40, height: 40 },
    itemImage: { width: 40, height: 40, borderRadius: 10 },
    itemImageEmpty: { backgroundColor: c.surfaceMuted },
    itemBadge: { position: 'absolute', top: -5, left: -5, borderRadius: 11, padding: 1.5, backgroundColor: c.cardBackground },
    itemName: { ...typography.bodySmall, fontWeight: '600', color: c.textPrimary },
    itemMeta: { ...typography.labelSmall, color: c.textSecondary, marginTop: 1 },

    priceCol: { alignItems: 'flex-end' },
    promoPrice: { ...typography.bodySmall, fontWeight: '800', color: c.primary, fontVariant: ['tabular-nums'] },
    regularPrice: {
        ...typography.labelSmall, color: c.textMuted, marginTop: 1,
        textDecorationLine: 'line-through', fontVariant: ['tabular-nums'],
    },
});
