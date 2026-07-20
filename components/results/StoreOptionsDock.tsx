import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Dimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useSharedValue } from 'react-native-reanimated';
import { spacing, radius, typography, iconSize, avatarSize, type AppTheme } from '../../constants/theme';
import { type SheetOption } from '../../utils/splitOptions';
import { ChainLogoChip } from '../ChainLogoChip';
import { chainBrandName } from '../../utils/chainBrandName';
import { formatEuro } from '../../utils/formatCurrency';
import { DockedGlassSheet, type DockedSheetControls } from '../DockedGlassSheet';
import { SheetCard } from '../SheetCard';
import { DockActionCard } from '../dock/DockActionCard';
import { dockBarBase, dockContentBase } from '../dock/dockLayout';

const SCREEN_H = Dimensions.get('window').height;

/** "1.4 km" / "850 m" — metres under 1 km. Units are universal (no i18n). */
function formatDistance(km: number): string {
    return km < 1 ? `${Math.round(km * 100) * 10} m` : `${km.toFixed(1)} km`;
}

type Styles = ReturnType<typeof makeStyles>;

/**
 * Store-tap dock — the SAME DockedGlassSheet scaffold as the map's main dock
 * (see components/dock/*), reskinned for a selected store:
 *   • bar   → X (dismiss) · the option's chain LOGOS (spread, no names) · price.
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
    /** Called when a touch begins on the dock → the host ignores the map's
     *  leaked onPress for the same tap (else selecting an option deselects). */
    onInteract: () => void;
    /** Dismiss the selection (bar X) — same as tapping empty map. */
    onDismiss: () => void;
    /** Collapsed dock height → the map keeps content above the bar. */
    onCollapsedClearance?: (px: number) => void;
    /** Sheet occlusion per detent → the host insets the map's frame to the
     *  visible area above the sheet (so it frames stores there and no map sits
     *  under the sheet to steal a drag). */
    onOcclusion?: (px: number) => void;
};

export default function StoreOptionsDock({
    options, selectedKey, onSelect, onNavigate, onCreateList, creatingList,
    journeyKm, itemCount, colors, onInteract, onDismiss,
    onCollapsedClearance, onOcclusion,
}: Props) {
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const dockRef = useRef<DockedSheetControls>(null);
    const [barH, setBarH] = useState(52);
    const collapsedRef = useRef(120);
    const progress = useSharedValue(0);
    // >1 option ⇒ the tapped store has split alternatives → a selectable list.
    const multi = options.length > 1;
    // The option the bar/actions reflect (the picked one, else the best).
    const current = options.find(o => o.key === selectedKey) ?? options[0];
    // Bar distance: a single store's own distance; a split's FARTHEST store (its
    // reach) — the "how far" cue shown next to the price.
    const barDists = current?.stores.map(s => s.distance).filter(Number.isFinite) ?? [];
    const barDistanceKm = barDists.length ? Math.max(...barDists) : NaN;

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
            {/* X — dismisses the selection (same as tapping empty map). Matches
                the Catalog list sheet's close button (close · 22 · textPrimary). */}
            <TouchableOpacity onPress={onDismiss} hitSlop={8} accessibilityLabel={t('common.close')}>
                <Ionicons name="close" size={22} color={colors.textPrimary} />
            </TouchableOpacity>
            {/* Logos ONLY (no chain names), spread — a store's brand reads at a
                glance; a split shows its 2–3 brands side by side. */}
            <StoreLogos stores={current.stores} size={avatarSize.sm} styles={styles} spread />
            <View style={styles.barSpacer} />
            {/* How far, at a glance — a single store's distance, or a split's
                farthest reach — so you can weigh cheap-vs-near before expanding. */}
            {Number.isFinite(barDistanceKm) && barDistanceKm > 0 && (
                <Text style={styles.barDistance} allowFontScaling={false}>{formatDistance(barDistanceKm)}</Text>
            )}
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

            {/* Store options — a "Stores" section of SEPARATE cards (one per
                option: a single store, or the split options with the single-store
                option last), the selected one ringed pink. */}
            <View>
                <Text style={styles.secLabel}>{t('results.sheet.stores')}</Text>
                <View style={styles.optsList}>
                    {options.map(opt => (
                        <OptionItem
                            key={opt.key}
                            option={opt}
                            selected={selectedKey === opt.key}
                            selectable={multi}
                            styles={styles}
                            colors={colors}
                            onSelect={onSelect}
                            onInteract={onInteract}
                            t={t}
                        />
                    ))}
                </View>
            </View>
        </View>
    );

    return (
        <DockedGlassSheet
            ref={dockRef}
            colors={colors}
            barAtTop
            mapMode
            progressSV={progress}
            onTouchStart={onInteract}
            onCollapsedClearance={px => { collapsedRef.current = px; onCollapsedClearance?.(px); }}
            onOcclusion={onOcclusion}
            barRowHeight={barH}
            barRow={barRow}
            sheet={{ maxStage: 2, content }}
        />
    );
}

