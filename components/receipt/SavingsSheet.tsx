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
import { fetchTripBasketComparison, type TripBasketComparison, type TripSpendSegment } from '../../utils/tripsApi';
import { tripSavingsTip } from '../../utils/savingsTips';
import { SheetTitle } from './SheetTitle';
import { formatEuro } from '../../utils/formatCurrency';

/**
 * Sutaupyta — one list of cost bars: what the same basket costs at each nearby
 * store as a SINGLE shop, cheapest first, your own shop among them.
 *
 * ONE STORE: your store's bar IS what you paid (the server prices a visited
 * chain from the till, not the catalogue), so the sheet reads exactly as it
 * always did — bars, your one highlighted by how good the pick was.
 *
 * TWO OR MORE: one extra bar for the split itself — your real total, overlapping
 * logos of the stores you visited, sorted in among the others by amount. The
 * "splitting saved / cost you" line only appears here; on a single-store trip
 * there is no split to judge.
 *
 * Two receipts from the SAME chain are one shop (you went back for what you
 * forgot), which is why segments key on chain rather than store.
 */
export function SavingsSheet({ tripId }: { tripId: number }) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const [data, setData] = useState<TripBasketComparison | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let alive = true;
        fetchTripBasketComparison(tripId)
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
    if (!data || data.paidTotal <= 0) return null;

    const multiStore = data.segments.length > 1;

    // ONE list. A split trip adds a bar for the split itself; a single-store trip
    // doesn't (its own store's bar already IS what it paid).
    // The split row's stacked logos are wider than a single chip, so without a
    // shared slot width its bar started further right than the others and the
    // zeros no longer lined up — which is exactly the comparison the bars exist
    // to make. Every row reserves the widest slot.
    const logoSlotW = multiStore
        ? LOGO + Math.max(0, data.segments.length - 1) * LOGO_OVERLAP
        : LOGO;

    const rows: Row[] = data.candidates.map(c => ({
        key: `c-${c.chainId}-${c.storeId}`,
        total: c.total,
        chainId: c.chainId,
        chainName: c.chainName,
        // On a single-store trip the visited chain's bar is your receipt — mark
        // it yours so it carries the verdict colour.
        yours: !multiStore && c.visited,
        segments: null,
    }));
    if (multiStore) {
        rows.push({
            key: 'yours',
            total: data.paidTotal,
            chainId: null,
            chainName: null,
            yours: true,
            segments: data.segments,
        });
    }
    rows.sort((a, b) => a.total - b.total);

    const totals = rows.map(r => r.total);
    const maxTotal = Math.max(...totals, 0.01);
    const minTotal = Math.min(...totals);
    const median = totals.length ? totals[Math.floor((totals.length - 1) / 2)] : data.paidTotal;
    const yourColor = costColor(data.paidTotal, minTotal, maxTotal, median);

    // ONE line under the bars: the tip. A separate "one store would have saved
    // you X" verdict said the same thing twice, and the catalogue caveat was
    // detail nobody asked for.
    const tip = tripSavingsTip(data);

    return (
        <View style={styles.body}>
            <SheetTitle title={t('savingsSheet.title')} />

            <View style={styles.bars}>
                {rows.map((row, i) => {
                    // Compress to 0.5…1 so even the cheapest bar fits its number
                    // and the differences stay readable.
                    const frac = maxTotal > minTotal
                        ? 0.5 + 0.5 * (row.total - minTotal) / (maxTotal - minTotal)
                        : 1;
                    return (
                        <CostBar
                            key={row.key} row={row} frac={frac} index={i}
                            logoSlotW={logoSlotW}
                            yourColor={yourColor} colors={colors} styles={styles}
                        />
                    );
                })}
            </View>

            <Text style={styles.tip}>{t(tip.key, tip.params)}</Text>
        </View>
    );
}

interface Row {
    key: string;
    total: number;
    chainId: number | null;
    chainName: string | null;
    yours: boolean;
    /** Set only on the split row — the chains you actually visited. */
    segments: TripSpendSegment[] | null;
}

