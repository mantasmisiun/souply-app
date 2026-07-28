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
 * Contents of the "Akcijos" bottom sheet (hosted in an autoHeight
 * <GlassSheet>). Lists this trip's discounted lines as product cards in the
 * same shape as the Kvitai identified-items list — thumbnail · name · qty — but
 * the right column shows the promo total in souply pink over the crossed-out
 * regular price. A note reminds the shopper that these are the CHAIN's own
 * discounts and that comparing the basket elsewhere can still win.
 *
 * Below the products, one FOOTER ROW per loyalty programme the trip used
 * ("MAXIMOS pinigai −0,12"). Deliberately not a product row: the rows above mean
 * "cheaper than usual", while loyalty money means "paid from a balance you
 * already had". Folding it into the list would inflate Akcijos with something
 * that isn't a discount; leaving it out entirely leaves the receipt's arithmetic
 * unexplained — the printed total sits BELOW the line sum by exactly this much.
 * Money EARNED rides the muted subline: it doesn't reduce this bill.
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

    // One row per loyalty programme: redeemed sums across the trip's receipts
    // (you can pay from the balance twice), while the balance is the LATEST
    // reading — an older receipt's leftover is not news.
    const loyaltyRows = useMemo(() => {
        const byProgram = new Map<string, { program: string; chainId: number | null; chainName: string | null; redeemed: number; earned: number; balance: number | null }>();
        for (const r of receipts) {
            const l = r.loyalty;
            if (!l || (l.redeemed ?? 0) <= 0) continue;
            const key = l.program || 'unknown';
            const held = byProgram.get(key);
            if (held) {
                held.redeemed = Math.round((held.redeemed + l.redeemed) * 100) / 100;
                held.earned = Math.round((held.earned + (l.earned ?? 0)) * 100) / 100;
                if (l.balance != null) held.balance = l.balance;
            } else {
                byProgram.set(key, {
                    program: key,
                    chainId: r.chainId ?? chainIdByName(r.chainName ?? '') ?? null,
                    chainName: r.chainName ?? null,
                    redeemed: l.redeemed,
                    earned: l.earned ?? 0,
                    balance: l.balance,
                });
            }
        }
        return [...byProgram.values()];
    }, [receipts]);

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

            {loyaltyRows.map(l => {
                const brand = l.chainName ? chainBrandName(l.chainName) : null;
                const sub = [
                    l.balance != null ? t('discountsSheet.loyaltyBalance', { balance: formatEuro(l.balance) }) : null,
                    l.earned > 0 ? t('discountsSheet.loyaltyEarned', { earned: formatEuro(l.earned) }) : null,
                ].filter(Boolean).join(' · ');
                return (
                    <View key={`loyalty-${l.program}`} style={[styles.itemRow, styles.loyaltyRow]}>
                        <View style={styles.thumbWrap}>
                            <View style={styles.loyaltyLogo}>
                                <ChainLogoChip chainId={l.chainId ?? 0} name={l.chainName ?? undefined} size={34} />
                            </View>
                        </View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={styles.itemName} numberOfLines={1}>
                                {brand
                                    ? t('discountsSheet.loyaltyTitle', { brand })
                                    : t('discountsSheet.loyaltyTitleGeneric')}
                            </Text>
                            {!!sub && <Text style={styles.itemMeta} numberOfLines={1}>{sub}</Text>}
                        </View>
                        <View style={styles.priceCol}>
                            <Text style={styles.promoPrice}>{`−${formatEuro(l.redeemed)}`}</Text>
                        </View>
                    </View>
                );
            })}
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    body: { gap: spacing.xs },
    // Horizontal inset comes from the sheet's SheetContent wrapper — none here.
    padded: { gap: spacing.md, marginBottom: spacing.xs },
    note: {
        flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm,
        backgroundColor: withAlpha(c.textSecondary, 0.08), borderRadius: radius.md,
        paddingVertical: spacing.sm, paddingHorizontal: spacing.md,
    },
    noteText: { flex: 1, ...typography.labelSmall, color: c.textSecondary, lineHeight: 17 },

    itemRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
    thumbWrap: { width: 40, height: 40 },
    itemImage: { width: 40, height: 40, borderRadius: 10 },
    itemImageEmpty: { backgroundColor: c.surfaceMuted },
    itemBadge: { position: 'absolute', top: -5, left: -5, borderRadius: 11, padding: 1.5, backgroundColor: c.cardBackground },
    itemName: { ...typography.bodySmall, fontWeight: '600', color: c.textPrimary },
    itemMeta: { ...typography.labelSmall, color: c.textSecondary, marginTop: 1 },

    // A footer adjustment, not a product: hairline above, logo where the
    // thumbnail would be, so it aligns with the list without pretending to be
    // one of its rows.
    loyaltyRow: {
        borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border,
        marginTop: spacing.xs, paddingTop: spacing.md,
    },
    loyaltyLogo: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },

    priceCol: { alignItems: 'flex-end' },
    promoPrice: { ...typography.bodySmall, fontWeight: '800', color: c.primary, fontVariant: ['tabular-nums'] },
    regularPrice: {
        ...typography.labelSmall, color: c.textMuted, marginTop: 1,
        textDecorationLine: 'line-through', fontVariant: ['tabular-nums'],
    },
});
