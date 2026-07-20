import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Image, Platform, StyleSheet, Text, View, type ImageSourcePropType, type ImageURISource, type LayoutChangeEvent } from 'react-native';
import { Marker } from 'react-native-maps';
import { captureRef } from 'react-native-view-shot';
import { chainBadgeImage } from '../../utils/chainLogoAssets';
import { useTheme, type AppTheme } from '../../constants/theme';

/**
 * Reusable map pill (chain logo + text) for BOTH the basket price map and the
 * store-resolution address map.
 *
 * Why the "bakery": a pill is dynamic text → it must be a custom View, which
 * react-native-maps does NOT render as a marker child on Android (new arch,
 * #5877) — the marker collapses to a tiny snapshot, clipping the label to a few
 * letters. So we render the pill OFF-SCREEN at its natural (un-clamped) size,
 * snapshot it to a PNG with react-native-view-shot, and hand the file to the
 * marker's native `image` prop, which DOES render and is never clipped.
 *
 * Two content modes, auto-sized to fit:
 *   • 1 line  → a price pill (28px badge + bold value), the basket map.
 *   • 2 lines → an address pill: street on top, house-number/flat below, with a
 *     BIGGER logo and slightly smaller font; the logo is inset equally from the
 *     left/top/bottom borders (badge height == the two-row text height).
 */

export type MapPillVariant = 'neutral' | 'cheapest' | 'selected' | 'progress';

export interface MapPillSpec {
  /** Identity for caching the baked image — re-bakes only when this changes
   *  (include everything that affects the pixels: id + content + variant).
   *  Progress pills (stage-3 check counts like "2/10") MUST fold the count
   *  into the key, or the baked image goes stale as items get checked. */
  key: string;
  chainId: number;
  /** 1 entry → price pill; 2 entries → address pill (street, number/flat). */
  lines: string[];
  variant: MapPillVariant;
  /** COMBO context (price pills only): the split partners' chains (1 for a
   *  2-store combo, 2 for a 3-store combo). Rendered as badges stacked BEHIND
   *  the pill's own logo, each offset further right — "this store, combined
   *  with those". Empty/absent → single logo. */
  partnerChainIds?: number[];
}

