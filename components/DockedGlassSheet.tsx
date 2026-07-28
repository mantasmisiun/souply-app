import React, {
    createContext, forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
    type ReactNode,
} from 'react';
import type { SharedValue } from 'react-native-reanimated';
import {
    View, Pressable, StyleSheet, Platform, Dimensions,
    type LayoutChangeEvent, type StyleProp, type ViewStyle,
} from 'react-native';
import {
    Gesture, GestureDetector, ScrollView as GHScrollView, State,
} from 'react-native-gesture-handler';
import Animated, {
    Easing, interpolate, interpolateColor, runOnJS, useAnimatedScrollHandler, useAnimatedStyle,
    useDerivedValue, useSharedValue, withDelay, withRepeat, withSequence, withSpring,
    withTiming, useAnimatedReaction,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Rect } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
    useTheme, useResolvedScheme, spacing, radius, withAlpha, type AppTheme,
} from '../constants/theme';
import { concentricRadius, displayCornerRadius } from '../utils/displayCorners';
import { floatCollapseProgress } from './dock/dockGeometry';

/** The sheet's 0→1 solid/dock progress (0 floating glass → 1 edge-to-edge
 *  solid), published to sheet CONTENT so cards can fade from transparent (they
 *  blend with the glass) to raised-white as the sheet docks. */
export const SheetSolidContext = createContext<SharedValue<number> | null>(null);

/**
 * DockedGlassSheet — ONE frosted-glass panel that IS a floating bottom bar and
 * grows upward into a sheet, through STANDARD detents:
 *
 *   stage 0  collapsed — just the bar row (+ a pill).
 *   stage 1  MEDIUM   — 50 % of the screen (iOS/Material medium detent). Still a
 *                       FLOATING panel: it keeps a gap on left, right and bottom.
 *   stage 2  FULL     — the panel goes SOLID (glass → opaque), its bottom
 *                       corners square and its left/right edges expand to the
 *                       screen edges; the internal list scroll switches on.
 *
 * TOUCHING THE SCREEN EDGES IS STAGE 2's ALONE. A sheet capped at medium
 * (`maxStage: 1`) floats at every stage — see `floatCollapseProgress`, which
 * measures against the FULL detent rather than against whichever snap happens to
 * be last, so no configuration can produce a flush-but-not-docked sheet.
 *
 * The detents are FIXED fractions of the screen — the content's size never
 * dictates the height. `sheet.maxStage` picks how far it may open: 1 = medium
 * only (the tab-bar basket chooser), 2 = full (the session list sheet).
 *
 * Scroll HANDOFF (industry standard): below full, an upward drag on the list
 * EXPANDS the sheet (scroll disabled); the list only scrolls once it is at
 * full and you keep dragging up. A downward drag at full with the list at its
 * top collapses the sheet.
 *
 * Single-glass rationale (2026-07 research): two stacked BlurViews brighten and
 * opacity-animating a BlurView pops — so the glass recipe here is CONSTANT and
 * only HEIGHT (and, at full, a solid-backdrop fade) animates.
 */

const SCREEN_H = Dimensions.get('window').height;
const SCREEN_W = Dimensions.get('window').width;
const MEDIUM_FRACTION = 0.5;   // stage-1 detent — the standard medium height.
const PEEK = 14;               // slim pill strip above the bar row.
const FLOAT_MARGIN = spacing.lg;
const COLLAPSED_INSET = 18;
// The floating dock's gap from every screen edge (left/right/bottom), shrinking
// to 0 at full. Trimmed 25% for a tighter float.
const COLLAPSED_MARGIN = Math.round((FLOAT_MARGIN + COLLAPSED_INSET) * 0.75);
const BAR_CONTENT_W = SCREEN_W - 2 * COLLAPSED_MARGIN;
const PILL_W = 40;
const PILL_H = 5;
const SNAP_SPRING = { damping: 30, stiffness: 280, mass: 0.9, overshootClamping: true } as const;
// In-sheet pane swap slide — matches the ShoppingSheet pager and the dock's
// original Actions ↔ Location page slide (withTiming 280ms), so pane
// navigation keeps that exact feel everywhere.
const PANE_SLIDE_MS = 280;

const AnimatedScroll = Animated.createAnimatedComponent(GHScrollView);

function clamp(v: number, lo: number, hi: number) {
    'worklet';
    return Math.max(lo, Math.min(hi, v));
}

/** THE frosted-glass fill — the live blur + constant tint that make every dock
 *  read as glass. Rendered identically by the full-width panel and the compact
 *  bar so both share ONE recipe (a copied set of constants always drifts). The
 *  rim/solid decoration layers stay with each caller (the panel animates them;
 *  compact keeps them static).
 *
 *  ANDROID: NO live blur (perf audit finding 3). This fill IS the tab bar —
 *  mounted on every tab route — and `dimezisBlurView` re-renders the sibling
 *  hierarchy in software on every window invalidation (continuously, over a
 *  live MapView or any animation). Without the prop, expo-blur falls back to
 *  its cheap translucent approximation, and the 0.62 tint layer on top keeps
 *  the frosted look — the same degrade LiquidGlass/GlassButton already use.
 *  iOS keeps the real native blur (the prop is Android-only there anyway). */
export function GlassFill({ isDark, style }: { isDark: boolean; style: any }) {
    return (
        <>
            <BlurView
                pointerEvents="none"
                intensity={30}
                tint={isDark ? 'dark' : 'light'}
                experimentalBlurMethod={Platform.OS === 'android' ? undefined : 'dimezisBlurView'}
                style={style.glassFill}
            />
            <View pointerEvents="none" style={[style.glassFill, style.tint]} />
        </>
    );
}

/** The shared glass-edge + fill layer styles — ONE definition, consumed by both
 *  the docked sheet (below) and the non-docked GlassSheet, so their glass can
 *  never drift. Returns plain objects meant to be spread into a StyleSheet.create.
 *   - clipEdge : hairline border + the barely-there shadow ink (opacity/elevation
 *                are applied by the caller, since the dock animates them).
 *   - glassFill: the absolute-fill layer the BlurView + tint paint into.
 *   - tint     : the white(0.62)/surfaceContainer frosted wash over the blur.
 *   - solid    : the opaque sheetSurface the glass fades INTO at the full detent.
 *   - rim      : the 1.2px top highlight line that signals glass. */
export function makeGlassLayerStyles(c: AppTheme, isDark: boolean) {
    return {
        clipEdge: {
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: c.outlineVariant,
            shadowColor: isDark ? '#000000' : '#5A2233',
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 2 },
        },
        glassFill: {
            ...StyleSheet.absoluteFillObject,
            backgroundColor: Platform.OS === 'android' ? undefined : 'transparent',
        },
        // 0.62 was calibrated to sit ON TOP OF a real blur. Android no longer
        // has one (perf audit finding 3), so the tint is now the ONLY thing
        // frosting the surface — at 0.62 the content behind reads straight
        // through, sharp. Android therefore carries the opacity the blur used
        // to contribute; iOS keeps the original recipe over its native blur.
        tint: {
            backgroundColor: withAlpha(
                isDark ? c.surfaceContainer : '#FFFFFF',
                Platform.OS === 'android' ? (isDark ? 0.90 : 0.93) : 0.62,
            ),
        },
        solid: { backgroundColor: c.sheetSurface },
        rim: {
            ...StyleSheet.absoluteFillObject,
            borderTopWidth: 1.2,
            borderTopColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.9)',
        },
    } as const;
}

