import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Dimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import Animated, { useSharedValue, type SharedValue } from 'react-native-reanimated';
import { spacing, radius, typography, iconSize, avatarSize, type AppTheme } from '../../constants/theme';
import { type SheetOption } from '../../utils/splitOptions';
import { ChainLogoChip } from '../ChainLogoChip';
import { chainBrandName } from '../../utils/chainBrandName';
import { formatEuro } from '../../utils/formatCurrency';
import { DockedGlassSheet, type DockedSheetControls } from '../DockedGlassSheet';
import { SheetCard } from '../SheetCard';
import { DockActionCard } from '../dock/DockActionCard';
import { dockBarBase, dockContentBase } from '../dock/dockLayout';
import { useDockTitleStyle } from '../dock/useDockTitleStyle';

const SCREEN_H = Dimensions.get('window').height;

/** "1.4 km" / "850 m" — metres under 1 km. Units are universal (no i18n). */
function formatDistance(km: number): string {
    return km < 1 ? `${Math.round(km * 100) * 10} m` : `${km.toFixed(1)} km`;
}

type Styles = ReturnType<typeof makeStyles>;

/**
 * Store-tap dock — the SAME DockedGlassSheet scaffold as the map's main dock
 * (see components/dock/*), reskinned for a selected store:
 *   • bar   → an INFO bar for the current option (chain/stores + price); the
 *             title grows with the sheet exactly like the main dock's.
 *   • sheet → opens at medium on tap and holds two big action cards (Navigate +
 *             List, in the Basket/Invite style) and a "Stores" section: one
 *             option for a single store, or the split options (single last) with
 *             the selected one ringed pink.
 */
type Props = {
    options: SheetOption[];
    selectedKey: string | null;
    onSelect: (key: string) => void;
    onNavigate: () => void;
    onCreateList: () => void;
    creatingList: boolean;
    /** Whole-journey distance (origin → stores → [route end]) for Navigate. */
    journeyKm: number | null;
    /** Basket item count for the List subtitle. */
    itemCount: number;
    colors: AppTheme;
    /** UI-thread flag the map reads to freeze its pan while the dock is dragged. */
    dragActiveSV: SharedValue<boolean>;
    /** Called when a touch begins on the dock → the host ignores the map's
     *  leaked onPress for the same tap (else selecting an option deselects). */
    onInteract: () => void;
    /** Sheet detent (0 = collapsed bar, >0 = open). The host makes the map
     *  non-interactive while it's open so sheet touches never reach the map. */
    onStageChange?: (stage: number) => void;
    /** The map's native gesture ref → the dock pan blocks it on the native
     *  thread, so a drag beginning on the bar can't pan the map underneath. */
    blockGestureRef?: { current: unknown } | null;
    /** Collapsed dock height → the map keeps content above the bar. */
    onCollapsedClearance?: (px: number) => void;
    /** Map occlusion (grows with the stage) → the tapped store frames above it. */
    onOcclusionChange?: (px: number) => void;
};