// ── Off-screen renderer: lays a pill out at natural size + snapshots it ──────
function PillShot({ spec, onShot, onFail }: { spec: MapPillSpec; onShot: (key: string, uri: string, w: number, h: number) => void; onFail: (key: string) => void }) {
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const ref = useRef<View>(null);
  const badge = chainBadgeImage(spec.chainId);
  const twoRow = spec.lines.length >= 2;
  const ringStyle = spec.variant === 'neutral' ? styles.ringNeutral : styles.ringAccent;
  const fillStyle = spec.variant === 'selected' ? styles.fillPrimary : styles.fillCard;
  // 'progress' (stage-3 check counts): accent ring + card fill with the count
  // in brand colour — reads as "yours, in progress" without shouting selected.
  const primaryColor = spec.variant === 'selected' ? '#FFFFFF'
    : spec.variant === 'progress' ? colors.primary
    : colors.textPrimary;
  const secondaryColor = spec.variant === 'selected' ? 'rgba(255,255,255,0.85)' : colors.textSecondary;

  // GATE the rounded background on a real layout. RN 0.81's new-arch BackgroundDrawable
  // crashes the whole app ("Required value was null", BackgroundDrawable.kt:121) if a
  // borderRadius view is drawn at a transient 0×0/NaN size — which these continuously-remounted
  // bake views hit during the map's relayout. So borderRadius is applied ONLY once onLayout
  // reports real bounds; until then the view is a plain (un-rounded) bg fill, which is safe.
  const [ready, setReady] = useState(false);
  const [badgeLoaded, setBadgeLoaded] = useState(badge == null);

  const sizeRef = useRef({ w: 0, h: 0 });
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 1 && height > 1) { sizeRef.current = { w: width, h: height }; setReady(true); }
  }, []);

  // Snapshot once the pill is rounded at a real size AND its logo has loaded. onFail (on error
  // or if it never sizes) advances the throttle window so a stuck pill can't block the rest.
  useEffect(() => {
    if (!ready || !badgeLoaded) return;
    const node = ref.current;
    if (!node) return;
    // Wait TWO frames before the snapshot. `ready` flips borderRadius on in a React commit,
    // but the native view may not have re-DRAWN the rounded corners yet in the same tick —
    // capturing immediately grabs the pre-radius shape (the "rectangular pill"). Two rAFs let
    // the rounded corners + badge actually paint before captureRef reads the pixels.
    let cancelled = false;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (cancelled || !ref.current) return;
        captureRef(ref.current, { format: 'png', result: 'tmpfile', quality: 1 })
          .then((uri) => onShot(spec.key, uri, sizeRef.current.w, sizeRef.current.h))
          .catch(() => onFail(spec.key));
      });
    });
    return () => { cancelled = true; cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [ready, badgeLoaded, spec.key, onShot, onFail, twoRow]);

  useEffect(() => {
    if (ready) return;
    const t = setTimeout(() => onFail(spec.key), 2500);
    return () => clearTimeout(t);
  }, [ready, onFail, spec.key]);

  // Laid out, but the badge <Image> never settled: RN 0.81 new-arch (Fabric) can drop
  // onLoad AND onError for a static require()'d image. Without a backstop the capture
  // effect (ready && badgeLoaded) never runs, so this pill never calls onShot/onFail —
  // permanently holding one of the BAKE_CONCURRENCY slots and, if a few stack up,
  // deadlocking the bakery (remaining pills stuck on the bare-badge fallback). Shortly
  // after layout, force the capture to proceed (a bare pill still bakes).
  useEffect(() => {
    if (!ready || badgeLoaded) return;
    const t = setTimeout(() => setBadgeLoaded(true), 900);
    return () => clearTimeout(t);
  }, [ready, badgeLoaded]);

  return (
    <View
      ref={ref}
      collapsable={false}
      style={[styles.pillBorder, ready && (twoRow ? styles.pillRadiusTwoRow : styles.pillRadiusOneRow), ringStyle]}
      onLayout={onLayout}
    >
      <View style={[styles.pillInner, twoRow ? styles.pillInnerTwoRow : styles.pillInnerOneRow, ready && (twoRow ? styles.pillInnerRadiusTwoRow : styles.pillInnerRadiusOneRow), fillStyle]}>
        {badge != null && (() => {
          // COMBO logo stack: own badge on top-left; each split partner's badge
          // behind it, offset a further 14px right (2-store → 1 partner,
          // 3-store → 2). Render deepest partner first so z-order = stack order.
          const partners = !twoRow
            ? (spec.partnerChainIds ?? []).map((id) => chainBadgeImage(id)).filter((b): b is NonNullable<typeof b> => b != null)
            : [];
          if (partners.length === 0) {
            return <Image source={badge} style={twoRow ? styles.badgeTwoRow : styles.badgeOneRow} onLoad={() => setBadgeLoaded(true)} onError={() => setBadgeLoaded(true)} />;
          }
          return (
            <View style={[styles.badgeStackOneRow, { width: 28 + 14 * partners.length }]}>
              {[...partners].reverse().map((src, i) => (
                <Image key={i} source={src} style={[styles.badgeOneRow, { position: 'absolute', top: 0, left: 14 * (partners.length - i) }]} />
              ))}
              <Image source={badge} style={[styles.badgeOneRow, styles.badgePrimary]} onLoad={() => setBadgeLoaded(true)} onError={() => setBadgeLoaded(true)} />
            </View>
          );
        })()}
        {twoRow ? (
          <View style={styles.textColTwoRow}>
            <Text style={[styles.streetText, { color: primaryColor }]} numberOfLines={1} allowFontScaling={false}>
              {spec.lines[0]}
            </Text>
            {spec.lines[1] ? (
              <Text style={[styles.numberText, { color: secondaryColor }]} numberOfLines={1} allowFontScaling={false}>
                {spec.lines[1]}
              </Text>
            ) : null}
          </View>
        ) : (
          <Text style={[styles.valueText, { color: primaryColor }]} numberOfLines={1} allowFontScaling={false}>
            {spec.lines[0]}
          </Text>
        )}
      </View>
    </View>
  );
}