/** Shadow opacity at rest for the glass edge (light/dark) — shared so a static
 *  (non-animated) glass surface matches the dock's resting shadow. */
export const GLASS_SHADOW_OPACITY = { light: 0.07, dark: 0.18 } as const;

export interface DockedSheetControls {
    /** Open to the medium detent (stage 1). */
    expand(): void;
    collapse(): void;
    /** Snap to an explicit stage index (clamped). */
    snapTo(stage: number): void;
    height(): number;
    /** Externally-driven live drag (for sheets over a native map, where the
     *  internal RNGH pan can't win the gesture): set the height directly
     *  (clamped to the snap range), then snap on release with velocity. */
    dragTo(px: number): void;
    dragEnd(velocityY: number): void;
    /** Collapsed → medium, else → collapsed (tap-to-toggle). */
    toggle(): void;
}

/** A sub-pane shown IN PLACE of the sheet's root content — see SheetSpec.pane. */
export interface SheetPaneSpec {
    /** Stable name for this pane ('invite', 'share') — a change of key is what
     *  triggers the page slide, so never regenerate it per render. */
    key: string;
    /** The pane's OWN bar row (typically "‹ back · icon · title"). While the
     *  pane is open it REPLACES the host's action bar row — the sheet's top
     *  row must read as the pane's title, never as the root actions with a
     *  second header floating below them. A pane's row is a page HEADER, so it
     *  is ALWAYS pinned to the sheet's TOP — on a barAtTop host that is the
     *  root row's own box; on a bottom-bar host (the tab dock) it takes the
     *  top slot while the root row keeps the bottom one. It shares the root
     *  row's measured height (`barRowHeight`), so keep it no taller than the
     *  root bar — the detents never move on a swap. Required: a pane without
     *  its own top row is the two-headers bug. */
    barRow: ReactNode;
    /** The pane's body, shown in place of the root `content`. It gets the full
     *  detent viewport to lay out in (the scroll content is stretched to the
     *  sheet height), so a short pane still owns the whole open sheet. */
    content: ReactNode;
    /** Called whenever the sheet collapses to stage 0 while this pane is open
     *  — clear the host's pane state here (setSharePane(false)). The sheet
     *  fires it on EVERY collapse path (drag, pill tap, imperative
     *  collapse()), which is what guarantees a re-opened sheet can never show
     *  a stale pane; hosts must not re-implement this in onStageChange. */
    onDismiss: () => void;
}

interface SheetSpec {
    /** The sheet's ROOT view — always the root, even while a pane is open;
     *  the sheet (not the host) decides which of the two is showing. */
    content: ReactNode;
    /**
     * IN-SHEET PANE NAVIGATION — a sub-page the sheet shows in place of its
     * root `content` (the map dock's Pakviesti, the recipe dock's Dalintis).
     * Hand the open pane's spec here (null = root showing) and the sheet owns
     * the whole exchange:
     *
     *   · the swap ANIMATES as the dock's page slide (in from the right going
     *     deeper, from the left coming back) — the ShoppingSheet pager's
     *     manual translate, NOT reanimated entering/exiting layout
     *     animations: those ran inside this sheet's animated-height
     *     ScrollView, where layout animations misbehave on Fabric (the share
     *     pane's capped-detent bug), and a snapped swap reads as a different
     *     component;
     *   · the BAR ROW swaps in the same slide — the pane brings its own top
     *     row (`barRow`), replacing the action row while it is open;
     *   · collapsing to stage 0 calls `onDismiss` on every path, so the pane
     *     can never be stale on the next open;
     *   · the content scroll resets to the top on each swap.
     *
     * (The previous contract had hosts flip `content` in lock-step with a
     * string key; the two drifting apart — or the bar row being forgotten —
     * was an easy bug to write, so this shape makes it unrepresentable. A
     * future pane host supplies one object and gets all of the above free.)
     */
    pane?: SheetPaneSpec | null;
    /** How far the sheet may open: 1 = medium only, 2 = full. Default 2. */
    /**
     * How far the sheet may open:
     *
     *   1 — collapsed → MEDIUM. Stays a FLOATING panel throughout: the symmetric
     *       left/right/bottom gap is kept at every detent, the glass never turns
     *       solid and the corners never square off. Right for a short pane.
     *   2 — collapsed → medium → FULL (default). Only the full detent docks
     *       edge-to-edge, turning the glass solid and squaring the bottom corners
     *       into the display radius. Medium keeps a (reduced) float.
     *
     * Edge-to-edge is a property of FULL, never of "as far as this sheet opens" —
     * so choosing 1 can never produce a sheet flush to the screen edges.
     */
    maxStage?: 1 | 2;
    onStageChange?: (stage: number) => void;
    onActiveChange?: (active: boolean) => void;
    contentContainerStyle?: StyleProp<ViewStyle>;
}

