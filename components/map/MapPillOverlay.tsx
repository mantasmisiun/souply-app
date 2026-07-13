import React, { useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, Text, View, type ImageSourcePropType } from 'react-native';
import Animated, {
    Easing, runOnJS, useAnimatedStyle, useDerivedValue, useSharedValue, withDelay, withSequence, withTiming,
    type SharedValue,
} from 'react-native-reanimated';
import type { Region } from 'react-native-maps';

/**
 * iOS-ONLY projected pill layer for the results map.
 *
 * GROUND-UP REPLACEMENT for native pill markers. Instrumented on-device runs
 * (2026-07-10) proved the failure lives BELOW React: with stable keys and a
 * child-<Image> marker, every image update was delivered and LOADED at the
 * right size, and zIndex was ordered correctly — yet the legacy
 * AIRMapMarker/MKAnnotationView under the Fabric interop layer intermittently
 * dropped the update (invisible pill) and ignored zPosition (wrong stacking).
 * No JS arrangement of native markers can fix that.
 *
 * So on iOS the pills are NOT markers at all: this layer sits ABOVE the map
 * and projects each pin's lat/lng to screen coordinates with plain Web-Mercator
 * math from the live region (react-native-maps' `onRegionChange` fires
 * continuously during gestures; the region is written to a Reanimated shared
 * value, so every pill repositions on the UI thread with no React re-render).
 *
 * TOUCHES: the whole layer is pointerEvents="none" — pills never intercept a
 * gesture, so panning/zooming the map works even when the drag STARTS on a
 * pill. Taps are routed by the MAP's own onPress: the parent hit-tests the
 * tap point against each pill's projected rect (projectPillRect below) and
 * fires the pill's onPress — same math as the render, so hit === pixel.
 *
 * Requires rotateEnabled={false} and pitchEnabled={false} on the MapView
 * (both already set) — the projection assumes an unrotated Mercator viewport.
 */

export interface OverlayPillSpec {
    id: number;
    latitude: number;
    longitude: number;
    /** Baked pill image (uri) or the chain badge asset. */
    source: ImageSourcePropType;
    /** STABLE identity of `source` (the bake uri / 'badge') — `source` is a
     *  fresh object every render, so image-change detection (which drives the
     *  crossfade transition) compares this instead. */
    sourceKey: string;
    w: number;
    h: number;
    /** true → anchor the geo point near the logo (left edge); false (badge) → centre. */
    isPill: boolean;
    dimmed: boolean;
    z: number;
    onPress: () => void;
    debugId?: string;
}

const mercY = (lat: number): number => {
    'worklet';
    return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
};

const RAD = Math.PI / 180;

/** Per-frame projection constants, computed ONCE per region tick for the whole
 *  layer. Every dot previously ran log/tan math in its own worklet per frame —
 *  with dozens of dots in dense areas (Vilnius) that per-dot trig dominated
 *  the UI thread. Dots now do ~10 arithmetic ops against this frame. */
export interface ProjectionFrame {
    W: number;
    H: number;
    cLng: number;
    mercC: number;
    mercPerPx: number;
}
export function useProjectionFrame(
    region: SharedValue<Region>,
    mapW: SharedValue<number>,
    mapH: SharedValue<number>,
): SharedValue<ProjectionFrame> {
    return useDerivedValue<ProjectionFrame>(() => {
        const r = region.value;
        const W = mapW.value;
        const H = mapH.value;
        return {
            W, H,
            cLng: r.longitude,
            mercC: mercY(r.latitude),
            mercPerPx: W > 0 && r.longitudeDelta > 0 ? (r.longitudeDelta * RAD) / W : 0,
        };
    });
}

/**
 * A pill's on-screen rect for the given region + map size — THE tap hit-test
 * (used from plain JS by the map's onPress) and the exact math the render
 * worklet uses, so what you see is what you hit.
 */