/**
 * Manage the baked-pill images + render the off-screen bakery. Call once per map
 * with the list of pills currently visible; render the returned `bakery` node
 * anywhere in the tree (it positions itself off-screen) and look images up with
 * `uriFor(spec.key)`.
 */
export function useBakedPills(specs: MapPillSpec[]): {
  uriFor: (key: string) => string | undefined;
  /** Baked image's dp size — for the iOS CHILD-image marker path. */
  sizeFor: (key: string) => { uri: string; w: number; h: number } | undefined;
  /** The baked-image map itself (stable identity; changes only when a bake
   *  lands) — memoize derived arrays on this. */
  images: Record<string, { uri: string; w: number; h: number }>;
  /** Keys whose pill has baked, in COMPLETION order. Render markers in this order so the
   *  on-map list only ever grows at the end (append-only) — no mid-list insert (the iOS
   *  AIRMap crash) and no badge→pill in-place swap (the "rectangle"). */
  bakedKeys: string[];
  bakery: React.ReactNode;
} {
  const [uris, setUris] = useState<Record<string, { uri: string; w: number; h: number }>>({});
  // `done` (captured OR failed) drives the throttle window so it advances even on a failed capture.
  const [done, setDone] = useState<Record<string, true>>({});
  const onShot = useCallback((key: string, uri: string, w: number, h: number) => {
    setUris((prev) => (prev[key]?.uri === uri ? prev : { ...prev, [key]: { uri, w, h } }));
    setDone((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  }, []);
  // Bounded RETRY on failure: view-shot capture is flaky under load (the 2.5s
  // watchdog or a transient 0x0 frame) — a permanent fail left the marker a
  // bare badge until something changed its spec key (the "recommended pin
  // missing on load" bug). Remount the shot (attempt-keyed) up to 3 tries.
  const failsRef = useRef<Record<string, number>>({});
  const [, setRetryTick] = useState(0);
  const onFail = useCallback((key: string) => {
    const n = (failsRef.current[key] = (failsRef.current[key] ?? 0) + 1);
    if (__DEV__) console.log(`[BAKERY] FAIL key=${key} attempt=${n}${n >= 3 ? ' (giving up)' : ' (retrying)'}`);
    if (n >= 3) setDone((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
    else setRetryTick((t) => t + 1); // re-render → the shot remounts with a fresh attempt key
  }, []);
  // THROTTLE: bake at most BAKE_CONCURRENCY pills at once. Capturing many rounded views via
  // react-native-view-shot simultaneously floods native/Skia memory and segfaults
  // (SkPath::rewind in View.rebuildOutline) — and froze the UI mid-render. The window advances
  // as each capture finishes or fails, so all pills still bake, just a few at a time.
  const active = specs.filter((s) => !done[s.key]).slice(0, BAKE_CONCURRENCY);
  const bakery = (
    <View style={styles_bakeryHost} pointerEvents="none">
      {active.map((spec) => <PillShot key={`${spec.key}#${failsRef.current[spec.key] ?? 0}`} spec={spec} onShot={onShot} onFail={onFail} />)}
    </View>
  );
  // Object key order is insertion order, and onShot inserts on capture completion → this is
  // the bake-completion order. `images` is the state object itself — a STABLE
  // identity that only changes when a bake lands, so callers can memoize
  // derived arrays on it (uriFor/sizeFor closures are recreated every render).
  return { uriFor: (key) => uris[key]?.uri, sizeFor: (key: string) => uris[key], images: uris, bakedKeys: Object.keys(uris), bakery };
}

const BAKE_CONCURRENCY = 4;
// alignItems:'flex-start' so each off-screen pill sizes to its OWN content width. Without it the
// host's default 'stretch' expands every short pill to the WIDEST pill's width — the "lots of space
// between the name and the right edge" on one-line pills.
const styles_bakeryHost = { position: 'absolute' as const, top: -10000, left: 0, alignItems: 'flex-start' as const };

/**
 * A native-image map marker for a baked pill. Until its image is baked (or for a
 * pill-less point), it falls back to the bare chain badge. Always a NATIVE `image`
 * marker so it renders on Android and is never clipped.
 *
 * NOTE: callers should KEY this marker with the spec identity (and any z-rank) so a
 * variant/price change → a new key → a fresh image; the badge→baked transition is
 * handled reactively by the `image` prop without a remount.
 */
/** Quick stepped fade for the band-visibility flips (combine/separate): map
 *  markers can't run RN Animated, so opacity steps over ~180 ms instead —
 *  4 property updates per marker, only on band crossings. */
function useSteppedFade(hidden: boolean): number {
  // Starts at 0 so markers FADE IN on mount instead of popping. 8×20 ms ≈ a
  // 60 fps-feeling ramp — a native marker's opacity is a plain property, so
  // stepping is the only option (the iOS pill path animates a real child).
  const [v, setV] = useState(0);
  const vRef = useRef(v);
  vRef.current = v;
  useEffect(() => {
    const target = hidden ? 0 : 1;
    if (vRef.current === target) return;
    const from = vRef.current;
    const steps = 8;
    let i = 0;
    const iv = setInterval(() => {
      i++;
      setV(i >= steps ? target : from + (target - from) * (i / steps));
      if (i >= steps) clearInterval(iv);
    }, 20);
    return () => clearInterval(iv);
  }, [hidden]);
  return v;
}

/** iOS live-view fade: the child of a tracksViewChanges marker is a real view,
 *  so a native-driver Animated opacity runs smoothly — the stepped marker
 *  property looked stuttery on selection crossfades. */
function useChildFade(hidden: boolean): Animated.Value {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, { toValue: hidden ? 0 : 1, duration: 180, useNativeDriver: true }).start();
  }, [hidden, anim]);
  return anim;
}

export function MapPillMarker({
  coordinate,
  chainId,
  pillUri,
  pillSize,   // reserved: used by the child-image path once the rebuilt client ships
  dimmed = false,
  hidden = false,
  zIndex = 1,
  anchorBaked = { x: 0.18, y: 0.5 },
  refreshKey,
  onPress,
  debugId,
}: {
  coordinate: { latitude: number; longitude: number };
  chainId: number;
  pillUri?: string;
  /** Baked pill's dp size (from useBakedPills.sizeFor) — sizes the iOS
   *  child-<Image> marker; pass it TOGETHER with pillUri (same bake) so the
   *  child never renders a uri at a stale size. Unused on Android. */
  pillSize?: { w: number; h: number };
  dimmed?: boolean;
  /** Zoom-band visibility WITHOUT unmounting: opacity 0 + taps ignored. Marker
   *  mount/unmount churn is what loses annotation views on iOS — visibility
   *  MUST be a property toggle on a permanently mounted marker. */
  hidden?: boolean;
  zIndex?: number;
  /** Where the geographic point sits on the baked pill — defaults near the logo
   *  on the left (the badge-only fallback always centres). */
  anchorBaked?: { x: number; y: number };
  /** Bump on every camera settle: iOS AIRMap (maps 1.20.1 interop) re-creates
   *  annotation views on zoom, and with tracksViewChanges pinned false the
   *  re-created view never re-rasterises → the pill goes BLANK until a
   *  cluster/single remount. Changing this briefly re-tracks so it repaints. */
  refreshKey?: string | number;
  onPress?: () => void;
  /** DEV diagnostics label (e.g. "797/c5") — enables the [PILL] pipeline logs. */
  debugId?: string;
}) {
  const baked: ImageSourcePropType | null = pillUri ? { uri: pillUri } : null;
  const badge = chainBadgeImage(chainId);
  const source: ImageSourcePropType | null = baked ?? (badge != null ? badge : null);
  const fade = useSteppedFade(hidden);
  const childFade = useChildFade(hidden);
  // Android-only: re-track briefly when the shown image changes so Google Maps
  // re-rasterises the swapped image (tracksViewChanges is honoured there and
  // ignored by Apple Maps). Settling back to false keeps the static map cheap.
  const [tracks, setTracks] = useState(true);
  useEffect(() => {
    setTracks(true);
    const t = setTimeout(() => setTracks(false), 600);
    return () => clearTimeout(t);
  }, [pillUri, refreshKey]);

  // ── [PILL] pipeline diagnostics (DEV, when debugId set) ──────────────────
  // MOUNT/UNMOUNT proves whether React remounts the marker (it should NOT with
  // a stable key); "uri→" proves the prop reached the marker; the child Image's
  // LOADED/ERROR proves whether the new tmpfile decoded. LOADED + still
  // invisible on screen = the native annotation view lost the update (interop).
  const tail = (u?: string) => (u ? `…${u.slice(-14)}` : 'badge');
  useEffect(() => {
    if (!__DEV__ || !debugId) return;
    console.log(`[PILL ${debugId}] MOUNT (uri=${tail(pillUri)} z=${zIndex})`);
    return () => console.log(`[PILL ${debugId}] UNMOUNT`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const prevUriRef = useRef<string | undefined>(pillUri);
  const prevZRef = useRef<number>(zIndex);
  useEffect(() => {
    if (!__DEV__ || !debugId) return;
    if (prevUriRef.current !== pillUri) {
      console.log(`[PILL ${debugId}] uri ${tail(prevUriRef.current)} → ${tail(pillUri)} size=${pillSize ? `${Math.round(pillSize.w)}x${Math.round(pillSize.h)}` : 'none'} dimmed=${dimmed} z=${zIndex}`);
      prevUriRef.current = pillUri;
    }
    if (prevZRef.current !== zIndex) {
      console.log(`[PILL ${debugId}] zIndex ${prevZRef.current} → ${zIndex}`);
      prevZRef.current = zIndex;
    }
  });

  if (source == null) return null;
  // ANDROID ONLY: a fully-faded hidden marker unmounts — Google Maps markers
  // stay natively tappable at opacity 0 (they swallowed "empty" map taps and
  // triggered the default marker-press camera move). Android add/remove is
  // safe; iOS must keep markers mounted (annotation-drop surface).
  if (Platform.OS === 'android' && hidden && fade === 0) return null;

  // iOS: CHILD-<Image> marker (the AIRMapMarker child-insert clamp is verified
  // in the built client — the crash log's signature moved past it). The pill is
  // a plain RN Image child, so an image change is a NORMAL view update:
  //   • repaints reliably (native `image`-prop swaps via setImageSrc silently
  //     BLANK on Apple Maps — the "pill in view but invisible" bug), and
  //   • needs NO marker remount (remount batches are the interop nil-insert
  //     crash/lost-marker surface).
  // The marker itself stays mounted with a stable key; only its child updates.
  // pillSize (dp, captured with the uri by the bakery) sizes the child.
  if (Platform.OS === 'ios') {
    const usePill = baked != null && pillSize != null;
    const childSource = usePill ? baked! : (badge ?? baked!);
    const w = usePill ? pillSize!.w : 30;
    const h = usePill ? pillSize!.h : 30;
    return (
      <Marker
        coordinate={coordinate}
        anchor={usePill ? anchorBaked : { x: 0.5, y: 0.5 }}
        opacity={dimmed ? 0.4 : 1}
        // ALWAYS true on iOS: with false, AIRMap SNAPSHOTS the child view into
        // an image, and Apple Maps' annotation-view recycling on zoom drops
        // that snapshot → blank pill until a remount (the "pill disappears
        // until I re-cluster" report — a brief re-track window on camera
        // settle did NOT reliably overlap the recycling). True = the pill
        // stays a live view, MapKit's native mode; cheap at our pill counts.
        tracksViewChanges={true}
        zIndex={zIndex}
        onPress={hidden ? undefined : (__DEV__ && debugId
          ? () => { console.log(`[PILL ${debugId}] TAP`); onPress?.(); }
          : onPress)}
      >
        <Animated.Image
          source={childSource}
          style={{ width: w, height: h, opacity: childFade }}
          resizeMode="contain"
          onLoad={__DEV__ && debugId ? () => console.log(`[PILL ${debugId}] child Image LOADED ${tail(pillUri)}`) : undefined}
          onError={__DEV__ && debugId ? (e) => console.log(`[PILL ${debugId}] child Image ERROR ${tail(pillUri)}:`, e.nativeEvent?.error) : undefined}
          onLayout={__DEV__ && debugId ? (e) => console.log(`[PILL ${debugId}] child layout ${Math.round(e.nativeEvent.layout.width)}x${Math.round(e.nativeEvent.layout.height)}`) : undefined}
        />
      </Marker>
    );
  }

  // Android: CHILD-LESS image-prop marker — child images don't rasterise inside
  // custom marker views there (new arch, #5877); the image prop never clips.
  return (
    <Marker
      coordinate={coordinate}
      // CENTERED on Android (ignores anchorBaked): Google dispatches a tap on
      // overlapping markers to the NEAREST ANCHOR. With the left-edge (0.18)
      // anchor, most of a pill's width sat nearer a NEIGHBOUR's anchor — taps
      // "selected the pill next to it". A centre anchor makes nearest-anchor =
      // the pill under the finger. iOS keeps the logo-on-point anchor.
      anchor={{ x: 0.5, y: 0.5 }}
      image={source}
      opacity={fade * (dimmed ? 0.4 : 1)}
      tracksViewChanges={tracks}
      zIndex={zIndex}
      onPress={hidden ? undefined : onPress}
    />
  );
}

// ── Cluster bubble (count) ──────────────────────────────────────────────────
// Same off-screen bake as the pills: a child-View `<Marker>` is unreliable on
// Android (Fabric rasterises it at the wrong size → the circle is clipped to a
// corner). Bake to a PNG and use the native `image` prop instead.

export interface MapClusterSpec {
  /** Identity for caching — include the count so the image re-bakes when it changes. */
  key: string;
  count: number;
  /** Larger bubble for dense clusters. */
  big?: boolean;
}

function ClusterShot({ spec, onShot, onFail }: { spec: MapClusterSpec; onShot: (key: string, uri: string) => void; onFail: (key: string) => void }) {
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const ref = useRef<View>(null);
  // Same bounds-gated radius as PillShot (see there): borderRadius applied only once the view
  // has real bounds, so a transient 0×0/NaN frame never hits the new-arch BackgroundDrawable crash.
  const [ready, setReady] = useState(false);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 1 && height > 1) setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    // Double-RAF before capturing (same as PillShot): `ready` applies the
    // borderRadius in this commit, but Android may not have DRAWN it yet when
    // the effect runs — capturing immediately raced the draw and snapshotted
    // SQUARE bubbles (then cached them forever).
    let cancelled = false;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (cancelled || !ref.current) return;
        captureRef(ref.current, { format: 'png', result: 'tmpfile', quality: 1 })
          .then((uri) => onShot(spec.key, uri))
          .catch(() => onFail(spec.key));
      });
    });
    return () => { cancelled = true; cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [ready, spec.key, onShot, onFail]);
  useEffect(() => {
    if (ready) return;
    const t = setTimeout(() => onFail(spec.key), 2500);
    return () => clearTimeout(t);
  }, [ready, onFail, spec.key]);
  return (
    <View
      ref={ref}
      collapsable={false}
      style={[styles.clusterBorder, ready && (spec.big ? styles.clusterRadiusBig : styles.clusterRadius)]}
      onLayout={onLayout}
    >
      <View style={[styles.clusterInner, spec.big && styles.clusterInnerBig, ready && (spec.big ? styles.clusterInnerRadiusBig : styles.clusterInnerRadius)]}>
        <Text style={styles.clusterText} allowFontScaling={false}>{spec.count}</Text>
      </View>
    </View>
  );
}