interface Props {
    barRow: ReactNode;
    barRowHeight: number;
    sheet?: SheetSpec;
    colors?: AppTheme;
    onBarHeight?: (h: number) => void;
    /** Reports the COLLAPSED dock's top edge as a distance from the screen
     *  bottom (bottom margin + bar height). Screens pad by this so their last
     *  item clears the floating bar; it stays correct as the bar height / inset
     *  change (T2 compact dock, session vs tab bar). Peek is excluded so the
     *  value doesn't jump when a chooser appears. */
    onCollapsedClearance?: (px: number) => void;
    /** Reports the sheet's OCCLUSION — how far its top edge reaches up from the
     *  screen bottom — at each settled detent. A host over a native map insets
     *  the map's frame to this, so the map lives ONLY in the visible area above
     *  the sheet (no map under it → nothing to steal a sheet drag, and the map
     *  stays draggable wherever it shows). */
    onOcclusion?: (px: number) => void;
    /** A scrollable behind the bar whose scroll must yield to this sheet's Pan. */
    blockScrollRef?: { current: unknown } | null;
    /** When this panel is stacked IN FRONT of another dock (the session list
     *  sheet over the tab-bar dock), its own shadow would double the back one
     *  while collapsed. Set this so the shadow starts at 0 (collapsed — the back
     *  dock casts it) and fades in with the sheet's expansion instead. */
    progressiveShadow?: boolean;
    /** Put the bar row at the TOP of the sheet (a title that RISES with the
     *  sheet as it expands) and reveal the sheet content BELOW it — a normal
     *  bottom-sheet layout, vs the default Find-My style (fixed bar at the
     *  bottom, content revealed above it). The bar↔content separator is dropped
     *  in this mode. */
    barAtTop?: boolean;
    /** Disable the internal RNGH pan — the host drives the drag via the
     *  dragTo/dragEnd controls (used over a native map). */
    externalPanOnly?: boolean;
    /** Mirror of the sheet's continuous progress (0 collapsed → 1 full) so a
     *  host outside the content tree can bind to it (e.g. a growing title). */
    progressSV?: SharedValue<number>;
    /** Set true (UI thread) the instant a touch begins on the sheet, false when
     *  it ends — a host over a native map reads it to disable the map's pan
     *  with zero JS-thread lag. */
    dragActiveSV?: SharedValue<boolean>;
    /** Fired (JS thread) when a touch BEGINS anywhere on the sheet — a host over
     *  a native map uses it to ignore the map's onPress that leaks through the
     *  GL surface for the same tap (which would otherwise deselect). */
    onTouchStart?: () => void;
    /** Sheet floats over a LIVE native map (react-native-maps). The pan then uses
     *  DECLARATIVE activation (activeOffset on both axes) instead of manual —
     *  over a native map the manual path is starved (the map eats the touch
     *  stream before onTouchesMove fires) so the sheet never reacts, and any drag
     *  the manual path fails on falls through and pans the map. Declarative
     *  activation makes RNGH claim the drag natively (cancelling the map) and OWN
     *  every drag on the sheet, so nothing leaks. This is the gorhom-bottom-sheet-
     *  over-react-native-maps pattern. */
    mapMode?: boolean;
    /** COMPACT variant: a content-width, bottom-left floating pill instead of the
     *  full-width dock — for a plain tab switcher (e.g. the receipt Kvitai/
     *  Statistika bar). Shares the EXACT glass recipe (blur + tint + rim + shadow
     *  + corners) via GlassFill; only the geometry differs. Sheetless (no detents,
     *  no pan, no animation) — `sheet`/`barRowHeight`/dock callbacks are ignored. */
    compact?: boolean;
}