function CostBar({ row, frac, index, logoSlotW, yourColor, colors, styles }: {
    row: Row; frac: number; index: number; logoSlotW: number;
    yourColor: string; colors: AppTheme; styles: Styles;
}) {
    const opened = useContext(SheetOpenedContext);
    const anim = useSharedValue(0);
    useAnimatedReaction(
        () => opened?.value ?? false,
        (v, prev) => { if (v && !prev) anim.value = withDelay(index * 70, withTiming(1, { duration: 360 })); },
        [index],
    );
    const fillStyle = useAnimatedStyle(() => ({ width: `${frac * 100 * anim.value}%` }));
    // Your bar: the cost-rank colour + a self-coloured glow (only yours glows, so
    // it's unmistakable and never clashes). Others: a quiet warm neutral.
    const yoursStyle = row.yours ? {
        backgroundColor: yourColor,
        borderColor: yourColor,
        boxShadow: [{ offsetX: 0, offsetY: 0, blurRadius: 16, spreadDistance: 1, color: withAlpha(yourColor, 0.55) }],
    } : undefined;
    const split = row.segments && row.segments.length > 1;

    return (
        <View style={styles.barRow}>
            {/* Logo slot — one chip, or the visited chains overlapping for the
                split row. Same left position on every row. */}
            <View style={[styles.logoStack, { width: logoSlotW }]}>
                {split
                    ? row.segments!.map((s, i) => (
                        <View key={s.storeId} style={[styles.stackItem, { left: i * LOGO_OVERLAP, zIndex: 10 - i }]}>
                            <ChainLogoChip chainId={s.chainId ?? 0} name={s.chainName ?? undefined} size={LOGO} />
                        </View>
                    ))
                    : <ChainLogoChip chainId={row.chainId ?? 0} name={row.chainName ?? undefined} size={LOGO} />}
            </View>
            <View style={styles.lane}>
                <Animated.View
                    style={[
                        styles.fill, row.yours ? null : styles.fillOther, yoursStyle,
                        // The split bar carries its total on the LEFT: its right
                        // tip is where the eye compares lengths, and the stacked
                        // logos already occupy the left of the row.
                        split && styles.fillSplit, fillStyle,
                    ]}
                >
                    <Text
                        style={[styles.barPrice, { color: row.yours ? '#FFFFFF' : colors.textPrimary }]}
                        numberOfLines={1}
                        allowFontScaling={false}
                    >
                        {formatEuro(row.total)}
                    </Text>
                </Animated.View>
            </View>
        </View>
    );
}

/** Your bar's colour by cost rank — teal (cheapest) → teal (below median) →
 *  amber (above) → coral (most expensive). Semantic, and drives the glow. */
const COST_COLOR = { cheapest: '#4F9A8F', below: '#5EA29A', above: '#E8894D', worst: '#C6455B' } as const;
function costColor(yours: number, min: number, max: number, median: number): string {
    if (yours <= min + 0.005) return COST_COLOR.cheapest;
    if (yours >= max - 0.005) return COST_COLOR.worst;
    if (yours <= median) return COST_COLOR.below;
    return COST_COLOR.above;
}

type Styles = ReturnType<typeof makeStyles>;

const BAR_H = 30;
const LOGO = 30;
/** How far each stacked logo is offset — partial overlap, newest on top. */
const LOGO_OVERLAP = 18;

const makeStyles = (c: AppTheme) => StyleSheet.create({
    // Inset comes from the sheet's SheetContent wrapper — gap only here.
    body: { gap: spacing.md },
    loadingBody: { padding: spacing.xl, alignItems: 'center', gap: spacing.md },
    loadingText: { ...typography.bodySmall, color: c.textSecondary },
    bars: { gap: spacing.sm },

    // Row: [logo(s)] [lane → bar]. Logos pinned left; the bar grows in the lane.
    barRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, height: BAR_H },
    // Fixed width on EVERY row (the widest slot) so all lanes — and so all
    // bar zeros — start at the same x.
    logoStack: { height: LOGO, justifyContent: 'center' },
    stackItem: { position: 'absolute', top: 0 },
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
    fillSplit: { justifyContent: 'flex-start' },
    // Other stores — the palette's warm `border` greige, so the bar belongs to
    // the cream UI instead of a cool gray.
    fillOther: { backgroundColor: c.border },
    barPrice: { fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },

    tip: { ...typography.bodySmall, color: c.textSecondary },
});
