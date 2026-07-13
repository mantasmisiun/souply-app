import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    Pressable,
    Dimensions,
    Platform,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import Animated, { SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { GlassStageSheet, SHEET_HANDLE_H, type GlassStageSheetRef } from '../GlassStageSheet';
import { Ionicons } from '@expo/vector-icons';
import { spacing, radius, typography, iconSize, avatarSize, type AppTheme } from '../../constants/theme';
import { type SheetOption } from '../../utils/splitOptions';
import { ChainLogoChip } from '../ChainLogoChip';
import { chainBrandName } from '../../utils/chainBrandName';
import { formatEuro } from '../../utils/formatCurrency';
import { useTranslation } from 'react-i18next';
import { LiquidGlass } from '../LiquidGlass';
import { concentricRadius } from '../../utils/displayCorners';

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

/** A selectable combo (or baseline single) row with a radio, in the multi sheet. */
// MEMOIZED with a stable onSelect(key) interface: every stage settle re-renders
// MultiSheet on the JS thread right as the release spring runs on the UI thread
// — without memo all cards re-rendered each time (an inline onPress closure per
// card defeated any bail-out). Now only the cards whose `selected` flips render.
const OptionCard = React.memo(function OptionCard({ option, selected, styles, colors, onSelect, onLayout }: {
    option: SheetOption; selected: boolean; styles: Styles; colors: AppTheme;
    onSelect: (key: string) => void; onLayout?: (h: number) => void;
}) {
    const { t } = useTranslation();
    const multi = option.stores.length > 1;
    return (
        <Pressable
            onPress={() => onSelect(option.key)}
            onLayout={onLayout ? e => onLayout(e.nativeEvent.layout.height) : undefined}
            style={[styles.card, selected && styles.cardSelected]}
        >
            {/* Plain translucent wash, NOT a glass surface: the native glass
                material draws specular rim highlights on the corners (the
                "lighter top-left / bottom-right edges") which we don't want on
                the cards — and the sheet beneath is already frosted, so the
                cards need no blur of their own to read as glassy. */}
            <View style={styles.cardGlass}>
            <View style={styles.cardTopRow}>
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
                                <View style={[styles.metaChip, styles.cardMetaChip, styles.savingChip]}>
                                    <Ionicons name="navigate-outline" size={iconSize.xs} color={colors.success} />
                                    <Text style={[styles.metaText, styles.savingChipText]}>{formatDistance(option.stores[0].distance)}</Text>
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
            </View>
        </Pressable>
    );
});

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
    // The sheet floats ABOVE the home indicator now, so the bar needs no inset
    // padding of its own (bottomInset positions the whole sheet instead).
    void bottomInset;
    return (
        <View style={[styles.actions, { paddingBottom: spacing.md }]}>
            <TouchableOpacity style={styles.navigateBtn} onPress={onNavigate}>
                <Ionicons name="navigate-outline" size={iconSize.md} color={colors.primary} />
                <Text style={styles.navigateText}>{t('results.sheet.navigate')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.listBtn} onPress={onCreateList} disabled={creatingList}>
                {creatingList
                    ? <MaterialProgress size="small" color={colors.onPrimary} />
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
    const bottomOffset = spacing.sm; // match the side margins (see MultiSheet)
    const cornerR = concentricRadius(bottomInset, spacing.sm); // concentric with the display
    return (
        <Animated.View
            entering={SlideInDown.duration(240)}
            exiting={SlideOutDown.duration(180)}
            style={[styles.sheet, { bottom: bottomOffset, borderRadius: cornerR }]}
            onLayout={e => onHeightChange?.(e.nativeEvent.layout.height + bottomOffset)}
        >
            <LiquidGlass fallback="blur" style={[styles.sheetGlass, { borderRadius: cornerR }]}>
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
            </LiquidGlass>
        </Animated.View>
    );
}

const HANDLE_H = 30;        // drag affordance height (styles.handleArea — SingleSheet)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/* ── Multi-option: draggable 3-stage sheet on the shared GlassStageSheet. ──
   All stage machinery (worklet drag, glass frame, transform-only slide, the
   stage-3 edge dock) lives in components/GlassStageSheet — this is just the
   results-specific content: snap-point math, the option cards and the action
   bar. */
function MultiSheet({ options, selectedKey, onSelect, onNavigate, onCreateList, creatingList, colors, bottomInset, onHeightChange }: Props) {
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const [firstCardH, setFirstCardH] = useState(120);
    const [contentH, setContentH] = useState(0);
    const [actionsH, setActionsH] = useState(90);
    const sheetRef = useRef<GlassStageSheetRef>(null);

    // Snap points (Find-My-style detents), ascending: BAR (grabber pill + the
    // floating action bar), PEEK (top card + a sliver), an optional MID stage
    // (scroll the list while the map stays visible), and FULL — always the
    // near-top detent; the shared sheet docks it edge-to-edge (dockAtLast).
    const snaps = useMemo(() => {
        const bar = SHEET_HANDLE_H + actionsH;
        const full = SCREEN_H * 0.85;
        const peek = Math.min(bar + firstCardH + PEEK_GAP, full);
        const mid = clamp(Math.min(bar + contentH, bar + SCREEN_H * 0.42), peek, full);
        const pts = [bar];
        if (peek > bar + 40) pts.push(peek);
        if (mid > peek + 48 && full > mid + 48) pts.push(mid);
        if (full > peek + 48) pts.push(full);
        return pts;
    }, [firstCardH, contentH, actionsH]);

    // New store's options → back to peek.
    useEffect(() => { sheetRef.current?.snapTo(1); }, [options]);

    return (
        <GlassStageSheet
            ref={sheetRef}
            snaps={snaps}
            initialStage={1}
            colors={colors}
            bottomInset={bottomInset}
            dockAtLast
            exitSlide
            onHeightChange={onHeightChange}
            onBarHeight={setActionsH}
            onContentHeight={setContentH}
            contentContainerStyle={styles.listContent}
            bar={
                <Actions styles={styles} colors={colors} creatingList={creatingList}
                    onNavigate={onNavigate} onCreateList={onCreateList} bottomInset={bottomInset} />
            }
        >
            {options.map((opt, i) => (
                <OptionCard
                    key={opt.key}
                    option={opt}
                    selected={selectedKey === opt.key}
                    styles={styles}
                    colors={colors}
                    onSelect={onSelect}
                    onLayout={i === 0 ? setFirstCardH : undefined}
                />
            ))}
        </GlassStageSheet>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    // Single-store sheet (auto-height, not animated) keeps the one-piece panel.
    sheet: {
        position: 'absolute', left: spacing.sm, right: spacing.sm, bottom: 0,
        borderRadius: radius.xl,
        shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 12,
    },
    sheetGlass: {
        flex: 1, borderRadius: radius.xl, overflow: 'hidden',
        // Painted hairline ONLY for the Android blur fallback (needs edge
        // definition). iOS native glass carries its own system edge treatment —
        // a border on top diverges from the default material look.
        ...(Platform.OS === 'android'
            ? { borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(120,120,128,0.24)' as const }
            : null),
        // Android: expo-blur renders a translucent wash, not a real blur — give it
        // a tinted body (and elevation, which needs a background to draw) so the
        // sheet keeps contrast over the map. iOS glass strips this automatically.
        backgroundColor: Platform.OS === 'android' ? c.cardBackground + 'F2' : 'transparent',
        elevation: 16,
    },
    // Top breathing room under the rounded corners (SingleSheet only — the
    // draggable sheet's pill lives in GlassStageSheet).
    handleArea: { height: HANDLE_H, alignItems: 'center', justifyContent: 'center' },

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
    // Chips over glass: translucent capsules (Apple's fill-on-material look) —
    // a neutral systemGray wash for plain badges, the semantic color at low
    // alpha for detour/saving, pill-rounded. Opaque *Muted tokens looked flat
    // and foreign on the liquid-glass cards.
    metaChip: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.xs,
        backgroundColor: 'rgba(120,120,128,0.16)', borderRadius: radius.pill,
        paddingHorizontal: spacing.sm, paddingVertical: spacing.xs,
    },
    warnChip: { backgroundColor: c.warning + '2E' },
    // metaChip used as a standalone badge inside an OptionCard column.
    cardMetaChip: { alignSelf: 'flex-start', marginTop: spacing.xs },
    // Decision badges on the multi-store card: detour (amber, a cost) + saving
    // (green, the win), side by side and vivid for a quick glance.
    cardBadgeRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
    detourChip: { backgroundColor: c.warning + '2E' },
    detourChipText: { color: c.warning, fontWeight: '700' },
    savingChip: { backgroundColor: c.success + '2E' },
    savingChipText: { color: c.success, fontWeight: '700' },
    metaText: { ...typography.label, color: c.textSecondary },

    // ── Option (radio) card ──
    card: {
        borderRadius: radius.lg, marginBottom: spacing.sm,
        // Borderless by default (the glass surface alone defines the card);
        // the width stays reserved so selecting doesn't shift the layout.
        borderWidth: 1.5, borderColor: 'transparent', overflow: 'hidden',
    },
    cardGlass: {
        borderRadius: radius.lg - 1.5, padding: spacing.md,
        // WHITE wash so the card reads LIGHTER than the sheet in both schemes
        // (white lightens whatever is beneath — same tint level the user OK'd).
        backgroundColor: 'rgba(255,255,255,0.12)',
    },
    // Selection = the pink ring only — no background tint over the glass.
    cardSelected: { borderColor: c.primary },
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
    actions: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
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