export const DockedGlassSheet = forwardRef<DockedSheetControls, Props>(function DockedGlassSheet({
    barRow, barRowHeight, sheet, colors: colorsProp, onBarHeight, onCollapsedClearance, onOcclusion,
    blockScrollRef, progressiveShadow, barAtTop, externalPanOnly, progressSV, dragActiveSV, onTouchStart, mapMode,
    compact,
}, ref) {
    const themed = useTheme();
    const colors = colorsProp ?? themed;
    const isDark = useResolvedScheme() === 'dark';
    const insets = useSafeAreaInsets();
    const styles = useMemo(() => makeStyles(colors, isDark), [colors, isDark]);

    const hasSheet = sheet != null;
    const maxStage = sheet?.maxStage ?? 2;
    // Has a full detent (and, there, docks edge-to-edge). ALL sheets share ONE
    // geometry now: a symmetric floating gap when collapsed that shrinks equally
    // on the sides AND bottom, reaching an edge-to-edge dock at full — the bar
    // row stays screen-fixed throughout (see p / barRowStyle).
    const dockAtLast = hasSheet && maxStage >= 2;
    // Reserve the grabber strip ALWAYS — even a sheet-less bar keeps the space,
    // so the pill's presence/absence never shifts the bar content; only the
    // grabber itself toggles. The bar content is centred in (barRowHeight + peek)
    // so its top gap (holding the grabber) matches its bottom gap.
    const peek = PEEK;

    // ── STANDARD detents (fixed, content-independent) ─────────────────────────
    // Collapsed height brackets the bar row with an EQUAL peek above (grabber)
    // and below (gap), so the bar content is vertically centred in the dock.
    const collapsedH = barRowHeight + 2 * peek;
    const mediumH = Math.max(Math.round(SCREEN_H * MEDIUM_FRACTION), collapsedH + 160);
    // Full is edge-to-edge (clip bottom → 0), spanning up to just under the
    // status bar. ONE rule, no per-host variant: every dock host hides the
    // native nav bar and draws its own in-screen chrome (CollapsingHeader's
    // custom bar, the map's floating chips), which the expanded sheet
    // legitimately covers (see wrap's zIndex note). A screen wanting a real
    // native header can't host this sheet — the navigator owns that strip.
    const fullH = SCREEN_H - insets.top;

    // Distance from the screen bottom to the TOP of the (screen-fixed) bar row.
    // The collapsed dock floats a SYMMETRIC COLLAPSED_MARGIN from the left, right
    // AND bottom screen edges (no safe-area term — that made the bottom gap look
    // bigger than the sides). Identical for every sheet. Peek excluded.
    const collapsedClearance = COLLAPSED_MARGIN + barRowHeight + 2 * peek;
    useEffect(() => { onCollapsedClearance?.(collapsedClearance); }, [collapsedClearance, onCollapsedClearance]);
    const snaps = useMemo(
        () => (!hasSheet ? [collapsedH]
            : maxStage >= 2 ? [collapsedH, mediumH, fullH]
            : [collapsedH, mediumH]),
        [hasSheet, maxStage, collapsedH, mediumH, fullH],
    );
    const lastIdx = snaps.length - 1;

    const h = useSharedValue(collapsedH);
    const startH = useSharedValue(collapsedH);
    const snapsSV = useSharedValue(snaps);
    useEffect(() => { snapsSV.value = snaps; }, [snaps, snapsSV]);

    const draggingRef = useRef(false);
    const draggingSV = useSharedValue(false);
    const stageRef = useRef(0);
    const [stage, setStageState] = useState(0);
    // Report occlusion (sheet-top distance from the screen bottom) per settled
    // detent, so a map host can inset its frame to exactly the visible area.
    // Collapsed matches collapsedClearance; medium/full grow up to the snap
    // height (the float margin shrinks to 0 as it docks).
    useEffect(() => {
        if (!onOcclusion) return;
        const height = snaps[Math.min(stage, snaps.length - 1)];
        // Same rule as the clip's own margin: only a sheet with a FULL detent
        // gives up its float, so a medium-max sheet occludes its margin at every
        // stage and a map host insets to the frame it can actually see.
        const prog = floatCollapseProgress(snaps, height);
        onOcclusion(Math.round(COLLAPSED_MARGIN * (1 - prog) + height));
    }, [stage, snaps, onOcclusion]);

    // ── In-sheet pane pager (SheetSpec.pane) ──────────────────────────────────
    // The ShoppingSheet pager, promoted into the sheet: the incoming page sits
    // in normal layout and slides to rest, the outgoing page is a frozen
    // snapshot absolutely stacked on top sliding away, removed when the tween
    // lands. All manual translate on a shared value — NO reanimated
    // entering/exiting layout animations, which are unreliable inside this
    // animated-height ScrollView on Fabric (they were the pane path's only
    // divergence from the root path, and the share pane misbehaved for it).
    const paneSpec = sheet?.pane ?? null;
    const paneKey = paneSpec?.key ?? null;
    /** Pane machinery in use at all (even when showing the root). */
    const paneEnabled = hasSheet && sheet!.pane !== undefined;
    // What the sheet is currently showing — the pane owns BOTH slots at once
    // (its own bar row replaces the action row; see SheetPaneSpec.barRow).
    const shownContent = paneSpec ? paneSpec.content : sheet?.content;
    const shownBarRow = paneSpec ? paneSpec.barRow : barRow;
    // Latest pane spec for the collapse hook below — a ref so setStageJS need
    // not rebuild (and re-wire the pan) every time the host re-renders.
    const paneRef = useRef(paneSpec);
    paneRef.current = paneSpec;
    const prevPaneKeyRef = useRef(paneKey);
    // Previous render's slots — the outgoing snapshot when a swap starts.
    const lastShownRef = useRef({ content: shownContent, barRow: shownBarRow });
    const paneSeqRef = useRef(0);
    const [paneTransition, setPaneTransition] = useState<{
        content: ReactNode; barRow: ReactNode; dir: 1 | -1; seq: number;
    } | null>(null);
    const paneSlide = useSharedValue(1);  // 1 = settled
    const paneDir = useSharedValue(1);    // +1 forward (in from right), -1 back
    if (paneKey !== prevPaneKeyRef.current) {
        // Render-phase state adjustment (the sanctioned React pattern) — the
        // outgoing snapshot must be LAST render's nodes, which only exist
        // here. Shared values are NOT written during render (that warns); the
        // effect below starts the tween. A swap while the sheet is collapsed
        // (the auto-dismiss on collapse) applies instantly instead — the
        // content is invisible at stage 0, and the next open must show the
        // root at rest, not mid-slide.
        prevPaneKeyRef.current = paneKey;
        if (stageRef.current > 0) {
            paneSeqRef.current += 1;
            setPaneTransition({
                ...lastShownRef.current,
                dir: paneKey != null ? 1 : -1,
                seq: paneSeqRef.current,
            });
        }
    }
    lastShownRef.current = { content: shownContent, barRow: shownBarRow };
    const endPaneTransition = useCallback((seq: number) => {
        // Seq guard: a swap during a swap starts a NEWER transition whose own
        // completion must be the one that clears it.
        setPaneTransition(cur => (cur && cur.seq === seq ? null : cur));
    }, []);
    // LAYOUT effect, deliberately: it runs in the same commit that swaps the
    // page nodes in, so the slide's start value is queued to the UI thread
    // before the frame that mounts the incoming page — a plain effect let
    // that page paint one settled frame at rest, then jump offscreen and
    // slide (the ShoppingSheet pager starts its tween in the same task as
    // its setState for exactly this reason). Shared values are written here,
    // never in render — that warns.
    useLayoutEffect(() => {
        if (!paneTransition) return;
        paneDir.value = paneTransition.dir;
        paneSlide.value = 0;
        const seq = paneTransition.seq;
        paneSlide.value = withTiming(1, { duration: PANE_SLIDE_MS, easing: Easing.out(Easing.cubic) }, (finished) => {
            if (finished) runOnJS(endPaneTransition)(seq);
        });
        // Each page starts at its own top — a pane must never inherit the
        // root's scroll offset (or vice versa on the way back).
        scrollRef.current?.scrollTo?.({ y: 0, animated: false });
    }, [paneTransition, paneDir, paneSlide, endPaneTransition]);
    const paneInStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: interpolate(paneSlide.value, [0, 1], [paneDir.value * SCREEN_W, 0]) }],
    }));
    const paneOutStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: interpolate(paneSlide.value, [0, 1], [0, -paneDir.value * SCREEN_W]) }],
    }));
    // A pane's bar row is a page HEADER — it pins to the sheet's TOP even when
    // the host's root bar row is a bottom bar (the tab dock). Every earlier
    // pane host happened to be a `barAtTop` sheet, so the pane bar landing in
    // the root row's (bottom) slot went unseen until the tab dock hosted a
    // pane and its "‹ title" row rendered BELOW the pane body. paneTopP
    // (0 root → 1 pane) morphs the CONTENT region between the two geometries
    // in step with the page slide; it stays 0 for pane-less sheets, and
    // barAtTop hosts never read it (their content is below the top bar in
    // both states already).
    const paneShowing = paneSpec != null;
    const paneTopP = useSharedValue(paneShowing ? 1 : 0);
    // LAYOUT effect for the same reason the page slide uses one: the morph
    // must be queued in the commit that swaps the rows, or the new page paints
    // one settled frame in the OLD geometry before the tween starts.
    useLayoutEffect(() => {
        // Collapsed swaps are INSTANT, matching the pager's instant swap at
        // stage 0 — the next open must start at rest, not mid-morph.
        paneTopP.value = stageRef.current > 0
            ? withTiming(paneShowing ? 1 : 0, { duration: PANE_SLIDE_MS, easing: Easing.out(Easing.cubic) })
            : (paneShowing ? 1 : 0);
    }, [paneShowing, paneTopP]);

    // DISCOVERABILITY PULSE: while the sheet sits COLLAPSED (stage 0) the grabber
    // pill glows pink (colors.primary) and flashes on a ~2.7s cadence — a grow +
    // brighten, then a long hold — so users notice the bar lifts. Stops the moment
    // the sheet leaves stage 0 (and never runs on a sheet-less bar).
    //
    // FINITE (perf audit finding 3): a small number of cycles, not withRepeat(-1)
    // — an infinite repeat kept the UI thread (and, before the Android blur was
    // dropped, a software re-blur) busy FOREVER on idle screens. Each return to
    // stage 0 re-arms a fresh finite hint, and the sequence ends at 0 so the
    // pill settles to its plain look. First interaction (leaving stage 0) still
    // cancels it immediately via the else-branch timing.
    const pillPulse = useSharedValue(0);
    const pillHinting = hasSheet && stage === 0;
    useEffect(() => {
        pillPulse.value = pillHinting
            ? withRepeat(withSequence(
                withTiming(1, { duration: 460 }),
                withTiming(0, { duration: 460 }),
                withDelay(1800, withTiming(0, { duration: 0 })),
            ), 4, false)
            : withTiming(0, { duration: 200 });
    }, [pillHinting, pillPulse]);
    const pillPulseStyle = useAnimatedStyle(() => ({
        opacity: 0.8 + 0.2 * pillPulse.value,
        transform: [{ scaleX: 1 + 0.5 * pillPulse.value }, { scaleY: 1 + 0.35 * pillPulse.value }],
    }));

    const onStageChange = sheet?.onStageChange;
    const onActiveChange = sheet?.onActiveChange;
    const setStageJS = useCallback((s: number) => {
        stageRef.current = s;
        setStageState(s);
        onStageChange?.(s);
        // Collapsing CLOSES any open pane (SheetPaneSpec.onDismiss). This is
        // the component's guarantee, not the host's: every path to stage 0
        // (drag snap, pill tap, imperative collapse) funnels through here, so
        // a re-opened sheet always starts on the root — the collapsed bar
        // gives no hint a pane is open, and a stale one would be a mystery
        // screen. Fired after onStageChange so hosts observe the stage first.
        if (s === 0) paneRef.current?.onDismiss();
    }, [onStageChange]);
    const setActiveJS = useCallback((a: boolean) => {
        draggingRef.current = a;
        onActiveChange?.(a);
    }, [onActiveChange]);

    const springTo = useCallback((idx: number) => {
        const i = Math.max(0, Math.min(idx, snapsSV.value.length - 1));
        h.value = withSpring(snapsSV.value[i], SNAP_SPRING);
    }, [h, snapsSV]);

    // Re-settle to the current stage if the detents change (bar height measured,
    // rotation) without a drag in flight.
    useEffect(() => {
        if (draggingRef.current) return;
        const i = Math.min(stageRef.current, snaps.length - 1);
        h.value = withSpring(snaps[i], SNAP_SPRING);
    }, [snaps, h]);

    // ── Content scroll (only at the last detent) ──────────────────────────────
    const scrollRef = useRef<any>(null);
    const scrollY = useSharedValue(0);
    const onScroll = useAnimatedScrollHandler((e) => { scrollY.value = e.contentOffset.y; });
    // Leaving the last stage resets scroll to top so the next open starts clean.
    useEffect(() => {
        if (stage < lastIdx) scrollRef.current?.scrollTo?.({ y: 0, animated: false });
    }, [stage, lastIdx]);

    const snapEnd = useCallback((velocityY: number) => {
        'worklet';
        const sn = snapsSV.value;
        const cur = h.value;
        let idx = 0, best = 1e9;
        for (let i = 0; i < sn.length; i++) { const d = Math.abs(sn[i] - cur); if (d < best) { best = d; idx = i; } }
        if (velocityY < -500 && idx < sn.length - 1) idx++;
        else if (velocityY > 500 && idx > 0) idx--;
        h.value = withSpring(sn[idx], { ...SNAP_SPRING, velocity: -velocityY });
        draggingSV.value = false;
        runOnJS(setStageJS)(idx);
        runOnJS(setActiveJS)(false);
    }, [h, snapsSV, draggingSV, setStageJS, setActiveJS]);

    useImperativeHandle(ref, (): DockedSheetControls => ({
        expand: () => { setStageJS(1); springTo(1); },
        collapse: () => { setStageJS(0); springTo(0); },
        snapTo: (idx) => { const i = Math.max(0, Math.min(idx, snaps.length - 1)); setStageJS(i); springTo(i); },
        height: () => h.value,
        toggle: () => { const to = stageRef.current === 0 ? 1 : 0; setStageJS(to); springTo(to); },
        dragTo: (px) => {
            const sn = snapsSV.value;
            h.value = Math.max(sn[0], Math.min(sn[sn.length - 1], px));
        },
        dragEnd: (velocityY) => {
            const sn = snapsSV.value;
            const cur = h.value;
            let idx = 0, best = Infinity;
            for (let i = 0; i < sn.length; i++) { const d = Math.abs(sn[i] - cur); if (d < best) { best = d; idx = i; } }
            if (velocityY < -500 && idx < sn.length - 1) idx++;
            else if (velocityY > 500 && idx > 0) idx--;
            setStageJS(idx); springTo(idx);
        },
    }), [setStageJS, springTo, snaps.length, h, snapsSV]);

    // ── One worklet-driven pan (scroll-aware handoff) ─────────────────────────
    const grabY = useSharedValue(0);
    const grabX = useSharedValue(0);
    const pan = useMemo(() => {
        let g = Gesture.Pan()
            .enabled(hasSheet && !externalPanOnly)
            .simultaneousWithExternalGesture(scrollRef)
            .onBegin((e) => { 'worklet'; grabY.value = e.absoluteY; grabX.value = e.absoluteX; if (dragActiveSV) dragActiveSV.value = true; if (onTouchStart) runOnJS(onTouchStart)(); });
        if (mapMode) {
            // Over a live native map: activate DECLARATIVELY on either axis so
            // RNGH claims the drag on the native thread (cancelling the map) and
            // OWNS every drag on the sheet — a manual path is starved and any drag
            // it fails on falls through to pan the map. 6px in any direction wins
            // it here; the drag itself only moves the sheet vertically (onUpdate).
            g = g.activeOffsetX([-6, 6]).activeOffsetY([-6, 6]);
        } else {
            g = g.manualActivation(true).onTouchesMove((e, sm) => {
                'worklet';
                if (e.state === State.ACTIVE) return;
                const t = e.allTouches[0];
                if (!t) return;
                const dy = t.absoluteY - grabY.value;
                const dx = t.absoluteX - grabX.value;
                if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) { sm.fail(); return; }
                if (Math.abs(dy) < 4) return;                    // taps stay taps
                if (Math.abs(dy) <= Math.abs(dx) * 1.5) return;  // not vertical-dominant
                const sn = snapsSV.value;
                if (sn.length <= 1) { sm.fail(); return; }
                const atFull = h.value >= sn[sn.length - 1] - 2;
                // Below full: the sheet always owns the drag (scroll is off).
                // At full: the list owns UPWARD drags; a downward drag at the
                // list's top collapses the sheet.
                if (!atFull || (dy > 0 && scrollY.value <= 1)) sm.activate();
                else sm.fail();
            });
        }
        g = g
            .onStart(() => {
                'worklet';
                startH.value = h.value;
                draggingSV.value = true;
                runOnJS(setActiveJS)(true);
            })
            .onUpdate((e) => {
                'worklet';
                const sn = snapsSV.value;
                const lo = sn[0], hi = sn[sn.length - 1];
                // At full, a DOWNWARD drag while the list is scrolled must scroll
                // the list (simultaneous), not collapse the sheet. (mapMode activates
                // on every drag, so this handoff moves here from onTouchesMove.)
                if (startH.value >= hi - 2 && e.translationY > 0 && scrollY.value > 1) {
                    startH.value = hi + e.translationY; h.value = hi; return;
                }
                let nh = startH.value - e.translationY;
                if (nh > hi) { startH.value = hi + e.translationY; nh = hi; }
                else if (nh < lo) { startH.value = lo + e.translationY; nh = lo; }
                h.value = nh;
            })
            .onEnd((e) => { 'worklet'; snapEnd(e.velocityY); })
            .onFinalize((_e, success) => {
                'worklet';
                if (dragActiveSV) dragActiveSV.value = false;
                if (success) return;
                draggingSV.value = false;
                runOnJS(setActiveJS)(false);
            });
        if (blockScrollRef) g = g.blocksExternalGesture(blockScrollRef as never);
        return g;
    }, [hasSheet, externalPanOnly, mapMode, snapEnd, h, startH, snapsSV, scrollY, draggingSV, grabX, grabY, setActiveJS, blockScrollRef, dragActiveSV, onTouchStart]);

    // ── ONE progress: 0 collapsed → 1 full (edge-to-edge). Margins, bar-row
    //    counter-offset and content anchor all derive from it, so sides + bottom
    //    grow in lock-step and the bar row never budges. ────────────────────────
    const p = useDerivedValue(() => {
        const sn = snapsSV.value;
        const lo = sn[0], hi = sn[sn.length - 1];
        return hi > lo ? clamp((h.value - lo) / (hi - lo), 0, 1) : 0;
    });
    /**
     * FLOAT-COLLAPSE progress — how far the sheet has given up its floating
     * margins (0 = full symmetric gap on left/right/bottom, 1 = edge-to-edge).
     *
     * Measured against the FULL detent, NOT simply the last snap. A sheet whose
     * deepest detent is MEDIUM (`maxStage: 1`) keeps its float at every stage:
     * without this guard `p` reached 1 at medium and the sheet sat flush against
     * the screen edges while still being a floating panel in every other respect
     * — no solid surface, no squared display corners, since `solidP` below already
     * requires a full detent. Docking is a property of being FULL, not of being
     * as open as this particular sheet goes.
     */
    const dockP = useDerivedValue(() => floatCollapseProgress(snapsSV.value, h.value));
    // Glass→solid + square-corner dock fades over the LAST segment (medium→full).
    const solidP = useDerivedValue(() => {
        const sn = snapsSV.value;
        if (sn.length < 3) return 0;
        const mid = sn[1], hi = sn[sn.length - 1];
        return hi > mid ? clamp((h.value - mid) / (hi - mid), 0, 1) : 0;
    });
    useAnimatedReaction(() => p.value, (v) => { 'worklet'; if (progressSV) progressSV.value = v; }, [progressSV]);

    const cornerR = concentricRadius(insets.bottom, spacing.sm);
    const displayR = displayCornerRadius(insets.bottom);

    // ── Animated styles ───────────────────────────────────────────────────────
    // Symmetric margin: COLLAPSED_MARGIN when collapsed → 0 at full, applied to
    // left/right AND the (visible) bottom gap in lock-step. Bottom corners square
    // off into the display radius as it docks.
    const clipStyle = useAnimatedStyle(() => {
        const m = COLLAPSED_MARGIN * (1 - dockP.value);
        const r = Math.round(cornerR + (displayR - cornerR) * solidP.value);
        return {
            height: h.value,
            left: m,
            right: m,
            bottom: m, // symmetric with the sides; → 0 (edge-to-edge) at full
            borderBottomLeftRadius: r,
            borderBottomRightRadius: r,
            // The whole-clip edge outline (wraps the sheet AND the bar) fades out
            // as it docks — no border once edge-to-edge.
            borderColor: interpolateColor(solidP.value, [0, 1], [colors.outlineVariant, 'transparent']),
        };
    });
    // Bar row held in a FIXED screen box (width BAR_CONTENT_W): its left+bottom
    // offset counter-animate the clip's own shrinking left+bottom, so its screen
    // x AND y are constant at every detent — the glass grows around it.
    const barRowStyle = useAnimatedStyle(() => {
        const off = COLLAPSED_MARGIN * dockP.value;
        // The bar row is inset by `peek` on left/right/bottom (and the grabber
        // sits in the equal peek strip above) so the content's gap to every dock
        // edge matches. The content itself carries NO extra horizontal padding.
        return { left: peek + off, width: BAR_CONTENT_W - 2 * peek, bottom: peek + off };
    });
    // Separator + content ride above the bar row. The bar row's top edge is at
    // (peek + off + barRowHeight); the separator must clear it by another `peek`
    // so its gap to the bar content matches the bar's side/bottom peek — otherwise
    // it lands flush on the X/Basket buttons, which now fill the whole row.
    const barTopStyle = useAnimatedStyle(() => ({
        bottom: barRowHeight + 2 * peek + COLLAPSED_MARGIN * dockP.value,
    }));
    // ── barAtTop layout ───────────────────────────────────────────────────────
    // Bar row pinned to the TOP of the clip (just below the pill). Because the
    // clip grows UPWARD, a top-anchored row RISES with the sheet — it reads as
    // the sheet title moving up. `top` is a CONSTANT peek: the title's gap to
    // the sheet's top edge must never change during the drag. Horizontally the
    // row hugs the clip's edges (left/right: peek), so as the sheet widens
    // toward its edge-to-edge dock the row widens WITH it — the X and the
    // action button gradually spread outward through the stages.
    const barRowTopStyle = useAnimatedStyle(() => ({ left: peek, right: peek, top: peek }));
    // Content revealed BELOW the top bar: top rides just under the title (also a
    // constant gap) and the bottom clips EXACTLY at the sheet's bottom edge
    // (bottom: 0 of the clip — which is the screen bottom once docked at full).
    // Left/right hug the clip's edges like the title row, so the item rows
    // spread outward WITH the sheet as it widens through the stages. The opacity
    // ramp hides the content sliver that would otherwise peek out below the
    // title in the collapsed bar (the clip leaves `peek` of slack there).
    const contentBelowStyle = useAnimatedStyle(() => ({
        left: peek, right: peek,
        top: peek + barRowHeight, bottom: 0,
        opacity: clamp(p.value * 6, 0, 1),
    }));
    // Content region for a BOTTOM-BAR pane host: at the root it is the classic
    // reveal box (below the pill, above the bottom bar); while a pane is open
    // it becomes the barAtTop box — below the pane's TOP header, down to the
    // sheet's bottom edge (the root bar is gone with the pane open, so nothing
    // reserves the bottom strip). paneTopP tweens the two in step with the
    // page slide. At paneTopP = 0 this is EXACTLY the pre-pane geometry.
    const contentPaneAwareStyle = useAnimatedStyle(() => {
        const rootBottom = barRowHeight + 2 * peek + COLLAPSED_MARGIN * dockP.value;
        return {
            top: peek + paneTopP.value * barRowHeight,
            bottom: rootBottom * (1 - paneTopP.value),
        };
    });
    // Scroll fade under the title (barAtTop, full detent): items gradually fade
    // as they slide beneath the title row. Only meaningful once the sheet is
    // solid and actually scrolled (scroll is enabled at full only). Same edge
    // anchoring as the content it covers.
    const topFadeStyle = useAnimatedStyle(() => ({
        left: peek, right: peek,
        top: peek + barRowHeight,
        opacity: solidP.value * clamp(scrollY.value / 32, 0, 1),
    }));
    // Shadow opacity + elevation animate (color/radius/offset are static in the
    // clip style). A `progressiveShadow` panel casts NOTHING while collapsed (the
    // dock behind it already does) and fades its own shadow in as it expands;
    // every other panel keeps a constant barely-there shadow.
    // ANDROID: no `elevation`. An elevation shadow is painted BENEATH the view,
    // and this clip is `overflow:'hidden'` with a TRANSLUCENT fill — so the
    // shadow shows through the surface as a grey wash running inward from every
    // edge. The real blur used to hide it; without one it reads as a grey inner
    // border. The hairline clipEdge still defines the shape on Android.
    const shadowStyle = useAnimatedStyle(() => {
        const k = progressiveShadow ? p.value : 1;
        return Platform.OS === 'android'
            ? { shadowOpacity: 0, elevation: 0 }
            : { shadowOpacity: (isDark ? 0.18 : 0.07) * k, elevation: 3 * k };
    });
    const solidStyle = useAnimatedStyle(() => ({ opacity: solidP.value }));
    // Top rim highlight is part of the edge decoration — fades out with the border.
    const rimStyle = useAnimatedStyle(() => ({ opacity: 1 - solidP.value }));
    const sepStyle = useAnimatedStyle(() => {
        const sn = snapsSV.value;
        const lo = sn[0], hi = sn[sn.length - 1];
        const base = hi > lo ? clamp((h.value - lo) / Math.min(70, hi - lo), 0, 1) : 0;
        // The separator belongs to the root's BOTTOM bar — while a pane's top
        // header owns the sheet it fades out with the root row.
        return { opacity: base * (1 - paneTopP.value) };
    });

    const onExpandTap = useCallback(() => {
        if (stageRef.current === 0) { setStageJS(1); springTo(1); }
        else { setStageJS(0); springTo(0); }
    }, [setStageJS, springTo]);

    // Scroll at the FULL detent whenever one exists (floating or docked).
    const scrollEnabled = hasSheet && maxStage >= 2 && stage === lastIdx;

    // ── COMPACT: content-width, bottom-left floating pill ─────────────────────
    // A plain tab switcher (no sheet, no detents, no animation). Reuses the EXACT
    // glass — GlassFill (blur + tint), styles.clip (border + shadow ink + corner)
    // and styles.rim — so it is visually identical to the full-width docks at
    // rest; only the geometry (hugs its content, anchored bottom-left with the
    // same COLLAPSED_MARGIN float gap) differs. The clip omits left/right/width,
    // so it sizes to the bar row.
    if (compact) {
        return (
            <View style={styles.wrap} pointerEvents="box-none">
                <View
                    style={[
                        styles.clip,
                        styles.clipCompact,
                        {
                            borderRadius: cornerR,
                            left: COLLAPSED_MARGIN,
                            bottom: COLLAPSED_MARGIN + insets.bottom,
                            shadowOpacity: isDark ? 0.18 : 0.07,
                        },
                    ]}
                    pointerEvents="box-none"
                >
                    <GlassFill isDark={isDark} style={styles} />
                    <View pointerEvents="none" style={styles.rim} />
                    <View style={styles.barRowCompact}>{barRow}</View>
                </View>
            </View>
        );
    }

    const panel = (
        <Animated.View
            style={[
                styles.clip,
                { borderRadius: cornerR },
                // left/right/bottom + bottom-radius all come from clipStyle (one
                // symmetric margin that shrinks to the edge-to-edge dock at full).
                clipStyle,
                shadowStyle,
            ]}
            pointerEvents={hasSheet ? 'auto' : 'box-none'}
        >
            {/* CONSTANT GLASS (blur + tint) + a SOLID backdrop that fades in at
                the full detent. */}
            <GlassFill isDark={isDark} style={styles} />
            {dockAtLast && (
                <Animated.View pointerEvents="none" style={[styles.glassFill, styles.solid, solidStyle]} />
            )}
            <Animated.View pointerEvents="none" style={[styles.rim, rimStyle]} />

            {/* CONTENT — default: Find-My reveal (below the pill, above the bar).
                barAtTop: revealed BELOW the top title bar. Scrolls only at full. */}
            {hasSheet && (
                <Animated.View
                    style={[styles.contentClip, barAtTop
                        ? contentBelowStyle
                        // A bottom-bar PANE host morphs between the root box and
                        // the pane's below-the-header box; pane-less hosts keep
                        // the exact static pair (contentPaneAwareStyle equals it
                        // at paneTopP = 0, but stays off their render path).
                        : paneEnabled ? contentPaneAwareStyle : [{ top: peek }, barTopStyle]]}
                    pointerEvents="box-none"
                >
                    <AnimatedScroll
                        ref={scrollRef}
                        style={StyleSheet.absoluteFill}
                        // A pane host's scroll content is STRETCHED to the
                        // viewport (flexGrow) so the showing page always spans
                        // the sheet's full detent — a pane shorter than the
                        // viewport must still own the whole open sheet, not
                        // end mid-air at its content's height. Hosts without
                        // panes keep their exact previous layout.
                        contentContainerStyle={paneEnabled
                            ? [styles.paneGrow, sheet!.contentContainerStyle]
                            : sheet!.contentContainerStyle}
                        scrollEnabled={scrollEnabled}
                        showsVerticalScrollIndicator={scrollEnabled}
                        onScroll={onScroll}
                        scrollEventThrottle={16}
                        bounces={false}
                        overScrollMode="never"
                    >
                        <SheetSolidContext.Provider value={solidP}>
                            {paneEnabled ? (
                                /* Pane pager (see SheetSpec.pane): the showing
                                   page slides to rest; during a swap the
                                   previous page is a frozen snapshot stacked
                                   absolutely on top, sliding out the other
                                   way. The sheet's own clip bounds the slide,
                                   so no extra overflow wrapper is needed. */
                                <View style={styles.paneGrow}>
                                    <Animated.View style={[styles.paneGrow, paneInStyle]}>
                                        {shownContent}
                                    </Animated.View>
                                    {paneTransition && (
                                        <Animated.View
                                            style={[styles.paneOutgoing, paneOutStyle]}
                                            pointerEvents="none"
                                        >
                                            {paneTransition.content}
                                        </Animated.View>
                                    )}
                                </View>
                            ) : sheet!.content}
                        </SheetSolidContext.Provider>
                    </AnimatedScroll>
                </Animated.View>
            )}

            {hasSheet && !barAtTop && (
                <Animated.View pointerEvents="none" style={[styles.separator, barTopStyle, sepStyle]} />
            )}

            {/* Scroll fade (barAtTop): a short surface→transparent gradient just
                below the title row, so items dissolve as they scroll under it. */}
            {hasSheet && barAtTop && (
                <Animated.View pointerEvents="none" style={[styles.topFade, topFadeStyle]}>
                    <Svg width="100%" height="100%">
                        <Defs>
                            <SvgLinearGradient id="dockTopFade" x1="0" y1="0" x2="0" y2="1">
                                <Stop offset="0" stopColor={colors.sheetSurface} stopOpacity="1" />
                                <Stop offset="1" stopColor={colors.sheetSurface} stopOpacity="0" />
                            </SvgLinearGradient>
                        </Defs>
                        <Rect x="0" y="0" width="100%" height="100%" fill="url(#dockTopFade)" />
                    </Svg>
                </Animated.View>
            )}

            {/* BAR ROW — held to a fixed centred box so the content never shifts
                as the glass widens/raises or the pill toggles. Default: pinned at
                the bottom. barAtTop: pinned near the top, rising with the sheet as
                a title. A pane host's row rides the SAME pager slide as the
                content (an open pane OWNS the top row — SheetPaneSpec.barRow),
                so bar and body move as one page. */}
            {(barAtTop || !paneEnabled) ? (
                <Animated.View
                    style={[styles.barRow, { height: barRowHeight }, barAtTop ? barRowTopStyle : barRowStyle]}
                    onLayout={(e: LayoutChangeEvent) => onBarHeight?.(e.nativeEvent.layout.height)}
                    pointerEvents="box-none"
                >
                    {paneEnabled ? (
                        <>
                            <Animated.View style={paneInStyle}>{shownBarRow}</Animated.View>
                            {paneTransition && (
                                <Animated.View
                                    style={[styles.paneBarOutgoing, paneOutStyle]}
                                    pointerEvents="none"
                                >
                                    {paneTransition.barRow}
                                </Animated.View>
                            )}
                        </>
                    ) : barRow}
                </Animated.View>
            ) : (
                /* BOTTOM-BAR pane host: the two rows live in DIFFERENT slots.
                   The ROOT row keeps the bottom bar box; the PANE row is a page
                   header pinned to the sheet's top (barRowTopStyle — the same
                   box a barAtTop title uses). Each still rides the pager slide
                   in its own slot, so bar and body move as one page and the
                   pane's "‹ title" can never render below its body. */
                <>
                    <Animated.View
                        style={[styles.barRow, { height: barRowHeight }, barRowStyle]}
                        onLayout={(e: LayoutChangeEvent) => onBarHeight?.(e.nativeEvent.layout.height)}
                        pointerEvents="box-none"
                    >
                        {paneSpec == null && <Animated.View style={paneInStyle}>{shownBarRow}</Animated.View>}
                        {paneTransition?.dir === 1 && (
                            <Animated.View
                                style={[styles.paneBarOutgoing, paneOutStyle]}
                                pointerEvents="none"
                            >
                                {paneTransition.barRow}
                            </Animated.View>
                        )}
                    </Animated.View>
                    {(paneSpec != null || paneTransition?.dir === -1) && (
                        <Animated.View
                            style={[styles.barRow, { height: barRowHeight }, barRowTopStyle]}
                            pointerEvents="box-none"
                        >
                            {paneSpec != null && <Animated.View style={paneInStyle}>{shownBarRow}</Animated.View>}
                            {paneTransition?.dir === -1 && (
                                <Animated.View
                                    style={[styles.paneBarOutgoing, paneOutStyle]}
                                    pointerEvents="none"
                                >
                                    {paneTransition.barRow}
                                </Animated.View>
                            )}
                        </Animated.View>
                    )}
                </>
            )}

            {/* Grabber pill — rides the clip's top edge. */}
            {hasSheet && (
                <View style={styles.pillWrap} pointerEvents="box-none">
                    <Pressable hitSlop={{ top: 12, bottom: 4, left: 28, right: 28 }} onPress={onExpandTap}>
                        {pillHinting
                            ? <Animated.View style={[styles.pill, { backgroundColor: colors.primary }, pillPulseStyle]} />
                            : <View style={styles.pill} />}
                    </Pressable>
                </View>
            )}
        </Animated.View>
    );

    return (
        <View style={styles.wrap} pointerEvents="box-none">
            {hasSheet ? <GestureDetector gesture={pan}>{panel}</GestureDetector> : panel}
        </View>
    );
});

