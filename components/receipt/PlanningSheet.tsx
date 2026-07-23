import { useContext, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, {
    useAnimatedStyle, useAnimatedReaction, useSharedValue, withDelay, withTiming,
} from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { SheetOpenedContext } from '../GlassSheet';
import { useTheme, spacing, radius, typography, withAlpha, type AppTheme } from '../../constants/theme';
import { planningBars, type PlanningBar } from '../../utils/planningTips';
import type { TripScore } from '../../utils/tripsApi';
import { SheetTitle } from './SheetTitle';

/**
 * Planavimo balo skaidrumas — the transparent per-category breakdown behind the
 * planning score (hosted in <GlassSheet>). Three diverging bars from a central
 * zero line: right/green = above neutral (helped), left/red = below (hurt),
 * greyed = couldn't be judged (no list / no store comparison). No numbers — the
 * overall score already lives on the stats screen; this shows HOW it's judged,
 * plus a concrete per-category tip.
 */
export function PlanningSheet({ score }: { score: TripScore }) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const bars = planningBars(score);
    const showBanner = (score.score ?? 0) >= 90;

    return (
        <View style={styles.body}>
            <SheetTitle title={t('planningSheet.title')} />
            {showBanner && (
                <View style={styles.banner}>
                    <Text style={styles.bannerText}>{t('planningSheet.banner')}</Text>
                </View>
            )}
            {bars.map((b, i) => (
                <View key={b.key} style={styles.row}>
                    <Text style={styles.catLabel}>{t(b.labelKey)}</Text>
                    <DivergingBar bar={b} index={i} colors={colors} styles={styles} />
                    <Text style={styles.tip}>{t(b.tipKey, b.tipParams)}</Text>
                </View>
            ))}
        </View>
    );
}

function DivergingBar({ bar, index, colors, styles }: { bar: PlanningBar; index: number; colors: AppTheme; styles: Styles }) {
    const pos = bar.bar > 0;
    const target = Math.round(Math.abs(bar.bar) * 100);
    // Grow the fill from the zero-line AFTER the sheet has finished opening
    // (SheetOpenedContext), staggered per bar so it reads as a quick sequence.
    const opened = useContext(SheetOpenedContext);
    const anim = useSharedValue(0);
    useAnimatedReaction(
        () => opened?.value ?? false,
        (v, prev) => { if (v && !prev) anim.value = withDelay(index * 70, withTiming(1, { duration: 340 })); },
        [index],
    );
    const fillStyle = useAnimatedStyle(() => ({ width: `${target * anim.value}%` }));
    return (
        <View style={styles.track}>
            <View style={[styles.half, styles.halfLeft]}>
                {bar.available && !pos && bar.bar < 0 && (
                    <Animated.View style={[styles.fill, styles.fillLeft, fillStyle, { backgroundColor: withAlpha(colors.error, 0.9) }]} />
                )}
            </View>
            <View style={styles.center} />
            <View style={[styles.half, styles.halfRight]}>
                {bar.available && pos && (
                    <Animated.View style={[styles.fill, fillStyle, { backgroundColor: withAlpha(colors.success, 0.9) }]} />
                )}
            </View>
        </View>
    );
}

type Styles = ReturnType<typeof makeStyles>;

const BAR_H = 12;

const makeStyles = (c: AppTheme) => StyleSheet.create({
    body: { paddingHorizontal: spacing.lg, gap: spacing.lg, paddingTop: spacing.xs },
    banner: {
        backgroundColor: withAlpha(c.success, 0.14), borderRadius: radius.md,
        paddingVertical: spacing.sm, paddingHorizontal: spacing.md, alignItems: 'center',
    },
    bannerText: { ...typography.bodySmallStrong, color: c.success },
    row: { gap: spacing.sm },
    catLabel: { ...typography.bodyStrong, color: c.textPrimary },
    // Diverging track: two equal halves around a hairline centre; the fill grows
    // out from the centre (right/green or left/red).
    track: { flexDirection: 'row', alignItems: 'center', height: BAR_H },
    // Track halves are flat where they meet the centre zero-line, rounded only on
    // the outer end — matching the fills, so the whole thing reads as one bar.
    half: { flex: 1, height: BAR_H, justifyContent: 'center', backgroundColor: withAlpha(c.textMuted, 0.1) },
    halfLeft: { borderTopLeftRadius: BAR_H / 2, borderBottomLeftRadius: BAR_H / 2 },
    halfRight: { borderTopRightRadius: BAR_H / 2, borderBottomRightRadius: BAR_H / 2 },
    center: { width: 2, height: BAR_H + 4, backgroundColor: c.border, borderRadius: 1 },
    // Bars, not sliders: the end touching the centre zero-line is flat; only the
    // OUTER end is rounded. Base = green (grows right) → round the right end.
    fill: { height: BAR_H, borderTopRightRadius: BAR_H / 2, borderBottomRightRadius: BAR_H / 2 },
    // Red (grows left) → flatten the right end, round the left end instead.
    fillLeft: {
        alignSelf: 'flex-end',
        borderTopRightRadius: 0, borderBottomRightRadius: 0,
        borderTopLeftRadius: BAR_H / 2, borderBottomLeftRadius: BAR_H / 2,
    },
    tip: { ...typography.bodySmall, color: c.textSecondary },
});