export function projectPillRect(
    pill: { latitude: number; longitude: number; w: number; h: number; isPill: boolean },
    r: Region,
    W: number,
    H: number,
): { left: number; top: number; w: number; h: number } {
    const mercPerPx = (r.longitudeDelta * Math.PI / 180) / W;
    const x = W / 2 + ((pill.longitude - r.longitude) * Math.PI / 180) / mercPerPx;
    const y = H / 2 + (mercY(r.latitude) - mercY(pill.latitude)) / mercPerPx;
    return {
        left: x - pill.w * (pill.isPill ? 0.16 : 0.5),
        top: y - pill.h * 0.5,
        w: pill.w,
        h: pill.h,
    };
}

const OverlayPill = React.memo(function OverlayPill({
    pill,
    order,
    frame,
}: {
    pill: OverlayPillSpec;
    /** Stagger index for the entrance animation (z-sorted: important pills last). */
    order: number;
    frame: SharedValue<ProjectionFrame>;
}) {
    const { latitude, longitude, w, h, isPill, dimmed } = pill;
    // Constant per position — precomputed OUTSIDE the per-frame worklet.
    const mercYOwn = mercY(latitude);
    // (memo comparator at the bottom of this component's definition)

    // ── IMAGE TRANSITIONS: crossfade + size/anchor ease. ────────────────────
    // A pill's image changes when its bake changes (combo total → own share,
    // partner badge appearing/disappearing, badge → pill upgrade). Instead of
    // an instant swap: the OLD image fades out over the NEW one while the
    // container's width/height and anchor ease to the new geometry — the
    // positioning worklet reads these shared values, so the pill stays glued
    // to its geo point THROUGH the resize.
    const wSV = useSharedValue(w);
    const hSV = useSharedValue(h);
    const anchorSV = useSharedValue(isPill ? 0.16 : 0.5);
    // Outgoing-image fade. FLASH-PROOF BY CONSTRUCTION: the CURRENT image is
    // the always-opaque BOTTOM layer; the OUTGOING image mounts as a fresh TOP
    // layer (PrevImgLayer below) that OWNS its fade shared value — created at
    // 1 on mount (deterministic, no JS→UI race) and animated to 0 from its own
    // effect. No shared value is ever written during render (Reanimated
    // strict-mode rule; the earlier render-phase write warned on every morph).
    const [prevImg, setPrevImg] = useState<{ source: ImageSourcePropType; w: number; h: number; token: number } | null>(null);
    const lastImgRef = useRef({ key: pill.sourceKey, source: pill.source, w, h });
    const tokenRef = useRef(0);
    const pendingMorphRef = useRef(false);
    const clearPrev = () => setPrevImg(null);
    // Render-phase change detection (derived-state-during-render pattern —
    // setState + ref writes only).
    if (lastImgRef.current.key !== pill.sourceKey) {
        const last = lastImgRef.current;
        setPrevImg({ source: last.source, w: last.w, h: last.h, token: ++tokenRef.current });
        lastImgRef.current = { key: pill.sourceKey, source: pill.source, w, h };
        pendingMorphRef.current = true;
    }
    useEffect(() => {
        const ease = { duration: 350, easing: Easing.inOut(Easing.cubic) };
        if (pendingMorphRef.current) {
            pendingMorphRef.current = false;
            wSV.value = withTiming(w, ease);
            hSV.value = withTiming(h, ease);
            anchorSV.value = withTiming(isPill ? 0.16 : 0.5, ease);
        } else {
            // Same image — just echo any size-prop drift without animating.
            wSV.value = w;
            hSV.value = h;
            anchorSV.value = isPill ? 0.16 : 0.5;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pill.sourceKey, w, h, isPill]);

    // ── ENTRANCE: staggered pop — ONE controlled overshoot that lands dead. ──
    // A back-easing timing, not a free spring: the spring's post-arrival
    // oscillation read as the animation "continuing" after the pill appeared.
    // Runs once per MOUNT — new pins from "Paskaičiuoti dar" pop in the same
    // way, while persisting pins (stable keys) never re-animate.
    const appear = useSharedValue(0);
    useEffect(() => {
        appear.value = withDelay(
            order * 45,
            withTiming(1, { duration: 300, easing: Easing.out(Easing.back(1.7)) }),
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── UPGRADE POP: badge→pill (or a re-bake that changes the size) gets a
    // small crisp dip-and-land — no oscillation after it settles.
    const bump = useSharedValue(1);
    const bumpKey = `${isPill}:${Math.round(w)}x${Math.round(h)}`;
    const firstBumpRef = useRef(true);
    useEffect(() => {
        if (firstBumpRef.current) { firstBumpRef.current = false; return; }
        bump.value = withSequence(
            withTiming(0.92, { duration: 60 }),
            withTiming(1, { duration: 140, easing: Easing.out(Easing.quad) }),
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bumpKey]);

    const style = useAnimatedStyle(() => {
        // Web-Mercator projection via the shared per-frame constants — the
        // scale comes ONLY from longitudeDelta (Mercator is isotropic; see
        // useProjectionFrame). Cheap arithmetic only, no per-dot trig.
        const f = frame.value;
        if (f.W <= 0 || f.H <= 0 || f.mercPerPx <= 0) {
            return { opacity: 0, transform: [{ translateX: -1e4 }, { translateY: 0 }, { scale: 1 }] };
        }
        const x = f.W / 2 + ((longitude - f.cLng) * RAD) / f.mercPerPx;
        const y = f.H / 2 + (f.mercC - mercYOwn) / f.mercPerPx;
        // The geographic point sits at the pill's anchor: near the logo for a
        // baked pill (matches the old marker's anchorBaked), centre for a badge.
        // Size + anchor come from the TRANSITION shared values, so the pill
        // stays glued to its geo point while it morphs between images.
        const cw = wSV.value;
        const ch = hSV.value;
        const left = x - cw * anchorSV.value;
        const top = y - ch * 0.5;
        const off = x < -f.W * 0.5 || x > f.W * 1.5 || y < -f.H * 0.5 || y > f.H * 1.5;
        return {
            width: cw,
            height: ch,
            opacity: (off ? 0 : dimmed ? 0.4 : 1) * Math.min(1, appear.value),
            transform: [
                { translateX: left },
                { translateY: top },
                { scale: appear.value * bump.value },
            ],
        };
    });
    // NO zIndex on the pill: on Fabric a positioned view with zIndex stacks
    // against ANCESTOR siblings too — pills escaped this overlay and painted
    // over the results sheet. Stacking among pills comes purely from sibling
    // order (MapPillOverlay renders them sorted by z, selected last = on top),
    // and the zIndex-free tree keeps the sheet (a later sibling) above the map.
    return (
        <Animated.View style={[styles.pill, style]}>
            {/* BOTTOM: the current image, always fully opaque. */}
            <View style={styles.imgLayer}>
                <Image source={pill.source} style={{ width: w, height: h }} resizeMode="contain" />
            </View>
            {/* TOP: the outgoing image — keyed per morph so it MOUNTS opaque
                (its own fade value, created at 1) and fades out over the new. */}
            {prevImg && (
                <PrevImgLayer key={`prev-${prevImg.token}`} img={prevImg} onDone={clearPrev} />
            )}
        </Animated.View>
    );
}, (a, b) =>
    // VALUE comparator: the pills array rebuilds whenever a bake lands or the
    // selection flips — without this, every pill re-ran its (heavy) body. The
    // onPress closure is deliberately ignored (stable in behaviour: it wraps a
    // stable handler + a constant storeId).
    a.pill.id === b.pill.id && a.pill.sourceKey === b.pill.sourceKey &&
    a.pill.latitude === b.pill.latitude && a.pill.longitude === b.pill.longitude &&
    a.pill.w === b.pill.w && a.pill.h === b.pill.h && a.pill.isPill === b.pill.isPill &&
    a.pill.dimmed === b.pill.dimmed && a.pill.z === b.pill.z && a.order === b.order);

/** The outgoing pill image: owns its fade (starts at 1 on mount — no render
 *  writes, no races) and clears itself from the parent when done. */
function PrevImgLayer({ img, onDone }: {
    img: { source: ImageSourcePropType; w: number; h: number };
    onDone: () => void;
}) {
    const fade = useSharedValue(1);
    useEffect(() => {
        fade.value = withTiming(0, { duration: 350, easing: Easing.inOut(Easing.cubic) }, (f) => { if (f) runOnJS(onDone)(); });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const st = useAnimatedStyle(() => ({ opacity: fade.value }));
    return (
        <Animated.View style={[styles.imgLayer, st]}>
            <Image source={img.source} style={{ width: img.w, height: img.h }} resizeMode="contain" />
        </Animated.View>
    );
}

// MEMOIZED (with a memoized `pills` array from the parent): the map re-renders
// several times a second during live reclustering — the pills subtree must
// skip reconciliation entirely when nothing about the pills changed.
export const MapPillOverlay = React.memo(function MapPillOverlay({
    pills,
    region,
    mapW,
    mapH,
}: {
    pills: OverlayPillSpec[];
    region: SharedValue<Region>;
    mapW: SharedValue<number>;
    mapH: SharedValue<number>;
}) {
    // Render lowest-z first so sibling order and zIndex agree (deterministic
    // stacking — the selected pin's pill is ALWAYS on top). The entrance
    // stagger follows the same order: neutral pills pop first, the
    // recommended/selected ones land last, on top — a small crescendo.
    const frame = useProjectionFrame(region, mapW, mapH);
    const sorted = [...pills].sort((a, b) => a.z - b.z);
    return (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
            {sorted.map((p, i) => (
                <OverlayPill key={p.id} pill={p} order={i} frame={frame} />
            ))}
        </View>
    );
});

// ── iOS DIRECTORY OVERLAY (clusters + un-priced store logos) ────────────────
// Same projected-overlay approach as the pills, for the un-priced directory
// layer: cluster count bubbles are plain RN Views (no bakery needed at all)
// and singles are plain Images — nothing touches the native marker system, so
// the churny re-bucketing on zoom can't hit the AIRMap nil-insert crash and
// needs NO native rebuild. Layer is pointerEvents="none"; taps are hit-tested
// by the map's onPress in the parent (same as the pills).

/**
 * A fixed-size overlay element glued to a geo point (centre-anchored).
 * CLUSTER CHOREOGRAPHY: `fromLat/fromLng` make the dot FLY from that geo point
 * to its own on mount (a single splitting out of a cluster, a merged cluster
 * arriving from its dominant predecessor). `ghost` inverts it: the dot flies
 * from its own point TOWARD `latitude/longitude` while fading out (a swallowed
 * dot converging into the cluster that absorbed it). The interpolation happens
 * in GEO space inside the projection worklet, so a flying dot stays correctly
 * glued while the map itself pans/zooms mid-animation.
 * NO `exiting` layout animation anywhere: those fight the animated opacity and
 * their per-remount registrations stalled the JS thread during gestures.
 */
function OverlayDot({
    latitude,
    longitude,
    fromLat,
    fromLng,
    ghost = false,
    snapRef,
    w,
    h,
    dimmed = false,
    frame,
    children,
}: {
    latitude: number;
    longitude: number;
    fromLat?: number;
    fromLng?: number;
    ghost?: boolean;
    /** REF (not a prop value!) — true while the source region commit came
     *  mid-gesture: target changes jump instantly instead of gliding. A ref
     *  keeps the live/settle flip from breaking every dot's memo (a boolean
     *  prop re-rendered ~90 dots twice per gesture). */
    snapRef?: React.MutableRefObject<boolean>;
    w: number;
    h: number;
    dimmed?: boolean;
    frame: SharedValue<ProjectionFrame>;
    children: React.ReactNode;
}) {
    const hasFlight = fromLat != null && fromLng != null;
    const fly = useSharedValue(hasFlight ? 0 : 1);
    // Position lives ENTIRELY in one PACKED shared value (the style worklet
    // never reads the props): fewer shared values per dot = cheaper mount
    // bursts at level crossings, and the from/target y-coordinates are stored
    // in MERCATOR space so the per-frame worklet is pure arithmetic (a flight
    // becomes a straight screen-space line — no trig per dot per frame).
    // Target swaps happen in an effect together with the flight reset, so
    // there is no first-frame jump to a new position before the glide starts.
    const pos = useSharedValue({
        fLng: fromLng ?? longitude,
        fMy: mercY(fromLat ?? latitude),
        tLng: longitude,
        tMy: mercY(latitude),
    });
    const appear = useSharedValue(0);
    useEffect(() => {
        appear.value = withTiming(1, { duration: 120 });
        if (hasFlight) fly.value = withTiming(1, { duration: 320, easing: Easing.out(Easing.cubic) });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const mountedRef = useRef(false);
    const lastTargetRef = useRef({ latitude, longitude });
    useEffect(() => {
        if (!mountedRef.current) { mountedRef.current = true; return; }
        const last = lastTargetRef.current;
        if (last.latitude === latitude && last.longitude === longitude) return;
        lastTargetRef.current = { latitude, longitude };
        const tMy = mercY(latitude);
        if (snapRef?.current) {
            // Mid-gesture re-bucket: jump straight to the new target so the dot
            // stays coupled to the pinch (a glide here made dots swim on their
            // own schedule between commits — the "decouple/couple" rhythm).
            pos.value = { fLng: longitude, fMy: tMy, tLng: longitude, tMy };
            fly.value = 1;
            return;
        }
        const cur = pos.value;
        pos.value = { fLng: cur.tLng, fMy: cur.tMy, tLng: longitude, tMy };
        fly.value = 0;
        fly.value = withTiming(1, { duration: 260, easing: Easing.out(Easing.cubic) });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [latitude, longitude]);
    const style = useAnimatedStyle(() => {
        const f = frame.value;
        if (f.W <= 0 || f.H <= 0 || f.mercPerPx <= 0) {
            return { opacity: 0, transform: [{ translateX: -1e4 }, { translateY: 0 }] };
        }
        const p = pos.value;
        const t = fly.value;
        const lng = p.fLng + (p.tLng - p.fLng) * t;
        const my = p.fMy + (p.tMy - p.fMy) * t;
        const x = f.W / 2 + ((lng - f.cLng) * RAD) / f.mercPerPx;
        const y = f.H / 2 + (f.mercC - my) / f.mercPerPx;
        const off = x < -f.W * 0.5 || x > f.W * 1.5 || y < -f.H * 0.5 || y > f.H * 1.5;
        return {
            opacity: (off ? 0 : dimmed ? 0.45 : 1) * appear.value * (ghost ? 1 - t : 1),
            transform: [{ translateX: x - w / 2 }, { translateY: y - h / 2 }],
        };
    });
    return (
        <Animated.View style={[styles.pill, { width: w, height: h }, style]}>
            {children}
        </Animated.View>
    );
}

export interface OverlayClusterSpec {
    id: string;
    latitude: number;
    longitude: number;
    count: number;
    /** Flight origin: the dominant predecessor cluster this one emerged from. */
    fromLat?: number;
    fromLng?: number;
}

export interface OverlaySingleSpec {
    id: number;
    latitude: number;
    longitude: number;
    /** Pre-resolved logo asset (chainPinImage) or null → letter fallback. */
    logo: number | null;
    fallbackColor: string;
    fallbackLetter: string;
    pricing: boolean;
    /** Flight origin: the cluster this store split out of. */
    fromLat?: number;
    fromLng?: number;
}

/** A short-lived exit dot: flies from its own position INTO the absorbing
 *  cluster while fading out. Purged by the parent after the flight. */
export interface OverlayGhostSpec {
    key: string;
    kind: 'cluster' | 'single';
    count?: number;
    logo?: number | null;
    fallbackColor?: string;
    fallbackLetter?: string;
    /** Own (start) position. */
    fromLat: number;
    fromLng: number;
    /** The absorbing cluster's position (flight target). */
    toLat: number;
    toLng: number;
}

/** Width of a cluster bubble for its count (stadium grows for 3+ digits). */
export function clusterBubbleSize(count: number): { w: number; h: number } {
    const big = count >= 25;
    const base = big ? 46 : 36;
    const digits = String(count).length;
    return { w: Math.max(base, 14 + 12 * digits), h: base };
}

// GUARDED Skia singles layer: when the Skia native module is present in this
// binary (it is, since 2026-06-26 builds), the un-priced logo dots render as
// ONE Atlas draw call — zero view mounts, two worklets per frame total. The
// probe never throws: a binary without Skia falls back to the view-based
// singles below. (Module-level require so jest/legacy binaries degrade too.)
let SkiaSinglesLayer: React.ComponentType<{
    singles: OverlaySingleSpec[];
    frame: SharedValue<ProjectionFrame>;
}> | null = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const skiaMod = require('@shopify/react-native-skia');
    if (skiaMod?.Skia && typeof skiaMod.Skia.RSXform === 'function') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        SkiaSinglesLayer = require('./MapSkiaSingles').SkiaSinglesLayer;
    }
} catch {
    SkiaSinglesLayer = null;
}

// MEMOIZED with primitive colour props (an inline colours OBJECT would break
// the memo every parent render) — re-renders only when a re-bucket actually
// changes the cluster/single arrays.
export const MapDirectoryOverlay = React.memo(function MapDirectoryOverlay({
    clusters,
    singles,
    ghosts,
    snapRef,
    region,
    mapW,
    mapH,
    cardBackground,
    primary,
}: {
    clusters: OverlayClusterSpec[];
    singles: OverlaySingleSpec[];
    ghosts: OverlayGhostSpec[];
    /** Ref: the current commit came mid-gesture → persisting dots snap, not glide. */
    snapRef: React.MutableRefObject<boolean>;
    region: SharedValue<Region>;
    mapW: SharedValue<number>;
    mapH: SharedValue<number>;
    cardBackground: string;
    primary: string;
}) {
    const frame = useProjectionFrame(region, mapW, mapH);
    return (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
            {/* Exit ghosts UNDER the live dots: swallowed dots fly into their
                absorbing cluster while fading. */}
            {ghosts.map((g) => (
                <OverlayDot
                    key={g.key} ghost
                    latitude={g.toLat} longitude={g.toLng} fromLat={g.fromLat} fromLng={g.fromLng}
                    w={g.kind === 'cluster' ? clusterBubbleSize(g.count ?? 2).w : 36}
                    h={g.kind === 'cluster' ? clusterBubbleSize(g.count ?? 2).h : 36}
                    frame={frame}
                >
                    {g.kind === 'cluster' ? (
                        <View style={[styles.clusterBubble, { width: clusterBubbleSize(g.count ?? 2).w, height: clusterBubbleSize(g.count ?? 2).h, borderRadius: clusterBubbleSize(g.count ?? 2).h / 2, backgroundColor: cardBackground, borderColor: primary }]}>
                            <Text style={[styles.clusterText, { color: primary }]} allowFontScaling={false}>{g.count}</Text>
                        </View>
                    ) : g.logo != null ? (
                        <Image source={g.logo} style={styles.singleLogo} resizeMode="contain" />
                    ) : (
                        <View style={[styles.fallbackChip, { backgroundColor: g.fallbackColor }]}>
                            <Text style={styles.fallbackText}>{g.fallbackLetter}</Text>
                        </View>
                    )}
                </OverlayDot>
            ))}
            {SkiaSinglesLayer ? (
                <SkiaSinglesLayer singles={singles} frame={frame} />
            ) : (
                singles.map((s) => (
                    <SingleItem key={`d-${s.id}`} s={s} snapRef={snapRef} frame={frame} />
                ))
            )}
            {clusters.map((c) => (
                <ClusterItem key={`c-${c.id}`} c={c} snapRef={snapRef} frame={frame} cardBackground={cardBackground} primary={primary} />
            ))}
        </View>
    );
});

// ── Per-dot memoization ──────────────────────────────────────────────────────
// The spec ARRAYS are rebuilt on every re-bucket commit, so without value
// comparators every dot re-rendered per commit — re-creating its animated-
// style mapper on the UI thread (the pan-commit hitch). With these, a commit
// touches only the dots that actually changed (entered/left/moved/recounted).
const ClusterItem = React.memo(function ClusterItem({ c, snapRef, frame, cardBackground, primary }: {
    c: OverlayClusterSpec;
    snapRef: React.MutableRefObject<boolean>;
    frame: SharedValue<ProjectionFrame>;
    cardBackground: string;
    primary: string;
}) {
    const { w, h } = clusterBubbleSize(c.count);
    return (
        <OverlayDot latitude={c.latitude} longitude={c.longitude} fromLat={c.fromLat} fromLng={c.fromLng} snapRef={snapRef} w={w} h={h} frame={frame}>
            <View style={[styles.clusterBubble, { width: w, height: h, borderRadius: h / 2, backgroundColor: cardBackground, borderColor: primary }]}>
                <Text style={[styles.clusterText, { color: primary }]} allowFontScaling={false}>{c.count}</Text>
            </View>
        </OverlayDot>
    );
}, (a, b) =>
    a.c.id === b.c.id && a.c.latitude === b.c.latitude && a.c.longitude === b.c.longitude &&
    a.c.count === b.c.count && a.c.fromLat === b.c.fromLat && a.c.fromLng === b.c.fromLng &&
    a.cardBackground === b.cardBackground && a.primary === b.primary);

const SingleItem = React.memo(function SingleItem({ s, snapRef, frame }: {
    s: OverlaySingleSpec;
    snapRef: React.MutableRefObject<boolean>;
    frame: SharedValue<ProjectionFrame>;
}) {
    return (
        <OverlayDot latitude={s.latitude} longitude={s.longitude} fromLat={s.fromLat} fromLng={s.fromLng} snapRef={snapRef} w={36} h={36} dimmed={s.pricing} frame={frame}>
            {s.logo != null ? (
                <Image source={s.logo} style={styles.singleLogo} resizeMode="contain" />
            ) : (
                <View style={[styles.fallbackChip, { backgroundColor: s.fallbackColor }]}>
                    <Text style={styles.fallbackText}>{s.fallbackLetter}</Text>
                </View>
            )}
        </OverlayDot>
    );
}, (a, b) =>
    a.s.id === b.s.id && a.s.latitude === b.s.latitude && a.s.longitude === b.s.longitude &&
    a.s.logo === b.s.logo && a.s.pricing === b.s.pricing &&
    a.s.fromLat === b.s.fromLat && a.s.fromLng === b.s.fromLng);

const styles = StyleSheet.create({
    // Positioned purely by the animated transform; must start at the origin.
    // overflow visible: during a shrink transition the old (larger) image may
    // exceed the easing container for a few frames — clipping it would pop.
    pill: { position: 'absolute', left: 0, top: 0, overflow: 'visible' },
    imgLayer: { position: 'absolute', left: 0, top: 0 },
    clusterBubble: {
        alignItems: 'center', justifyContent: 'center', borderWidth: 2,
        shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.25, shadowRadius: 2,
    },
    clusterText: { fontSize: 13, fontWeight: '800' },
    singleLogo: { width: 36, height: 36 },
    fallbackChip: {
        width: 30, height: 30, borderRadius: 15, alignSelf: 'center', marginTop: 3,
        alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#FFFFFF',
    },
    fallbackText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
});