export default function StoreOptionsDock({
    options, selectedKey, onSelect, onNavigate, onCreateList, creatingList,
    journeyKm, itemCount, colors, dragActiveSV, onInteract, onStageChange, blockGestureRef,
    onCollapsedClearance, onOcclusionChange,
}: Props) {
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const dockRef = useRef<DockedSheetControls>(null);
    const [barH, setBarH] = useState(52);
    const collapsedRef = useRef(120);
    const progress = useSharedValue(0);
    const titleStyle = useDockTitleStyle(progress);
    // >1 option ⇒ the tapped store has split alternatives → a selectable list.
    const multi = options.length > 1;
    // The option the bar/actions reflect (the picked one, else the best).
    const current = options.find(o => o.key === selectedKey) ?? options[0];

    // A newly tapped store (new option set) → open the sheet to medium so the
    // actions + store options are immediately in view.
    useEffect(() => { dockRef.current?.snapTo(1); }, [options]);

    // Stamp the interaction ref SYNCHRONOUSLY on touch-down (capture phase, before
    // the map's leaked onPress on release) — returning false so children still
    // handle the tap. This is race-free, unlike the pan's runOnJS(onTouchStart).
    const noteTouch = () => { onInteract(); return false; };

    const barRow = (
        <View
            style={styles.bar}
            onStartShouldSetResponderCapture={noteTouch}
            onLayout={e => { const h = Math.round(e.nativeEvent.layout.height); if (h > 0) setBarH(h); }}
        >
            <StoreLogos stores={current.stores} size={avatarSize.sm} styles={styles} />
            <Animated.Text style={[styles.barTitle, titleStyle]} numberOfLines={1}>
                {optionTitle(current)}
            </Animated.Text>
            <Text style={styles.barPrice} allowFontScaling={false}>{formatEuro(current.total)}</Text>
        </View>
    );

    const content = (
        <View style={styles.content} onStartShouldSetResponderCapture={noteTouch}>
            {/* Navigate + List — the same big cards as Basket/Invite. */}
            <View style={styles.actionRow}>
                <DockActionCard
                    colors={colors}
                    icon="navigate-outline"
                    title={t('results.sheet.navigate')}
                    subtitle={journeyKm != null ? formatDistance(journeyKm) : '—'}
                    onPress={onNavigate}
                    onPressIn={onInteract}
                />
                <DockActionCard
                    colors={colors}
                    icon="list-outline"
                    title={t('results.sheet.list')}
                    subtitle={creatingList ? t('results.sheet.creating') : t('results.sheet.items', { count: itemCount })}
                    onPress={onCreateList}
                    onPressIn={onInteract}
                    disabled={creatingList}
                    loading={creatingList}
                />
            </View>

            {/* Store options — ONE grouped card (no "Stores" header): a single
                store, or the split options with the single-store option last.
                Rounded at the top/bottom, hairline-separated in between, the
                selected one tinted. */}
            <SheetCard style={styles.optGroup}>
                {options.map((opt, i) => (
                    <OptionItem
                        key={opt.key}
                        option={opt}
                        selected={selectedKey === opt.key}
                        selectable={multi}
                        divider={i > 0}
                        first={i === 0}
                        last={i === options.length - 1}
                        styles={styles}
                        colors={colors}
                        onSelect={onSelect}
                        onInteract={onInteract}
                        t={t}
                    />
                ))}
            </SheetCard>
        </View>
    );

    return (
        <DockedGlassSheet
            ref={dockRef}
            colors={colors}
            barAtTop
            progressSV={progress}
            dragActiveSV={dragActiveSV}
            blockScrollRef={blockGestureRef}
            onTouchStart={onInteract}
            onCollapsedClearance={px => { collapsedRef.current = px; onCollapsedClearance?.(px); }}
            barRowHeight={barH}
            barRow={barRow}
            sheet={{
                maxStage: 2,
                content,
                // Occlusion grows with the stage (the map clamps it to ~55 %, so
                // medium and full both report a large value); collapsed reports
                // just the bar height so the map reclaims the space.
                onStageChange: s => { onStageChange?.(s); onOcclusionChange?.(s <= 0 ? collapsedRef.current : Math.round(SCREEN_H * 0.6)); },
            }}
        />
    );
}

/** Bar/row title: the joined chain names ("Rimi · Maxima") for a split, or the
 *  single store's chain name. */
function optionTitle(option: SheetOption): string {
    return option.stores.map(s => chainBrandName(s.chainName)).join(' · ');
}

/** Overlapping chain badges (a stack for a split, a single badge otherwise). */
function StoreLogos({ stores, size, styles }: { stores: SheetOption['stores']; size: number; styles: Styles }) {
    if (stores.length === 1) {
        return <ChainLogoChip chainId={stores[0].chainId} name={stores[0].chainName} size={size} />;
    }
    return (
        <View style={styles.logoStack}>
            {stores.map((s, i) => (
                <View key={s.storeId} style={i > 0 ? styles.logoStacked : undefined}>
                    <ChainLogoChip chainId={s.chainId} name={s.chainName} size={size} />
                </View>
            ))}
        </View>
    );
}

/** One option row inside the grouped store card — a split (2/3 stores) or the
 *  single-store baseline. `divider` draws the hairline above every row but the
 *  first; the selected split is tinted. Memoized so a stage settle re-render
 *  only touches rows whose `selected` flips. */
