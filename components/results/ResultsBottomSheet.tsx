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
import { Gesture, GestureDetector, ScrollView, State } from 'react-native-gesture-handler';
import { MaterialProgress } from '@/components/MaterialProgress';
import Animated, { SlideInDown, SlideOutDown, useAnimatedStyle, useDerivedValue, useSharedValue, withTiming, withSpring, runOnJS } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { spacing, radius, typography, iconSize, avatarSize, type AppTheme } from '../../constants/theme';
import { type SheetOption } from '../../utils/splitOptions';
import { ChainLogoChip } from '../ChainLogoChip';
import { chainBrandName } from '../../utils/chainBrandName';
import { formatEuro } from '../../utils/formatCurrency';
import { useTranslation } from 'react-i18next';
import { LiquidGlass } from '../LiquidGlass';
import { concentricRadius, displayCornerRadius } from '../../utils/displayCorners';

// SheetOption lives in utils/splitOptions (pure + unit-tested). Re-export so
// existing imports from this component keep working.
export type { SheetOption };

const SCREEN_H = Dimensions.get('window').height;
const SCREEN_W = Dimensions.get('window').width;
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

const HANDLE_H = 30;        // drag affordance height
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/* ── Multi-option: draggable 3-stage sheet; action bar always pinned. ────── */
function MultiSheet({ options, selectedKey, onSelect, onNavigate, onCreateList, creatingList, colors, bottomInset, onHeightChange }: Props) {
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const [firstCardH, setFirstCardH] = useState(120);
    const [contentH, setContentH] = useState(0);
    const [actionsH, setActionsH] = useState(90);
    const [stage, setStage] = useState(1); // open at peek; 0 = the collapsed bar
    // Bumped on each user snap so the settle effect animates even to the SAME
    // stage (a small drag that releases back).
    const [settleTick, setSettleTick] = useState(0);

    // Snap points (Find-My-style detents), ascending sheet heights: BAR (fully
    // collapsed — just the grabber pill + the floating action bar), peek (top
    // card + a sliver), an optional MIDDLE stage (scroll the list while the map
    // stays visible so tapping a result shows on the map), and full (whole
    // list, capped). The action bar is a fixed sibling counted in every
    // height → never clipped.
    const snaps = useMemo(() => {
        const bar = HANDLE_H + actionsH;
        // FULL (the docked stage 3) is ALWAYS the near-top detent — independent
        // of content height, like Find My. Short lists just leave slack below;
        // the dock morph belongs to the approach to the TOP of the screen, not
        // to "content fits" (which used to dock the sheet at mid-screen).
        const full = SCREEN_H * 0.85;
        const peek = Math.min(bar + firstCardH + PEEK_GAP, full);
        // MID = the floating "see the options" stage: whole list when it's
        // short, else a fixed comfortable height with the map still visible.
        const mid = clamp(Math.min(bar + contentH, bar + SCREEN_H * 0.42), peek, full);
        const pts = [bar];
        if (peek > bar + 40) pts.push(peek);
        if (mid > peek + 48 && full > mid + 48) pts.push(mid);
        if (full > peek + 48) pts.push(full);
        return pts;
    }, [firstCardH, contentH, actionsH]);

    const safeStage = Math.min(stage, snaps.length - 1);

    const height = useSharedValue(snaps[0]);
    // Declared BEFORE every worklet that captures it (a later `const` is still
    // in its temporal dead zone at worklet creation → undefined → crash).
    const snapsSV = useSharedValue<number[]>(snaps);
    useEffect(() => { snapsSV.value = snaps; }, [snaps, snapsSV]);
    const dragging = useRef(false);
    // UI-thread mirror of `dragging` for the dock-progress worklet (see dockP).
    const draggingSV = useSharedValue(false);
    const snapsRef = useRef(snaps); snapsRef.current = snaps;
    const stageRef = useRef(safeStage); stageRef.current = safeStage;
    // Slide-in is driven by this shared value (NOT reanimated's `entering`
    // layout animation). A layout animation + an animated `height` on the same
    // node fight on Fabric — the entering snapshot pins the height, so the
    // measured peek never applies until you tap. Owning both the slide and the
    // height in ONE animated style avoids that entirely.
    const slideY = useSharedValue(SCREEN_H * 0.85);

    // ── Stage-3 DOCK progress ────────────────────────────────────────────────
    // stagePSV: 0/1 timing that follows the COMMITTED stage (flick coverage).
    // dockP: while the finger is down, the height-derived progress (tracks the
    // drag, reverses with it); once released, max(height, stage) so a flick
    // that lands on the last detent always completes the morph.
    const stagePSV = useSharedValue(0);
    useEffect(() => {
        const atLast = snaps.length > 1 && safeStage === snaps.length - 1;
        stagePSV.value = withTiming(atLast ? 1 : 0, { duration: 240 });
    }, [safeStage, snaps.length, stagePSV]);
    const dockP = useDerivedValue(() => {
        const sn = snapsSV.value;
        const last = sn[sn.length - 1];
        const prev = sn.length > 1 ? sn[sn.length - 2] : last;
        const range = Math.max(1, last - prev);
        const hp = Math.min(1, Math.max(0, (height.value - prev) / range));
        let p = draggingSV.value ? hp : Math.max(hp, stagePSV.value);
        if (p > 0.995) p = 1;
        return p;
    });
    const bottomOffset = spacing.sm;

    // TRANSFORM-ONLY animation (the definitive de-stutter): the sheet's parts
    // never change SIZE while dragging — the BODY (glass + handle + list, all
    // fixed at the tallest snap) slides down inside a fixed clipping viewport
    // as the sheet collapses, and the BAR is a separate fixed glass panel the
    // body disappears behind. translateY is a pure transform: no Yoga layout,
    // no blur resize, nothing measured — every frame is just a matrix update.
    //
    // The stage-3 DOCK is transform-only too, so it can track the finger with
    // no per-frame Yoga passes: the root is laid out EDGE-TO-EDGE (docked
    // geometry) and scaled DOWN in x to the floating width; an inner wrapper
    // counter-scales by 1/s so the content renders at identity (never
    // stretched, text stays crisp). Both scales share the same centre, so
    // content never moves — only the clip box (the sheet's visible edges)
    // expands/contracts with the drag. The float's bottom gap is a translateY.
    const outerStyle = useAnimatedStyle(() => {
        const p = dockP.value;
        const s = (SCREEN_W - 2 * spacing.sm * (1 - p)) / SCREEN_W;
        return {
            transform: [
                { translateY: slideY.value - bottomOffset * (1 - p) },
                { scaleX: s },
            ],
        };
    });
    const counterScaleStyle = useAnimatedStyle(() => {
        const p = dockP.value;
        const s = (SCREEN_W - 2 * spacing.sm * (1 - p)) / SCREEN_W;
        return { transform: [{ scaleX: 1 / s }] };
    });
    // delta = how far the (fixed-size) glass panel + list slide DOWN as the
    // sheet collapses. One shared worklet drives both transforms.
    const bodyStyle = useAnimatedStyle(() => {
        const sn = snapsSV.value;
        return { transform: [{ translateY: sn[sn.length - 1] - height.value }] };
    });
    useEffect(() => { slideY.value = withTiming(0, { duration: 260 }); }, [slideY]);

    // ANIMATE to the current stage on a user action (snap / tap / collapse) —
    // tracked by safeStage + a settle tick so even a same-stage release snaps
    // back. Reads snaps via ref, so a measurement-only change does NOT re-fire
    // here (re-animating toward a settling `full` is what made it "drag on").
    useEffect(() => {
        if (dragging.current) return;
        // A worklet-driven release is already springing to this stage — don't
        // restart the animation (that discards the flick momentum).
        if (uiSettled.current) { uiSettled.current = false; return; }
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

    // New store's options → back to peek (the animate effect runs it).
    useEffect(() => { setStage(1); }, [options]);

    // Report the settled stage height so the map can frame content above us —
    // plus the float gap below the sheet (bottomOffset, defined with the dock
    // block above: it matches the SIDE margins for equal breathing room).
    useEffect(() => { onHeightChange?.(snaps[safeStage] + bottomOffset); }, [safeStage, snaps, onHeightChange, bottomOffset]);

    // ── SHEET-WIDE drag: one RNGH pan gesture, worklet-driven ──
    // PanResponder ran every move event over the JS bridge — with the map
    // hammering the JS thread the sheet visibly stuttered. Gesture.Pan's
    // callbacks are WORKLETS: touch → height.value entirely on the UI thread,
    // so the sheet tracks the finger pixel-for-pixel regardless of JS load
    // (the same architecture as gorhom/bottom-sheet).
    //
    // Manual activation replicates the old claim rules: vertical-dominant
    // movement only (taps + horizontal swipes pass through to cards/buttons);
    // below full any vertical drag moves the SHEET; at full an upward drag
    // scrolls the list and a downward drag moves the sheet only when the list
    // is already at its top. Mutual exclusion with the (RNGH) ScrollView is
    // automatic once the pan activates.
    const scrollY = useSharedValue(0);
    const startHSV = useSharedValue(0);
    const grabX = useSharedValue(0);
    const grabY = useSharedValue(0);
    const setDragging = (v: boolean) => { dragging.current = v; };
    const uiSettled = useRef(false);
    const settleFromUI = (idx: number) => {
        if (idx >= 0) { uiSettled.current = true; setStage(idx); }
        else setSettleTick(t => t + 1); // cancelled drag → animate back to the current stage
    };
    const scrollRef = useRef<any>(null);
    const sheetGesture = useMemo(() => Gesture.Pan()
        .manualActivation(true)
        .simultaneousWithExternalGesture(scrollRef)
        .onBegin((e) => {
            'worklet';
            grabX.value = e.absoluteX;
            grabY.value = e.absoluteY;
        })
        .onTouchesMove((e, sm) => {
            'worklet';
            // ONLY an activation decision — once the pan is ACTIVE it must never
            // be re-judged: failing here mid-drag (sheet reaches full while the
            // finger keeps moving up) KILLED the gesture, so reversing direction
            // without lifting the finger did nothing until a fresh touch.
            if (e.state === State.ACTIVE) return;
            const t = e.allTouches[0];
            if (!t) return;
            const dy = t.absoluteY - grabY.value;
            const dx = t.absoluteX - grabX.value;
            if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) { sm.fail(); return; }
            if (Math.abs(dy) < 4) return;                     // not a drag yet → taps stay taps
            if (Math.abs(dy) <= Math.abs(dx) * 1.5) return;   // not vertical-dominant yet
            const sn = snapsSV.value;
            const atFull = height.value >= sn[sn.length - 1] - 2;
            if (!atFull || (dy > 0 && scrollY.value <= 1)) sm.activate();
            else sm.fail();                                    // at full, the list owns it
        })
        .onStart((e) => {
            'worklet';
            // Anchor at the ACTIVATION point so the sheet follows the finger
            // exactly from the moment it grabs (no pre-activation jump).
            startHSV.value = height.value + e.translationY;
            draggingSV.value = true;
            runOnJS(setDragging)(true);
        })
        .onUpdate((e) => {
            'worklet';
            const sn = snapsSV.value;
            const lo = sn[0], hi = sn[sn.length - 1];
            // Clamp between the bar and full — dragging down never closes the
            // sheet (tapping the map deselects; that's the only dismiss).
            // RE-ANCHOR whenever the clamp engages: otherwise the overshoot
            // distance is swallowed and a direction reversal (swipe up past
            // full, then drag down WITHOUT releasing) doesn't move the sheet
            // until the finger has retraced the entire overshoot.
            let h = startHSV.value - e.translationY;
            if (h > hi) { startHSV.value = hi + e.translationY; h = hi; }
            else if (h < lo) { startHSV.value = lo + e.translationY; h = lo; }
            height.value = h;
        })
        .onEnd((e) => {
            'worklet';
            // Snap to the nearest detent, nudged one stage by a flick.
            const sn = snapsSV.value;
            const h = height.value;
            let idx = 0, best = 1e9;
            for (let i = 0; i < sn.length; i++) { const d = Math.abs(sn[i] - h); if (d < best) { best = d; idx = i; } }
            if (e.velocityY < -500 && idx < sn.length - 1) idx++;
            else if (e.velocityY > 500 && idx > 0) idx--;
            // Spring seeded with the finger's velocity (height moves opposite to
            // translationY) → the release feels like a continuation of the drag,
            // not a restart. overshootClamping: detents are hard edges.
            height.value = withSpring(sn[idx], {
                velocity: -e.velocityY, damping: 30, stiffness: 280, mass: 0.8, overshootClamping: true,
            });
            draggingSV.value = false;
            runOnJS(setDragging)(false);
            runOnJS(settleFromUI)(idx);
        })
        .onFinalize((_e, success) => {
            'worklet';
            if (success) return;
            draggingSV.value = false;
            runOnJS(setDragging)(false);
            runOnJS(settleFromUI)(-1);
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    , [height]);

    // Geometry (all static per measurement — transform-only, see above):
    // root = fixed clip box (rounded, concentric) · glass PANEL = one material
    // for the WHOLE sheet incl. the bar area, sliding down as it collapses ·
    // list in a root-fixed viewport that ends at the bar's top · buttons = a
    // TRANSPARENT overlay pinned to the root's bottom, always over the same
    // panel glass (single material — no body/bar seam line).
    const maxSnap = snaps[snaps.length - 1];
    const listH = Math.max(0, maxSnap - HANDLE_H - actionsH);
    const cornerR = concentricRadius(bottomInset, spacing.sm);

    // ── Stage-3 DOCKING styles (the scaleX geometry lives up top) ───────────
    // Everything here is draw-only (radii, opacity) or transform — the whole
    // dock morph tracks the finger with zero per-frame layout. All geometry
    // (edges via scaleX, bottom gap via translateY, corner radii here) rides
    // the SAME dockP progress, so every edge docks by the same rules.
    //
    // CONCENTRIC bottom corners: as the sheet's corner travels to the screen's
    // own (rounded) corner, its radius GROWS from cornerR (= displayR − inset)
    // to the display's radius — the perceived roundness stays CONSTANT the
    // whole way (shrinking to 0 made the corners visibly sharpen mid-drag).
    const displayR = displayCornerRadius(bottomInset);
    const dockCornersStyle = useAnimatedStyle(() => {
        const p = dockP.value;
        const r = cornerR + (displayR - cornerR) * p;
        return {
            borderBottomLeftRadius: r,
            borderBottomRightRadius: r,
        };
    });
    const solidBgStyle = useAnimatedStyle(() => ({ opacity: dockP.value }));
    return (
        <GestureDetector gesture={sheetGesture}>
        {/* box-none everywhere structural: the skeleton is ALWAYS maxSnap tall —
            only the (translated) panel and the button bar may take touches, so a
            collapsed sheet never steals pans meant for the map. */}
        <Animated.View
            style={[styles.sheetRoot, { height: maxSnap, borderRadius: cornerR }, outerStyle, dockCornersStyle]}
            pointerEvents="box-none"
        >
            {/* PANEL (glass + handle) — a DIRECT root child, NOT counter-scaled:
                it renders under the same scaleX as the root's clip, so its top
                corner arcs stay inside the visible edges and curve EXACTLY like
                the root-clipped bottom corners. (Inside the counter-wrapper it
                rendered wider than the clip — the top radii landed outside the
                sheet and the visible top corners went square.) Nothing in it is
                text-critical; the ~4% x-compression at float is imperceptible. */}
            <Animated.View
                style={[styles.panel, {
                    height: maxSnap,
                    borderTopLeftRadius: cornerR, borderTopRightRadius: cornerR,
                }, bodyStyle]}
            >
                <LiquidGlass fallback="blur" style={styles.bodyGlass} />
                {/* Solid backdrop that fades in as the sheet docks at full. */}
                <Animated.View
                    pointerEvents="none"
                    style={[StyleSheet.absoluteFillObject, { backgroundColor: colors.pageBackground }, solidBgStyle]}
                />
                <View style={styles.handleArea}>
                    <View style={styles.handle} />
                </View>
            </Animated.View>

            {/* Counter-scale wrapper: undoes the root's scaleX so the TEXT
                content (list + buttons) renders at identity — never stretched. */}
            <Animated.View style={[StyleSheet.absoluteFillObject, counterScaleStyle]} pointerEvents="box-none">
            {/* List viewport: root-fixed, ends at the bar's top edge; the list
                inside rides the same delta transform as the panel. */}
            <View style={[styles.listViewport, { height: Math.max(0, maxSnap - actionsH) }]} pointerEvents="box-none">
                <Animated.View style={bodyStyle}>
                    <ScrollView
                        ref={scrollRef}
                        style={[styles.list, { height: listH, marginTop: HANDLE_H }]}
                        contentContainerStyle={styles.listContent}
                        showsVerticalScrollIndicator={safeStage === snaps.length - 1}
                        scrollEnabled={safeStage === snaps.length - 1}
                        bounces={false}
                        overScrollMode="never"
                        onScroll={e => { scrollY.value = e.nativeEvent.contentOffset.y; }}
                        scrollEventThrottle={16}
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
                </Animated.View>
            </View>

            {/* Buttons: transparent overlay on the sliding panel's glass. */}
            <View style={styles.barOverlay} onLayout={e => setActionsH(e.nativeEvent.layout.height)}>
                <Actions styles={styles} colors={colors} creatingList={creatingList}
                    onNavigate={onNavigate} onCreateList={onCreateList} bottomInset={bottomInset} />
            </View>
            </Animated.View>
        </Animated.View>
        </GestureDetector>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    // FLOATING GLASS PANEL (Find-My-style). LAID OUT edge-to-edge (the DOCKED
    // geometry); the floating look — side margins + the gap above the home
    // indicator — comes from the root's scaleX + translateY transforms (see
    // outerStyle), so the dock morph is transform-only and never relayouts.
    sheetRoot: {
        position: 'absolute', left: 0, right: 0, bottom: 0,
        overflow: 'hidden', // rounds the visible bottom cut of the sliding panel
    },
    // Single-store sheet (auto-height, not animated) keeps the one-piece panel.
    sheet: {
        position: 'absolute', left: spacing.sm, right: spacing.sm, bottom: 0,
        borderRadius: radius.xl,
        shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 12,
    },
    // The ONE glass panel (whole sheet incl. the bar area) — slides via
    // transform; the root's clip rounds the corners. NO border: the hairline
    // "decoration" clipped visibly against the rounded corners and left a
    // see-through strip at the docked edges — the glass edge alone is enough.
    panel: {
        position: 'absolute', top: 0, left: 0, right: 0, overflow: 'hidden',
        backgroundColor: Platform.OS === 'android' ? c.cardBackground + 'F2' : 'transparent',
    },
    bodyGlass: StyleSheet.absoluteFillObject,
    // Root-fixed clip for the list — ends at the bar's top edge. Inset by the
    // float margin so content sits at its floating position at EVERY stage
    // (the root is laid out at the docked width; content must not shift).
    listViewport: { position: 'absolute', top: 0, left: spacing.sm, right: spacing.sm, overflow: 'hidden' },
    barOverlay: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: spacing.sm },
    sheetGlass: {
        flex: 1, borderRadius: radius.xl, overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(120,120,128,0.24)',
        // Android: expo-blur renders a translucent wash, not a real blur — give it
        // a tinted body (and elevation, which needs a background to draw) so the
        // sheet keeps contrast over the map. iOS glass strips this automatically.
        backgroundColor: Platform.OS === 'android' ? c.cardBackground + 'F2' : 'transparent',
        elevation: 16,
    },
    // Generous drag target; the visible pill sits centred within it.
    handleArea: { height: HANDLE_H, alignItems: 'center', justifyContent: 'center' },
    handle: { width: 44, height: 5, borderRadius: radius.pill, backgroundColor: c.border },

    list: { flexGrow: 0 },
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