const makeStyles = (c: AppTheme, isDark: boolean) => {
  const glass = makeGlassLayerStyles(c, isDark);
  return StyleSheet.create({
    // NO horizontal padding — the clip sets its own symmetric left/right/bottom
    // margin (clipStyle). Padding here would offset the sides but not the bottom,
    // making the side gaps wider than the bottom.
    wrap: {
        // FULL-SCREEN box-none (not bottom:0 zero-height). A zero-height wrapper
        // clips Android touch dispatch to a 0px rect, so the absolutely-positioned
        // panel above it never receives touches — they fall through to a map
        // beneath, which grabs the stream and cancels the sheet's pan (confirmed
        // by device logs: onBegin fires, then onFinalize success=false, no
        // onStart). Full-screen bounds let the panel consume its own area while
        // box-none passes empty areas through to the map.
        ...StyleSheet.absoluteFillObject,
        // Above screen chrome (CollapsingHeader overlay = 10): an expanded
        // sheet must cover floating back/search chips, not slide under them.
        zIndex: 20, elevation: 20,
    },
    clip: {
        position: 'absolute',
        overflow: 'hidden',
        // Hairline edge + barely-there shadow ink — shared with GlassSheet via
        // makeGlassLayerStyles. Opacity + elevation come from the animated
        // shadowStyle so a stacked front sheet can fade its shadow in on expand.
        ...glass.clipEdge,
    },
    // COMPACT clip: hugs its content (no left/right/width set → sizes to the bar
    // row); left/bottom/shadowOpacity are applied inline. `elevation` is static
    // here (the full-width clip animates it via shadowStyle). Height = row + 2·PEEK
    // = the full-width dock's collapsed height, so the two bars stand the same tall.
    clipCompact: { elevation: Platform.OS === 'android' ? 0 : 3 },
    barRowCompact: { padding: PEEK },
    // Glass fill / tint / solid / rim — the shared frosted-glass layers.
    glassFill: glass.glassFill,
    tint: glass.tint,
    solid: glass.solid,
    rim: glass.rim,
    contentClip: { position: 'absolute', left: 0, right: 0, overflow: 'hidden' },
    // Pane pager (SheetSpec.pane): the stack and the showing page stretch to
    // the scroll viewport (paired with the flexGrow contentContainerStyle) so
    // the visible page always spans the full detent; the outgoing snapshot is
    // stacked absolutely and keeps its own height for the 280ms slide-away.
    paneGrow: { flexGrow: 1 },
    paneOutgoing: { position: 'absolute', top: 0, left: 0, right: 0 },
    // Outgoing BAR row snapshot: fills the fixed bar box, centred like the
    // live row (the box's own justifyContent only centres direct children).
    paneBarOutgoing: {
        position: 'absolute', top: 0, bottom: 0, left: 0, right: 0,
        justifyContent: 'center',
    },
    // Height of the under-title scroll fade (barAtTop mode).
    topFade: { position: 'absolute', height: 32 },
    // The BAR separator (bar ↔ sheet content) — whisper-thin, subtle.
    separator: {
        position: 'absolute', left: spacing.lg, right: spacing.lg,
        height: StyleSheet.hairlineWidth, backgroundColor: c.dividerBar,
    },
    // Position (top/bottom) comes from the mode-specific animated style
    // (barRowStyle / barRowTopStyle); base only sets absolute + vertical centring.
    barRow: { position: 'absolute', justifyContent: 'center' },
    pillWrap: {
        position: 'absolute', top: 0, left: 0, right: 0,
        alignItems: 'center', paddingTop: 5,
    },
    pill: {
        width: PILL_W, height: PILL_H, borderRadius: radius.pill,
        // Light: a solid mid-gray — c.border washed out to invisible on the
        // near-transparent glass. Dark keeps the theme border tone.
        backgroundColor: isDark ? c.border : 'rgba(60,60,67,0.55)',
    },
  });
};
