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
import { DockActionRow } from '../dock/DockActionRow';
import { dockBarBase } from '../dock/dockLayout';

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
    /** Per-option journey km (origin → its stores → [route end]), keyed by option
     *  key. Drives the bar "how far" + the single-store card distance so both show
     *  the real travel, not a radial leg. Value may be null (no origin/coords). */
    journeyByOption: Map<string, number | null>;
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
    journeyKm, journeyByOption, itemCount, colors, onInteract, onDismiss,
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
    // Bar "how far": the current plan's whole through-journey — start → its
    // store(s) → [route end] — not a radial leg. Falls back to the store's own
    // radial only if the journey couldn't be computed (no origin/coords).
    const barJourneyKm = current ? journeyByOption.get(current.key) ?? null : null;
    const barRadial = current?.stores.map(s => s.distance).filter(Number.isFinite) ?? [];
    const barDistanceKm = barJourneyKm ?? (barRadial.length ? Math.max(...barRadial) : NaN);
    // Baseline for a combo's "+extra" chip: the single-store option's journey
    // (visit just the tapped store). Combo extra = its journey − this baseline, so
    // the three numbers reconcile: bar(combo) = single + extra. (Same journey
    // source everywhere — the old radial detour disagreed with the bar/single.)
    const singleOption = options.find(o => o.stores.length === 1);
    const baselineJourneyKm = singleOption ? journeyByOption.get(singleOption.key) ?? null : null;
    // Discounted items at the (single) tapped store: count + how much the
    // promos shave off vs regular prices.
    const promoStats = useMemo(() => {
        const store = !multi && current?.stores.length === 1 ? current.stores[0] : null;
        if (!store) return null;
        let count = 0, saved = 0;
        for (const it of store.items) {
            if (it.isMissing || it.price == null || it.promoPrice == null || it.promoPrice >= it.price) continue;
            count += 1;
            saved += (it.price - it.promoPrice) * (it.packsNeeded ?? it.quantity ?? 1);
        }
        return count > 0 ? { count, saved } : null;
    }, [multi, current]);
    // Estimated prices at the tapped store: cross-chain averages + stale
    // fallbacks — neither is a verified current price there. This is also WHY
    // a nominally-cheaper store can rank below one with real prices (the
    // server sorts by estimate count before total), so surface the number.
    const approxCount = useMemo(() => {
        const store = !multi && current?.stores.length === 1 ? current.stores[0] : null;
        if (!store) return 0;
        return store.items.filter(it => !it.isMissing && (it.isCrossChainAverage || it.isFallback)).length;
    }, [multi, current]);

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
            {current.stores.length === 1 ? (
                /* V1 "store hero": logo + name with distance caption, big price
                   right — mirrors the summary bar's price-hero language. */
                <>
                    <StoreLogos stores={current.stores} size={avatarSize.sm} styles={styles} spread />
                    <View style={styles.barNameCol}>
                        <Text style={styles.barName} numberOfLines={1}>
                            {chainBrandName(current.stores[0].chainName)}
                        </Text>
                        {Number.isFinite(barDistanceKm) && barDistanceKm > 0 && (
                            <Text style={styles.barCap} numberOfLines={1} allowFontScaling={false}>
                                {formatDistance(barDistanceKm)}
                            </Text>
                        )}
                    </View>
                    <View style={styles.barSpacer} />
                    <Text style={styles.barPriceHero} allowFontScaling={false}>{formatEuro(current.total)}</Text>
                </>
            ) : (
                <>
                    {/* Combo (2–3 stores): overlapped logo stack + "N parduotuvės"
                       with the through-journey caption — same hero language. */}
                    <StoreLogos stores={current.stores} size={avatarSize.sm} styles={styles} />
                    <View style={styles.barNameCol}>
                        <Text style={styles.barName} numberOfLines={1}>
                            {t('results.sheet.storesCount', { count: current.stores.length })}
                        </Text>
                        {Number.isFinite(barDistanceKm) && barDistanceKm > 0 && (
                            <Text style={styles.barCap} numberOfLines={1} allowFontScaling={false}>
                                {formatDistance(barDistanceKm)}
                            </Text>
                        )}
                    </View>
                    <View style={styles.barSpacer} />
                    <Text style={styles.barPriceHero} allowFontScaling={false}>{formatEuro(current.total)}</Text>
                </>
            )}
        </View>
    );

    const content = (
        <View style={styles.content} onStartShouldSetResponderCapture={noteTouch}>
            {/* Navigate + List — the same big cards as Basket/Invite. */}
            <DockActionRow
                colors={colors}
                gap={14}
                actions={[
                    {
                        icon: 'navigate-outline',
                        title: t('results.sheet.navigate'),
                        subtitle: journeyKm != null ? formatDistance(journeyKm) : '—',
                        onPress: onNavigate,
                        onPressIn: onInteract,
                    },
                    {
                        icon: 'list-outline',
                        title: t('results.sheet.list'),
                        subtitle: creatingList ? t('results.sheet.creating') : t('results.sheet.items', { count: itemCount }),
                        onPress: onCreateList,
                        onPressIn: onInteract,
                        disabled: creatingList,
                        loading: creatingList,
                    },
                ]}
            />

            {/* Single store (no split alternatives): the option card would just
                repeat the bar — show a "Parduotuvė" FACTS card instead
                (address + missing-count). Multi keeps the comparison cards. */}
            {!multi && current.stores.length === 1 ? (
                <View>
                    <Text style={styles.secLabel}>{t('results.sheet.store')}</Text>
                    <SheetCard style={styles.factsCard}>
                        <View style={styles.factsRow}>
                            <ChainLogoChip
                                chainId={current.stores[0].chainId}
                                name={current.stores[0].chainName}
                                size={avatarSize.sm}
                            />
                            <Text style={styles.factsAddress} numberOfLines={2}>
                                {current.stores[0].storeAddress}
                            </Text>
                        </View>
                        {promoStats && (
                            <View style={styles.factsRow}>
                                <Ionicons name="pricetag-outline" size={16} color={colors.primary} />
                                <Text style={styles.factsPromo}>
                                    {t('results.sheet.promoLine', {
                                        count: promoStats.count,
                                        saved: formatEuro(promoStats.saved),
                                    })}
                                </Text>
                            </View>
                        )}
                        {approxCount > 0 && (
                            /* Same chip badge language as the option cards'
                               sparkles "apytikslė kaina" pill. */
                            <View style={styles.factsChipRow}>
                                <View style={styles.chip}>
                                    <Ionicons name="sparkles-outline" size={iconSize.xs} color={colors.textMuted} />
                                    <Text style={styles.chipText} allowFontScaling={false}>
                                        {t('results.sheet.approxCount', { count: approxCount })}
                                    </Text>
                                </View>
                            </View>
                        )}
                        {current.stores[0].missingItemNames.length > 0 && (
                            <Text style={styles.factsMissing}>
                                {t('results.sheet.missingCount', { count: current.stores[0].missingItemNames.length })}
                            </Text>
                        )}
                    </SheetCard>
                </View>
            ) : (
            <View>
                <Text style={styles.secLabel}>{t('results.sheet.stores')}</Text>
                <View style={styles.optsList}>
                    {options.map(opt => (
                        <OptionItem
                            key={opt.key}
                            option={opt}
                            journeyKm={journeyByOption.get(opt.key) ?? null}
                            baselineJourneyKm={baselineJourneyKm}
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
            )}
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
    option, journeyKm, baselineJourneyKm, selected, selectable, styles, colors, onSelect, onInteract, t,
}: {
    option: SheetOption; journeyKm: number | null; baselineJourneyKm: number | null;
    selected: boolean; selectable: boolean;
    styles: Styles; colors: AppTheme; onSelect: (key: string) => void; onInteract: () => void; t: TFunction;
}) {
    const multi = option.stores.length > 1;
    const primary = option.stores[0];
    // Single-store card: the whole trip start → this store → [route end]. Falls
    // back to the store's radial distance only if the journey is unavailable.
    const singleDistanceKm = journeyKm ?? (Number.isFinite(primary.distance) ? primary.distance : NaN);
    // Combo card "+extra": how much MORE the split travels than the single-store
    // baseline — journey(combo) − journey(single). Consistent with the bar. Falls
    // back to the precomputed radial detour only when journeys are unavailable.
    const extraKm = (journeyKm != null && baselineJourneyKm != null)
        ? Math.max(0, journeyKm - baselineJourneyKm)
        : option.detourKm;

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
                            {extraKm != null && extraKm > 0 && (
                                <View style={[styles.chip, styles.detourChip]}>
                                    <Ionicons name="navigate-outline" size={iconSize.xs} color={colors.warning} />
                                    <Text style={[styles.chipText, styles.detourText]} allowFontScaling={false}>{`+ ${formatDistance(extraKm)}`}</Text>
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
                            {Number.isFinite(singleDistanceKm) && singleDistanceKm > 0 && (
                                <View style={styles.chip}>
                                    <Ionicons name="navigate-outline" size={iconSize.xs} color={colors.textMuted} />
                                    <Text style={styles.chipText}>{formatDistance(singleDistanceKm)}</Text>
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
    // V1 store-hero (single store)
    barNameCol: { marginLeft: spacing.sm, flexShrink: 1 },
    barName: { fontSize: 14.5, fontWeight: '700', color: c.textPrimary, lineHeight: 17 },
    barCap: { fontSize: 11, lineHeight: 14, color: c.textSecondary },
    barPriceHero: {
        fontSize: 22, fontWeight: '800', letterSpacing: -0.4,
        color: c.textPrimary, fontVariant: ['tabular-nums'],
    },

    // ── Content ──
    // Bottom pad so the last option row is never flush against the sheet's
    // bottom edge (where a tap could land on the map below instead).
    // Inset + halo clearance come from the sheet's SheetContent wrapper.
    content: { gap: 14 },

    // ── Store options — a "Stores" section of separate cards ──
    // Single-store facts card — same shadowed SheetCard family as the
    // action cards above it.
    // NO elevation/shadow overrides here — SheetCard's own boxShadow halo is
    // the family look; Android elevation on a translucent card draws the
    // gray-border artifact (see SheetCard's lightShadow comment).
    factsCard: { padding: 12, gap: 10 },
    factsRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    factsAddress: { flex: 1, fontSize: 13.5, color: c.textPrimary, lineHeight: 18 },
    factsPromo: { flex: 1, fontSize: 13, fontWeight: '600', color: c.textPrimary },
    factsMissing: { fontSize: 12.5, fontWeight: '600', color: c.textSecondary },
    // Chip badge inside the facts card — self-start so the pill hugs its text
    // instead of stretching to the card width.
    factsChipRow: { flexDirection: 'row', alignSelf: 'flex-start' },
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
