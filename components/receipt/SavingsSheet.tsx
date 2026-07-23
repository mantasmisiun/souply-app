import { useContext, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, {
    useAnimatedStyle, useAnimatedReaction, useSharedValue, withDelay, withTiming,
} from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { MaterialProgress } from '@/components/MaterialProgress';
import { SheetOpenedContext } from '../GlassSheet';
import { ChainLogoChip } from '../ChainLogoChip';
import { useTheme, spacing, typography, withAlpha, type AppTheme } from '../../constants/theme';
import { fetchTripComparison, type TripComparison, type TripComparisonStore } from '../../utils/tripsApi';
import { savingsTip } from '../../utils/savingsTips';
import { SheetTitle } from './SheetTitle';
import { formatEuro } from '../../utils/formatCurrency';

/**
 * Sutaupyta/Išsvaistyta transparency sheet (hosted in <GlassSheet autoHeight>).
 * Horizontal cost bars — zero on the left, your basket's total at each nearby
 * store growing right, flat left / rounded right (the Planavimas bar style), the
 * chain logo tucked in the rounded end with equal padding, and YOUR store in the
 * pink selection style. One tip at the bottom; a distinct message when the system
 * couldn't differentiate store prices (equalPrices). Bars animate after the sheet
 * opens (SheetOpenedContext), staggered.
 */
export function SavingsSheet({ tripId }: { tripId: number }) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const [data, setData] = useState<TripComparison | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let alive = true;
        fetchTripComparison(tripId)
            .then(d => { if (alive) { setData(d); setLoading(false); } })
            .catch(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
    }, [tripId]);

    if (loading) {
        return (
            <View style={styles.loadingBody}>
                <MaterialProgress size="small" color={colors.primary} />
                <Text style={styles.loadingText}>{t('savingsSheet.loading')}</Text>
            </View>
        );
    }
    if (!data) return null;

    const tip = savingsTip(data);
    const totals = data.stores.map(s => s.total);
    const maxTotal = totals.length ? Math.max(...totals) : 1;
    const minTotal = totals.length ? Math.min(...totals) : 0;
    const showBars = !data.equalPrices && data.stores.length >= 2;
    // Your store's bar colour = how good your pick was: cheapest → below avg →
    // above avg → most expensive. The glow matches (self-coloured, no clash).
    const yourColor = yourStoreColor(data, maxTotal);

    return (
        <View style={styles.body}>
            <SheetTitle title={t('savingsSheet.title')} />

            {showBars ? (
                <View style={styles.bars}>
                    {data.stores.map((s, i) => {
                        // Compress to a 0.5…1 range so even the cheapest bar fits its
                        // logo and the differences stay visible.
                        const frac = maxTotal > minTotal ? 0.5 + 0.5 * (s.total - minTotal) / (maxTotal - minTotal) : 1;
                        return <SavingsBar key={s.chainId} store={s} frac={frac} index={i} yourColor={yourColor} colors={colors} styles={styles} />;
                    })}
                </View>
            ) : (
                <View style={styles.chipRow}>
                    {data.stores.map(s => (
                        <ChainLogoChip key={s.chainId} chainId={s.chainId} name={s.chainName} size={28} />
                    ))}
                </View>
            )}

            <Text style={styles.tip}>{t(tip.key, tip.params)}</Text>
        </View>
    );
}

/** Your store's bar colour by cost rank — teal (cheapest) → teal (below avg) →
 *  amber (above avg) → coral/red (most expensive). Semantic + drives the glow. */
const COST_COLOR = { cheapest: '#4F9A8F', below: '#5EA29A', above: '#E8894D', worst: '#C6455B' } as const;
function yourStoreColor(c: TripComparison, maxTotal: number): string {
    if (c.yoursTotal <= c.cheapestTotal + 0.005) return COST_COLOR.cheapest;
    if (c.yoursTotal >= maxTotal - 0.005) return COST_COLOR.worst;
    if (c.yoursTotal <= c.medianTotal) return COST_COLOR.below;
    return COST_COLOR.above;
}

function SavingsBar({ store, frac, index, yourColor, colors, styles }: {
    store: TripComparisonStore; frac: number; index: number; yourColor: string; colors: AppTheme; styles: Styles;
}) {
    const opened = useContext(SheetOpenedContext);
    const anim = useSharedValue(0);
    useAnimatedReaction(
        () => opened?.value ?? false,
        (v, prev) => { if (v && !prev) anim.value = withDelay(index * 70, withTiming(1, { duration: 360 })); },
        [index],
    );
    const fillStyle = useAnimatedStyle(() => ({ width: `${frac * 100 * anim.value}%` }));
    // Your store: the cost colour + a self-coloured glow (only your bar glows, so
    // it's unmistakable and never clashes). Others: a quiet warm neutral.
    const yoursStyle = store.yours ? {
        backgroundColor: yourColor,
        borderColor: yourColor,
        boxShadow: [{ offsetX: 0, offsetY: 0, blurRadius: 16, spreadDistance: 1, color: withAlpha(yourColor, 0.55) }],
    } : undefined;
    return (
        <View style={styles.barRow}>
            {/* Logo pinned on the LEFT (doesn't ride the animated tip) */}
            <ChainLogoChip chainId={store.chainId} name={store.chainName} size={LOGO} />
            <View style={styles.lane}>
                <Animated.View style={[styles.fill, store.yours ? null : styles.fillOther, yoursStyle, fillStyle]}>
                    <Text style={[styles.barPrice, { color: store.yours ? '#FFFFFF' : colors.textPrimary }]} numberOfLines={1} allowFontScaling={false}>
                        {formatEuro(store.total)}
                    </Text>
                </Animated.View>
            </View>
        </View>
    );
}

type Styles = ReturnType<typeof makeStyles>;

const BAR_H = 30;
const LOGO = 30;

const makeStyles = (c: AppTheme) => StyleSheet.create({
    body: { paddingHorizontal: spacing.lg, gap: spacing.md, paddingTop: spacing.xs },
    loadingBody: { padding: spacing.xl, alignItems: 'center', gap: spacing.md },
    loadingText: { ...typography.bodySmall, color: c.textSecondary },
    bars: { gap: spacing.sm },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    // Row: [logo] [lane → bar]. Logo pinned left; the bar grows inside the lane.
    barRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, height: BAR_H },
    lane: { flex: 1, height: BAR_H, justifyContent: 'center' },
    // Flat left (at zero), rounded right tip — the Planavimas bar language. The
    // total sits inside near the tip.
    fill: {
        height: BAR_H, minWidth: 62,
        borderTopRightRadius: BAR_H / 2, borderBottomRightRadius: BAR_H / 2,
        borderWidth: 1.5, borderColor: 'transparent',
        flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end',
        paddingRight: 11, paddingLeft: 10,
    },
    // Other stores — the palette's warm `border` greige (#E6DCD5 light / #3A3A3C
    // dark), so it belongs to the cream UI instead of the old cool gray.
    fillOther: { backgroundColor: c.border },
    barPrice: { fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
    tip: { ...typography.bodySmall, color: c.textSecondary },
});