export function useBakedClusters(specs: MapClusterSpec[]): {
  uriFor: (key: string) => string | undefined;
  bakery: React.ReactNode;
} {
  const [uris, setUris] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Record<string, true>>({});
  const onShot = useCallback((key: string, uri: string) => {
    setUris((prev) => (prev[key] === uri ? prev : { ...prev, [key]: uri }));
    setDone((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  }, []);
  const onFail = useCallback((key: string) => {
    setDone((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  }, []);
  // Same throttle as the pills (see useBakedPills): cap concurrent view-shot captures.
  const active = specs.filter((s) => !done[s.key]).slice(0, BAKE_CONCURRENCY);
  const bakery = (
    <View style={styles_bakeryHost} pointerEvents="none">
      {active.map((spec) => <ClusterShot key={spec.key} spec={spec} onShot={onShot} onFail={onFail} />)}
    </View>
  );
  return { uriFor: (key) => uris[key], bakery };
}

export function MapClusterMarker({ coordinate, pillUri, fallback, hidden = false, zIndex = 1, refreshKey, onPress }: {
  coordinate: { latitude: number; longitude: number };
  pillUri?: string;
  /** See MapPillMarker.hidden — visibility as a property, never a mount change. */
  hidden?: boolean;
  /** Shown until the bake lands (e.g. the chain badge on a single-chain map). Without
   *  it the marker renders nothing while un-baked — and the resulting null→Marker
   *  flips insert children mid-array, which is the iOS AIRMap interop crash surface
   *  (NSRangeException in insertReactSubview; see StoreResolutionOverlay). Passing a
   *  fallback mounts the marker ONCE and only swaps its image in place. */
  fallback?: number | ImageURISource;
  zIndex?: number;
  /** See MapPillMarker.refreshKey — repaint after camera settles on iOS. */
  refreshKey?: string | number;
  onPress?: () => void;
}) {
  const source: number | ImageURISource | null = pillUri ? { uri: pillUri } : fallback ?? null;
  const fade = useSteppedFade(hidden);
  // See MapPillMarker: fully-hidden Android markers unmount so they can't
  // swallow taps; iOS keeps them mounted (annotation-drop surface).
  const androidUnmounted = Platform.OS === 'android' && hidden && fade === 0;
  // Re-track briefly on image change so the async-decoded count bubble actually
  // paints (same tracksViewChanges gotcha as MapPillMarker).
  const [tracks, setTracks] = useState(true);
  useEffect(() => {
    setTracks(true);
    const t = setTimeout(() => setTracks(false), 600);
    return () => clearTimeout(t);
  }, [pillUri, refreshKey]);
  if (source == null || androidUnmounted) return null;
  return (
    <Marker
      coordinate={coordinate}
      anchor={{ x: 0.5, y: 0.5 }}
      image={source}
      opacity={fade}
      tracksViewChanges={tracks}
      zIndex={zIndex}
      onPress={hidden ? undefined : onPress}
    />
  );
}

const makeStyles = (c: AppTheme) =>
  StyleSheet.create({
    // FAKE BORDER via NESTING — the pill is an OUTER ring view (bg = border colour) wrapping an
    // INNER fill view, each with ONLY backgroundColor + borderRadius and NO borderWidth. We do NOT
    // use `borderWidth` because `backgroundColor + borderWidth + borderRadius` makes RN 0.81's
    // new-arch background a LayerDrawable whose BackgroundDrawable.draw crashes ("Required value was
    // null", BackgroundDrawable.kt:121) mid-draw on this map. The borderless confirm button (bg +
    // radius, no border) never crashed → mirroring that here removes the crash. No elevation/shadow:
    // it never rasterised into the baked PNG and its outline rebuild segfaulted view-shot.
    pillBorder: { padding: 2 },                                   // the 2px ring = the old borderWidth
    pillInner: { flexDirection: 'row', alignItems: 'center' },
    pillInnerOneRow: { gap: 5, paddingLeft: 4, paddingRight: 11, paddingVertical: 4 },
    pillInnerTwoRow: { gap: 8, paddingLeft: 6, paddingRight: 14, paddingVertical: 5 },
    // Radius styles are SPLIT OUT + applied only once the view has real bounds (see PillShot´s
    // `ready` gate) — a borderRadius drawn at a transient 0×0/NaN size crashes RN 0.81 new-arch
    // BackgroundDrawable. Inner radius = outer − 2 (concentric with the 2px ring); RN clamps to
    // min(w,h)/2 → stadium.
    pillRadiusOneRow: { borderRadius: 22 },
    pillRadiusTwoRow: { borderRadius: 24 },
    pillInnerRadiusOneRow: { borderRadius: 20 },
    pillInnerRadiusTwoRow: { borderRadius: 22 },

    // Ring (outer) colours + fill (inner) colours per variant.
    ringNeutral: { backgroundColor: c.pillOutline },            // warm edge (light) / white halo (dark)
    ringAccent: { backgroundColor: c.primary },                  // cheapest + selected
    fillCard: { backgroundColor: c.cardBackground },             // neutral + cheapest
    fillPrimary: { backgroundColor: c.primary },                 // selected → solid primary

    badgeOneRow: { width: 28, height: 28, borderRadius: 14 },
    badgeTwoRow: { width: 30, height: 30, borderRadius: 15 },
    // Combo stack: own badge at left ON TOP of the partners', each peeking a
    // further 14px right (half a badge — enough to recognise the chain).
    // Width is set inline (28 + 14 × partner count).
    badgeStackOneRow: { height: 28 },
    badgePrimary: { position: 'absolute', left: 0, top: 0 },

    textColTwoRow: { justifyContent: 'center' },
    valueText: { fontSize: 13, fontWeight: '800' },
    streetText: { fontSize: 12, fontWeight: '700', lineHeight: 16 },
    numberText: { fontSize: 11, fontWeight: '600', lineHeight: 14 },

    // Cluster count bubble — same nested fake-border (no borderWidth) + no shadow + bounds-gated radius.
    clusterBorder: {
      padding: 2, backgroundColor: c.primary,
      alignItems: 'center', justifyContent: 'center',
    },
    clusterInner: {
      minWidth: 32, height: 32, paddingHorizontal: 6,
      backgroundColor: c.cardBackground, alignItems: 'center', justifyContent: 'center',
    },
    clusterInnerBig: { minWidth: 42, height: 42 },
    // Radius split out + applied only once sized (see ClusterShot´s `ready` gate).
    clusterRadius: { borderRadius: 18 },
    clusterRadiusBig: { borderRadius: 23 },
    clusterInnerRadius: { borderRadius: 16 },
    clusterInnerRadiusBig: { borderRadius: 21 },
    clusterText: { fontSize: 13, fontWeight: '800', color: c.primary },
  });
