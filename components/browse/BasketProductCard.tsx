import { memo, useMemo } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ProductImage } from '../ProductImage';
import { ChainLogoStrip } from '../ChainLogoStrip';
import { ScalePressable } from '../ScalePressable';
import { AddOrStepper, type SteppableProduct } from '../AddOrStepper';
import { useTheme, radius, elevation, type AppTheme } from '../../constants/theme';
import { chainBrandColorById } from '../../utils/chainBrandName';
import { formatEuro } from '../../utils/formatCurrency';

type ImageUrlList = (string | null | undefined)[] | string | null;
type ChainLogo = { chainId: number; logoUrl: string | null };

/** Cheapest per-unit price computed server-side (services/productBadge.ts). */
export type UnitPriceBadge = {
    unitPrice: number;
    unit: string;
    chainId: number;
    logoUrl: string | null;
    showLogo: boolean;
};

type Props = {
    name: string;
    imageUrls?: ImageUrlList;
    chainLogos?: ChainLogo[] | string | null;
    amountText?: string;
    quantity: number;
    /** The product itself — drives AddOrStepper's canonical stepping + picker. */
    product: SteppableProduct;
    /** Persist the new quantity (0 = remove). AddOrStepper owns the stepping. */
    onCommit: (qty: number) => void;
    isAdding?: boolean;
    /** Overrides the default "Į krepšelį" label on the add CTA. Used by
     *  the template-add flow to render "Į šabloną" instead. */
    addLabel?: string;
    onOpen?: () => void;
    /** Cheapest-per-unit badge; omit (e.g. discounts screen) to hide. */
    badge?: UnitPriceBadge | null;
};

function BasketProductCard({
    name,
    imageUrls,
    chainLogos,
    amountText,
    quantity,
    product,
    onCommit,
    isAdding = false,
    addLabel,
    onOpen,
    badge,
}: Props) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    return (
        <View style={styles.productCard}>
            <ScalePressable
                onPress={onOpen}
                style={styles.productImageContainer}
                activeOpacity={onOpen ? 0.7 : 1}
                disabled={!onOpen}
            >
                <ProductImage
                    uris={imageUrls}
                    imageStyle={styles.productImage}
                    placeholderStyle={styles.productImagePlaceholder}
                    emojiStyle={styles.productImageEmoji}
                />
                {chainLogos && (
                    <ChainLogoStrip chainLogos={chainLogos} style={{ position: 'absolute', top: 6, left: 6 }} />
                )}
            </ScalePressable>
            {badge && (
                <View style={[styles.unitBadge, !badge.showLogo && styles.unitBadgeNoLogo]} pointerEvents="none">
                    {badge.showLogo && (
                        <View style={[styles.unitBadgeLogoWrap, { backgroundColor: chainBrandColorById(badge.chainId) }]}>
                            {badge.logoUrl ? (
                                <Image source={{ uri: badge.logoUrl }} style={styles.unitBadgeLogo} resizeMode="contain" />
                            ) : (
                                <Text style={styles.unitBadgeLogoFallback}>{badge.chainId}</Text>
                            )}
                        </View>
                    )}
                    <Text style={styles.unitBadgeText}>{`${formatEuro(badge.unitPrice)}/${badge.unit}`}</Text>
                </View>
            )}

            <View style={styles.productInfo}>
                <Text style={styles.productName} numberOfLines={3}>{name}</Text>
                {!!amountText && <Text style={styles.amountText}>{amountText}</Text>}
            </View>

            <AddOrStepper
                product={product}
                quantity={quantity}
                onCommit={onCommit}
                busy={isAdding}
                addLabel={addLabel ?? t('catalog.addToBasket')}
                fullWidth
                noIcon
            />
        </View>
    );
}

export default memo(BasketProductCard);

const makeStyles = (c: AppTheme) => StyleSheet.create({
    productCard: {
        backgroundColor: c.cardBackground,
        borderRadius: radius.lg,
        padding: 12,
        alignItems: 'center',
        ...elevation.level2,
        flex: 1,
        maxWidth: '50%',
    },
    productImageContainer: {
        width: '100%',
        height: 130,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 8,
    },
    productImage: { width: '100%', height: '100%', borderRadius: radius.md },
    productImagePlaceholder: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: c.surfaceMuted,
        borderRadius: radius.md,
    },
    productImageEmoji: { fontSize: 44, opacity: 0.4 },
    productInfo: { flex: 1, width: '100%', marginBottom: 10 },
    productName: { fontSize: 13, color: c.textPrimary, lineHeight: 18 },
    amountText: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    // Half-pill: rounded on the left, flat on the right, flush with the
    // card's right edge (right: 0 escapes the card's 12px padding). Top
    // aligns its centre with the chain-logo strip on the left (strip sits
    // at card top 12+6 with a 17px pill → centre 26.5; 26.5 − 24/2 ≈ 14).
    unitBadge: {
        position: 'absolute',
        right: 0,
        top: 14,
        height: 24,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingLeft: 4,
        paddingRight: 8,
        backgroundColor: c.primary,
        borderTopLeftRadius: 12,
        borderBottomLeftRadius: 12,
        ...elevation.level2,
        zIndex: 2,
    },
    unitBadgeNoLogo: { paddingLeft: 8 },
    unitBadgeLogoWrap: {
        width: 17,
        height: 17,
        borderRadius: 8.5,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: c.onPrimary,
    },
    unitBadgeLogo: { width: 12, height: 12, borderRadius: 6 },
    unitBadgeLogoFallback: { fontSize: 8, fontWeight: '700', color: '#fff' },
    unitBadgeText: { fontSize: 11, fontWeight: '700', color: c.onPrimary },
});
