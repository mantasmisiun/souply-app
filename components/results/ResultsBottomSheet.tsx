import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Pressable, ActivityIndicator, ScrollView, Dimensions, PanResponder } from 'react-native';
import Animated, { SlideInDown, SlideOutDown, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { spacing, radius, typography, iconSize, avatarSize, type AppTheme } from '../../constants/theme';
import { type SheetOption } from '../../utils/splitOptions';
import { ChainLogoChip } from '../ChainLogoChip';
import { chainBrandName } from '../../utils/chainBrandName';
import { formatEuro } from '../../utils/formatCurrency';
import { useTranslation } from 'react-i18next';

// SheetOption lives in utils/splitOptions (pure + unit-tested). Re-export so
// existing imports from this component keep working.
export type { SheetOption };

const SCREEN_H = Dimensions.get('window').height;
const PEEK_GAP = 26;   // sliver of the next card shown when collapsed

/** "1.4 km" / "850 m" — distance display, switching to metres under 1 km. Units
 *  are universal, so no translation needed. */
function formatDistance(km: number): string {
    return km < 1 ? `${Math.round(km * 100) * 10} m` : `${km.toFixed(1)} km`;
}


/** Circular chain badge — the same baked pin asset used on the map markers. */
// Thin wrapper over the shared ChainLogoChip so the sheet and the map pill draw
// the chain badge identically (glyph on its brand-coloured disc).
function ChainLogo({ chainId, chainName, size }: {
    chainId: number; chainName: string; size: number; colors?: AppTheme;
}) {
    return <ChainLogoChip chainId={chainId} name={chainName} size={size} />;
}

function Radio({ selected, colors }: { selected: boolean; colors: AppTheme }) {
    return (
        <View style={[styles_radio.ring, { borderColor: selected ? colors.primary : colors.border }]}>
            {selected && <View style={[styles_radio.dot, { backgroundColor: colors.primary }]} />}
        </View>
    );
}
const styles_radio = StyleSheet.create({
    ring: { width: 22, height: 22, borderRadius: radius.pill, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
    dot: { width: 11, height: 11, borderRadius: radius.pill },
});

/** A selectable combo (or baseline single) row with a radio, in the multi sheet. */
function OptionCard({ option, selected, styles, colors, onPress, onLayout }: {
    option: SheetOption; selected: boolean; styles: Styles; colors: AppTheme;
    onPress: () => void; onLayout?: (h: number) => void;
}) {
    const { t } = useTranslation();
    const multi = option.stores.length > 1;
    return (
        <Pressable
            onPress={onPress}
            onLayout={onLayout ? e => onLayout(e.nativeEvent.layout.height) : undefined}
            style={[styles.card, selected && styles.cardSelected]}
        >
            <View style={styles.cardTopRow}>
                <Radio selected={selected} colors={colors} />
                {multi ? (
                    <View style={styles.logoStack}>
                        {option.stores.map((s, i) => (
                            <View key={s.storeId} style={i > 0 ? { marginLeft: -spacing.lg } : undefined}>
                                <ChainLogo chainId={s.chainId} chainName={s.chainName} size={avatarSize.md} colors={colors} />
                            </View>
                        ))}
                    </View>
                ) : (
                    <ChainLogo chainId={option.stores[0].chainId} chainName={option.stores[0].chainName} size={avatarSize.md} colors={colors} />
                )}
                <View style={styles.cardMid}>
                    {multi ? (
                        <>
                            <Text style={styles.cardTitle}>{t('results.sheet.storesPlural', { count: option.stores.length })}</Text>
                            <View style={styles.cardBadgeRow}>
                                {option.detourKm != null && option.detourKm > 0 && (
                                    <View style={[styles.metaChip, styles.detourChip]}>
                                        <Ionicons name="navigate-outline" size={iconSize.xs} color={colors.warning} />
                                        <Text style={[styles.metaText, styles.detourChipText]} allowFontScaling={false}>{`+ ${formatDistance(option.detourKm)}`}</Text>
                                    </View>
                                )}
                                {option.saving > 0 && (
                                    <View style={[styles.metaChip, styles.savingChip]}>
                                        <Ionicons name="pricetag-outline" size={iconSize.xs} color={colors.success} />
                                        <Text style={[styles.metaText, styles.savingChipText]} allowFontScaling={false}>{`- ${formatEuro(option.saving)}`}</Text>
                                    </View>
                                )}
                            </View>
                        </>
                    ) : (
                        <>
                            <Text style={styles.cardTitle} numberOfLines={1}>{chainBrandName(option.stores[0].chainName)}</Text>
                            <Text style={styles.cardSub} numberOfLines={1}>{t('results.sheet.onlyHere')}</Text>
                            {Number.isFinite(option.stores[0].distance) && option.stores[0].distance > 0 && (
                                <View style={[styles.metaChip, styles.cardMetaChip]}>
                                    <Ionicons name="navigate-outline" size={iconSize.xs} color={colors.textMuted} />
                                    <Text style={styles.metaText}>{formatDistance(option.stores[0].distance)}</Text>
                                </View>
                            )}
                        </>
                    )}
                </View>
                <Text style={styles.price} allowFontScaling={false}>{formatEuro(option.total)}</Text>
            </View>

            {multi && option.combo && (
                <View style={styles.breakdown}>
                    {option.stores.map(s => {
                        const count = Object.values(option.combo!.itemAssignments).filter(sid => sid === s.storeId).length;
                        return (
                            <Text key={s.storeId} style={styles.breakdownLine} numberOfLines={1}>
                                <Text style={styles.breakdownChain}>{chainBrandName(s.chainName)}</Text>
                                {`  ${t('results.sheet.items', { count })} · ${s.storeAddress}`}
                            </Text>
                        );
                    })}
                </View>
            )}
        </Pressable>
    );
}

type Props = {
    options: SheetOption[];
    selectedKey: string | null;
    onSelect: (key: string) => void;
    onClose: () => void;
    onNavigate: () => void;
    onCreateList: () => void;
    creatingList: boolean;
    colors: AppTheme;
    bottomInset: number;
    /** Reports the sheet's current settled height so the map can keep content
     *  in the visible area above it. */
    onHeightChange?: (height: number) => void;
};

type Styles = ReturnType<typeof makeStyles>;

/** Vykti + Pirkinių sąrašas — shared action row, always fully visible. */
function Actions({ styles, colors, creatingList, onNavigate, onCreateList, bottomInset }: {
    styles: Styles; colors: AppTheme; creatingList: boolean;
    onNavigate: () => void; onCreateList: () => void; bottomInset: number;
}) {
    const { t } = useTranslation();
    return (
        <View style={[styles.actions, { paddingBottom: Math.max(bottomInset, spacing.md) + spacing.sm }]}>
            <TouchableOpacity style={styles.navigateBtn} onPress={onNavigate}>
                <Ionicons name="navigate-outline" size={iconSize.md} color={colors.primary} />
                <Text style={styles.navigateText}>{t('results.sheet.navigate')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.listBtn} onPress={onCreateList} disabled={creatingList}>
                {creatingList
                    ? <ActivityIndicator size="small" color={colors.onPrimary} />
                    : <Ionicons name="list-outline" size={iconSize.md} color={colors.onPrimary} />}
                <Text style={styles.listText}>{creatingList ? t('results.sheet.creating') : t('results.sheet.createList')}</Text>
            </TouchableOpacity>
        </View>
    );
}

export default function ResultsBottomSheet(props: Props) {
    const { options } = props;
    // A single store with no worthwhile split → the elegant single card.
    // Anything with combos → the resizable radio-card list.
    return options.length <= 1
        ? <SingleSheet {...props} />
        : <MultiSheet {...props} />;
}

/* ── Single-store: one beautiful auto-height card (never clips). ─────────── */
function SingleSheet({ options, onNavigate, onCreateList, creatingList, colors, bottomInset, onHeightChange }: Props) {
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { t } = useTranslation();
    const store = options[0]?.stores[0];
    if (!store) return null;
    return (
        <Animated.View
            entering={SlideInDown.duration(240)}
            exiting={SlideOutDown.duration(180)}
            style={styles.sheet}
            onLayout={e => onHeightChange?.(e.nativeEvent.layout.height)}
        >
            {/* No drag pill: the single-store sheet is auto-height and can't
                expand, so a handle would imply a gesture that does nothing.
                Keep the area for top breathing room under the rounded corners. */}
            <View style={styles.handleArea} />
            <View style={styles.singlePad}>
                <View style={styles.singleHeader}>
                    <ChainLogo chainId={store.chainId} chainName={store.chainName} size={avatarSize.lg} colors={colors} />
                    <View style={styles.singleMid}>
                        <Text style={styles.singleTitle} numberOfLines={1}>{chainBrandName(store.chainName)}</Text>
                        <Text style={styles.singleAddr} numberOfLines={1}>{store.storeAddress}</Text>
                    </View>
                    <Text style={styles.singlePrice} allowFontScaling={false}>{formatEuro(options[0].total)}</Text>
                </View>

                <View style={styles.metaRow}>
                    {Number.isFinite(store.distance) && store.distance > 0 && (
                        <View style={styles.metaChip}>
                            <Ionicons name="navigate-outline" size={iconSize.xs} color={colors.textMuted} />
                            <Text style={styles.metaText}>{formatDistance(store.distance)}</Text>
                        </View>
                    )}
                    {store.isApproximated && (
                        <View style={styles.metaChip}>
                            <Ionicons name="sparkles-outline" size={iconSize.xs} color={colors.textMuted} />
                            <Text style={styles.metaText}>{t('results.sheet.approxPrice')}</Text>
                        </View>
                    )}
                    {store.missingItemNames.length > 0 && (
                        <View style={[styles.metaChip, styles.warnChip]}>
                            <Ionicons name="alert-circle-outline" size={iconSize.xs} color={colors.warning} />
                            <Text style={[styles.metaText, { color: colors.warning }]}>{t('results.sheet.missing', { count: store.missingItemNames.length })}</Text>
                        </View>
                    )}
                </View>
            </View>

            <Actions styles={styles} colors={colors} creatingList={creatingList}
                onNavigate={onNavigate} onCreateList={onCreateList} bottomInset={bottomInset} />
        </Animated.View>
    );
}

const HANDLE_H = 30;        // drag affordance height
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/* ── Multi-option: draggable 3-stage sheet; action bar always pinned. ────── */
function MultiSheet({ options, selectedKey, onSelect, onNavigate, onCreateList, creatingList, colors, bottomInset, onHeightChange }: Props) {
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const [firstCardH, setFirstCardH] = useState(120);
    const [contentH, setContentH] = useState(0);
    const [actionsH, setActionsH] = useState(90);
    const [stage, setStage] = useState(0);
    // Bumped on each user snap so the settle effect animates even to the SAME
    // stage (a small drag that releases back).
    const [settleTick, setSettleTick] = useState(0);

    // Snap points, ascending sheet heights: peek (top card + a sliver), an
    // optional MIDDLE stage (scroll the list while the map stays visible so
    // tapping a result shows on the map), and full (whole list, capped). The
    // action bar is a fixed sibling counted in every height → never clipped.
    const snaps = useMemo(() => {
        const full = Math.min(HANDLE_H + contentH + actionsH, SCREEN_H * 0.85);
        const peek = Math.min(HANDLE_H + firstCardH + PEEK_GAP + actionsH, full);
        const mid = clamp(HANDLE_H + actionsH + SCREEN_H * 0.42, peek, full);
        const pts = [peek];
        if (mid > peek + 48 && full > mid + 48) pts.push(mid);
        if (full > peek + 48) pts.push(full);
        return pts;
    }, [firstCardH, contentH, actionsH]);

    const safeStage = Math.min(stage, snaps.length - 1);

    const height = useSharedValue(snaps[0]);
    const dragging = useRef(false);
    const startH = useRef(snaps[0]);
    const snapsRef = useRef(snaps); snapsRef.current = snaps;
    const stageRef = useRef(safeStage); stageRef.current = safeStage;
    // Slide-in is driven by this shared value (NOT reanimated's `entering`
    // layout animation). A layout animation + an animated `height` on the same
    // node fight on Fabric — the entering snapshot pins the height, so the
    // measured peek never applies until you tap. Owning both the slide and the
    // height in ONE animated style avoids that entirely.
    const slideY = useSharedValue(SCREEN_H * 0.85);
    const sheetStyle = useAnimatedStyle(() => ({
        height: height.value,
        transform: [{ translateY: slideY.value }],
    }));
    useEffect(() => { slideY.value = withTiming(0, { duration: 260 }); }, [slideY]);

    // ANIMATE to the current stage on a user action (snap / tap / collapse) —
    // tracked by safeStage + a settle tick so even a same-stage release snaps
    // back. Reads snaps via ref, so a measurement-only change does NOT re-fire
    // here (re-animating toward a settling `full` is what made it "drag on").
    useEffect(() => {
        if (dragging.current) return;
        const s = snapsRef.current;
        height.value = withTiming(s[Math.min(stageRef.current, s.length - 1)], { duration: 220 });
    }, [safeStage, settleTick, height]);

    // SETTLE INSTANTLY when measurements change the snap heights (first card /
    // actions / content height land a frame after mount). Instant → fixes the
    // "opens clipped, tap to fix" case without animating toward a moving target.
    useEffect(() => {
        if (dragging.current) return;
        height.value = snaps[Math.min(stageRef.current, snaps.length - 1)];
    }, [snaps, height]);

    // New store's options → collapse back to peek (the animate effect runs it).
    useEffect(() => { setStage(0); }, [options]);

    // Report the settled stage height so the map can frame content above us.
    useEffect(() => { onHeightChange?.(snaps[safeStage]); }, [safeStage, snaps, onHeightChange]);

    const pan = useMemo(() => PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 3,
        onPanResponderGrant: () => { dragging.current = true; startH.current = height.value; },
        onPanResponderMove: (_, g) => {
            const s = snapsRef.current;
            // Clamp between peek and full — dragging down never closes the sheet
            // (tapping the map deselects; that's the only dismiss).
            height.value = clamp(startH.current - g.dy, s[0], s[s.length - 1]);
        },
        onPanResponderRelease: (_, g) => {
            dragging.current = false;
            const s = snapsRef.current;
            const tap = Math.abs(g.dy) < 5 && Math.abs(g.dx) < 5;
            if (tap) { // cycle peek → mid → full → peek
                setStage((stageRef.current + 1) % s.length);
                setSettleTick(t => t + 1);
                return;
            }
            // Snap to the nearest height, nudged one stage by a flick's direction.
            const h = height.value;
            let idx = 0, best = Infinity;
            s.forEach((v, i) => { const d = Math.abs(v - h); if (d < best) { best = d; idx = i; } });
            if (g.vy < -0.5 && idx < s.length - 1) idx++;
            else if (g.vy > 0.5 && idx > 0) idx--;
            setStage(idx);
            setSettleTick(t => t + 1);
        },
        onPanResponderTerminate: () => {
            dragging.current = false;
            setSettleTick(t => t + 1);
            const s = snapsRef.current;
            height.value = withTiming(s[Math.min(stageRef.current, s.length - 1)], { duration: 220 });
        },
    }), [height]);

    return (
        <Animated.View style={[styles.sheet, sheetStyle]}>
            <View style={styles.handleArea} {...pan.panHandlers}>
                <View style={styles.handle} />
            </View>

            <ScrollView
                style={styles.list}
                contentContainerStyle={styles.listContent}
                showsVerticalScrollIndicator={safeStage > 0}
                scrollEnabled={safeStage > 0}
                onContentSizeChange={(_, h) => setContentH(h)}
            >
                {options.map((opt, i) => (
                    <OptionCard
                        key={opt.key}
                        option={opt}
                        selected={selectedKey === opt.key}
                        styles={styles}
                        colors={colors}
                        onPress={() => onSelect(opt.key)}
                        onLayout={i === 0 ? setFirstCardH : undefined}
                    />
                ))}
            </ScrollView>

            <View onLayout={e => setActionsH(e.nativeEvent.layout.height)}>
                <Actions styles={styles} colors={colors} creatingList={creatingList}
                    onNavigate={onNavigate} onCreateList={onCreateList} bottomInset={bottomInset} />
            </View>
        </Animated.View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    sheet: {
        position: 'absolute', left: 0, right: 0, bottom: 0,
        backgroundColor: c.cardBackground,
        borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
        overflow: 'hidden',
        // Upward sheet shadow (negative offset) — bespoke, not an elevation tier.
        elevation: 16, shadowColor: '#000', shadowOffset: { width: 0, height: -3 }, shadowOpacity: 0.18, shadowRadius: 10,
    },
    // Generous drag target; the visible pill sits centred within it.
    handleArea: { height: HANDLE_H, alignItems: 'center', justifyContent: 'center' },
    handle: { width: 44, height: 5, borderRadius: radius.pill, backgroundColor: c.border },

    list: { flex: 1 },
    listContent: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs, paddingBottom: spacing.sm },

    // ── Single-store card ──
    singlePad: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.lg },
    singleHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    singleMid: { flex: 1, paddingRight: spacing.sm },
    singleTitle: { ...typography.bodyStrong, fontWeight: '700', color: c.textPrimary },
    singleAddr: { ...typography.caption, color: c.textMuted, marginTop: 2 },
    // Price is a bespoke display figure — no type token in the 4-pt scale fits.
    singlePrice: { fontSize: 22, fontWeight: '800', color: c.primary },
    metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
    metaChip: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.xs,
        backgroundColor: c.surfaceMuted, borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs,
    },
    warnChip: { backgroundColor: c.warningMuted },
    // metaChip used as a standalone badge inside an OptionCard column.
    cardMetaChip: { alignSelf: 'flex-start', marginTop: spacing.xs },
    // Decision badges on the multi-store card: detour (amber, a cost) + saving
    // (green, the win), side by side and vivid for a quick glance.
    cardBadgeRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
    detourChip: { backgroundColor: c.warningMuted },
    detourChipText: { color: c.warning, fontWeight: '700' },
    savingChip: { backgroundColor: c.successMuted },
    savingChipText: { color: c.success, fontWeight: '700' },
    metaText: { ...typography.label, color: c.textMuted },

    // ── Option (radio) card ──
    card: {
        backgroundColor: c.cardBackground, borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.sm,
        borderWidth: 1.5, borderColor: c.border,
    },
    cardSelected: { borderColor: c.primary, backgroundColor: c.primaryMuted ?? c.surfaceMuted },
    cardTopRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    logoStack: { flexDirection: 'row', alignItems: 'center' },
    cardMid: { flex: 1 },
    cardTitle: { ...typography.bodyStrong, fontWeight: '700', color: c.textPrimary },
    cardSub: { ...typography.caption, color: c.textMuted, marginTop: 2 },
    saving: { ...typography.label, fontWeight: '700', color: c.success, marginTop: 2 },
    // Price is a bespoke display figure — no type token in the 4-pt scale fits.
    price: { fontSize: 19, fontWeight: '800', color: c.primary },

    breakdown: { marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, gap: spacing.xs },
    breakdownLine: { ...typography.caption, color: c.textSecondary },
    breakdownChain: { fontWeight: '700', color: c.textPrimary },
    breakdownDist: { ...typography.caption, color: c.textMuted, marginTop: 2 },

    // ── Actions ──
    actions: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
    navigateBtn: {
        flex: 1, borderWidth: 1, borderColor: c.primary, borderRadius: radius.pill,
        paddingVertical: spacing.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
    },
    navigateText: { ...typography.bodyStrong, color: c.primary },
    listBtn: {
        flex: 2, backgroundColor: c.primary, borderRadius: radius.pill,
        paddingVertical: spacing.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
    },
    listText: { ...typography.bodyStrong, fontWeight: '700', color: c.onPrimary },
});