const OptionItem = React.memo(function OptionItem({
    option, selected, selectable, divider, first, last, styles, colors, onSelect, onInteract, t,
}: {
    option: SheetOption; selected: boolean; selectable: boolean;
    divider: boolean; first: boolean; last: boolean;
    styles: Styles; colors: AppTheme; onSelect: (key: string) => void; onInteract: () => void; t: TFunction;
}) {
    const multi = option.stores.length > 1;
    const primary = option.stores[0];

    return (
        <TouchableOpacity
            activeOpacity={selectable ? 0.7 : 1}
            // NOT disabled even for a lone single option — the row must still be
            // the touch responder so onPressIn stamps the interaction (else the
            // tap leaks to the map's onPress and deselects). onSelect on a single
            // option is a harmless re-select.
            // Stamp SYNCHRONOUSLY on touch-down (before the map's leaked onPress
            // on release) — this row is the responder, so it always fires, unlike
            // the ancestor responder-capture that RNGH swallows.
            onPressIn={onInteract}
            onPress={() => onSelect(option.key)}
            style={[
                styles.optRow,
                first && styles.optRowFirst,
                last && styles.optRowLast,
                divider && styles.optDivider,
                selected && selectable && styles.optSelected,
            ]}
        >
            <StoreLogos stores={option.stores} size={avatarSize.md} styles={styles} />

            <View style={styles.optMid}>
                <Text style={styles.optTitle} numberOfLines={1}>{optionTitle(option)}</Text>
                {!multi && !!primary.storeAddress && (
                    <Text style={styles.optSub} numberOfLines={1}>{primary.storeAddress}</Text>
                )}
                <View style={styles.chipRow}>
                    {multi ? (
                        <>
                            {option.detourKm != null && option.detourKm > 0 && (
                                <View style={[styles.chip, styles.detourChip]}>
                                    <Ionicons name="navigate-outline" size={iconSize.xs} color={colors.warning} />
                                    <Text style={[styles.chipText, styles.detourText]} allowFontScaling={false}>{`+ ${formatDistance(option.detourKm)}`}</Text>
                                </View>
                            )}
                            {option.saving > 0 && (
                                <View style={[styles.chip, styles.savingChip]}>
                                    <Ionicons name="pricetag-outline" size={iconSize.xs} color={colors.success} />
                                    <Text style={[styles.chipText, styles.savingText]} allowFontScaling={false}>{`- ${formatEuro(option.saving)}`}</Text>
                                </View>
                            )}
                        </>
                    ) : (
                        <>
                            {Number.isFinite(primary.distance) && primary.distance > 0 && (
                                <View style={styles.chip}>
                                    <Ionicons name="navigate-outline" size={iconSize.xs} color={colors.textMuted} />
                                    <Text style={styles.chipText}>{formatDistance(primary.distance)}</Text>
                                </View>
                            )}
                            {primary.isApproximated && (
                                <View style={styles.chip}>
                                    <Ionicons name="sparkles-outline" size={iconSize.xs} color={colors.textMuted} />
                                    <Text style={styles.chipText}>{t('results.sheet.approxPrice')}</Text>
                                </View>
                            )}
                            {primary.missingItemNames.length > 0 && (
                                <View style={[styles.chip, styles.warnChip]}>
                                    <Ionicons name="alert-circle-outline" size={iconSize.xs} color={colors.warning} />
                                    <Text style={[styles.chipText, { color: colors.warning }]}>{t('results.sheet.missing', { count: primary.missingItemNames.length })}</Text>
                                </View>
                            )}
                        </>
                    )}
                </View>
            </View>

            <Text style={styles.optPrice} allowFontScaling={false}>{formatEuro(option.total)}</Text>
        </TouchableOpacity>
    );
});

const makeStyles = (c: AppTheme) => StyleSheet.create({
    // ── Info bar ──
    bar: dockBarBase,
    barTitle: { flex: 1, ...typography.bodyStrong, fontWeight: '700', color: c.textPrimary },
    barPrice: { fontSize: 18, fontWeight: '800', color: c.primary },

    // ── Content ──
    // Bottom pad so the last option row is never flush against the sheet's
    // bottom edge (where a tap could land on the map below instead).
    content: { ...dockContentBase, paddingBottom: spacing.lg },
    actionRow: { flexDirection: 'row', gap: 14 },

    // ── Store options — one grouped card ──
    // No inner padding: the rows span the full card width (wider). The first/last
    // rows round to match the card so a tinted end row doesn't poke square
    // corners past it (per-row rounding, so the card keeps its shadow).
    optGroup: { paddingHorizontal: 0, paddingBottom: 0 },
    logoStack: { flexDirection: 'row', alignItems: 'center' },
    // Deeper overlap so a split reads as one grouped badge, not two chips.
    logoStacked: { marginLeft: -18 },

    // Contiguous rows — a hairline divider between them (no gaps), the selected
    // split tinted.
    optRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 12, paddingHorizontal: 16 },
    optRowFirst: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
    optRowLast: { borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg },
    optDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
    optSelected: { backgroundColor: c.primaryMuted },
    optMid: { flex: 1 },
    optTitle: { ...typography.bodyStrong, fontWeight: '700', color: c.textPrimary },
    optSub: { ...typography.caption, color: c.textMuted, marginTop: 2 },
    optPrice: { fontSize: 18, fontWeight: '800', color: c.primary },

    // Badges — one row below the title.
    chipRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
    chip: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.xs,
        backgroundColor: 'rgba(120,120,128,0.16)', borderRadius: radius.pill,
        paddingHorizontal: spacing.sm, paddingVertical: spacing.xs,
    },
    chipText: { ...typography.label, color: c.textSecondary },
    warnChip: { backgroundColor: c.warning + '2E' },
    detourChip: { backgroundColor: c.warning + '2E' },
    detourText: { color: c.warning, fontWeight: '700' },
    savingChip: { backgroundColor: c.success + '2E' },
    savingText: { color: c.success, fontWeight: '700' },
});