/** Bar/row title: the joined chain names ("Rimi · Maxima") for a split, or the
 *  single store's chain name. */
function optionTitle(option: SheetOption): string {
    return option.stores.map(s => chainBrandName(s.chainName)).join(' · ');
}

/** Chain badges for an option. `spread` lays a split's 2–3 badges side by side
 *  (bar); the default OVERLAPS them into one grouped badge (option cards). */
function StoreLogos({ stores, size, styles, spread }: { stores: SheetOption['stores']; size: number; styles: Styles; spread?: boolean }) {
    if (stores.length === 1) {
        return <ChainLogoChip chainId={stores[0].chainId} name={stores[0].chainName} size={size} />;
    }
    return (
        <View style={[styles.logoStack, spread && styles.logoRowSpread]}>
            {stores.map((s, i) => (
                <View key={s.storeId} style={!spread && i > 0 ? styles.logoStacked : undefined}>
                    <ChainLogoChip chainId={s.chainId} name={s.chainName} size={size} />
                </View>
            ))}
        </View>
    );
}

/** One option — its OWN card (a split of 2/3 stores or the single-store
 *  baseline). The selected one is ringed pink. Memoized so a stage settle
 *  re-render only touches rows whose `selected` flips. */
const OptionItem = React.memo(function OptionItem({
    option, selected, selectable, styles, colors, onSelect, onInteract, t,
}: {
    option: SheetOption; selected: boolean; selectable: boolean;
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
        >
            <SheetCard style={[styles.optCard, selected && selectable && styles.optCardSelected]}>
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
            </SheetCard>
        </TouchableOpacity>
    );
});

const makeStyles = (c: AppTheme) => StyleSheet.create({
    // ── Info bar ──
    // minHeight matches the main map dock's bar (40) so both collapse to the
    // same bar height → identical detent geometry at every stage (the store
    // bar's tallest content is the 32dp logos, so without this it measured ~8dp
    // shorter and its stage-1 sheet read slightly shorter than the main dock's).
    bar: { ...dockBarBase, minHeight: 40 },
    barSpacer: { flex: 1 },
    barDistance: { ...typography.bodySmall, color: c.textMuted, marginRight: spacing.sm },
    barPrice: { fontSize: 18, fontWeight: '800', color: c.primary },

    // ── Content ──
    // Bottom pad so the last option row is never flush against the sheet's
    // bottom edge (where a tap could land on the map below instead).
    content: { ...dockContentBase, paddingBottom: spacing.lg },
    actionRow: { flexDirection: 'row', gap: 14 },

    // ── Store options — a "Stores" section of separate cards ──
    secLabel: {
        fontSize: 12, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase',
        color: c.textMuted, marginBottom: spacing.sm, marginLeft: 4,
    },
    optsList: { gap: spacing.sm },
    logoStack: { flexDirection: 'row', alignItems: 'center' },
    // Deeper overlap so a split reads as one grouped badge, not two chips.
    logoStacked: { marginLeft: -18 },
    // Bar variant: badges side by side (no overlap), a small gap between them.
    logoRowSpread: { gap: spacing.xs },

    // Each option is its OWN SheetCard. Explicit padding overrides SheetCard's
    // section padding; a transparent 1.5px ring is always present so the pink
    // selected ring can't shift the row's layout.
    optCard: {
        flexDirection: 'row', alignItems: 'center', gap: spacing.md,
        paddingTop: 12, paddingBottom: 12, paddingHorizontal: 14,
        borderWidth: 1.5, borderColor: 'transparent',
    },
    optCardSelected: { borderColor: c.primary },
    optMid: { flex: 1 },
    optTitle: { ...typography.bodyStrong, fontWeight: '700', color: c.textPrimary },
    optSub: { ...typography.caption, color: c.textMuted, marginTop: 2 },
    optPrice: { fontSize: 15, fontWeight: '800', color: c.primary },

    // Badges — one row below the title.
    chipRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
    chip: {
        flexDirection: 'row', alignItems: 'center', gap: 3,
        backgroundColor: 'rgba(120,120,128,0.16)', borderRadius: radius.pill,
        paddingHorizontal: 7, paddingVertical: 2,
    },
    chipText: { ...typography.label, fontSize: 11, color: c.textSecondary },
    warnChip: { backgroundColor: c.warning + '2E' },
    detourChip: { backgroundColor: c.warning + '2E' },
    detourText: { color: c.warning, fontWeight: '700' },
    savingChip: { backgroundColor: c.success + '2E' },
    savingText: { color: c.success, fontWeight: '700' },
});
