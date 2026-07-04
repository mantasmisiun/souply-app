import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, StyleSheet, Text, View, type ImageSourcePropType, type ImageURISource, type LayoutChangeEvent } from 'react-native';
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

export type MapPillVariant = 'neutral' | 'cheapest' | 'selected';

export interface MapPillSpec {
  /** Identity for caching the baked image — re-bakes only when this changes
   *  (include everything that affects the pixels: id + content + variant). */
  key: string;
  chainId: number;
  /** 1 entry → price pill; 2 entries → address pill (street, number/flat). */
  lines: string[];
  variant: MapPillVariant;
}

// ── Off-screen renderer: lays a pill out at natural size + snapshots it ──────
function PillShot({ spec, onShot, onFail }: { spec: MapPillSpec; onShot: (key: string, uri: string) => void; onFail: (key: string) => void }) {
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const ref = useRef<View>(null);
  const badge = chainBadgeImage(spec.chainId);
  const twoRow = spec.lines.length >= 2;
  const ringStyle = spec.variant === 'selected' || spec.variant === 'cheapest' ? styles.ringAccent : styles.ringNeutral;
  const fillStyle = spec.variant === 'selected' ? styles.fillPrimary : styles.fillCard;
  const primaryColor = spec.variant === 'selected' ? '#FFFFFF' : colors.textPrimary;
  const secondaryColor = spec.variant === 'selected' ? 'rgba(255,255,255,0.85)' : colors.textSecondary;

  // GATE the rounded background on a real layout. RN 0.81's new-arch BackgroundDrawable
  // crashes the whole app ("Required value was null", BackgroundDrawable.kt:121) if a
  // borderRadius view is drawn at a transient 0×0/NaN size — which these continuously-remounted
  // bake views hit during the map's relayout. So borderRadius is applied ONLY once onLayout
  // reports real bounds; until then the view is a plain (un-rounded) bg fill, which is safe.
  const [ready, setReady] = useState(false);
  const [badgeLoaded, setBadgeLoaded] = useState(badge == null);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 1 && height > 1) setReady(true);
  }, []);

  // Snapshot once the pill is rounded at a real size AND its logo has loaded. onFail (on error
  // or if it never sizes) advances the throttle window so a stuck pill can't block the rest.
  useEffect(() => {
    if (!ready || !badgeLoaded) return;
    const node = ref.current;
    if (!node) return;
    // `ready` gates the borderRadius application; capturing while ready=true means the round
    // corners ARE applied. If a baked pill still shows as a sharp rectangle, this log tells us
    // whether ready/badgeLoaded were both true at capture (→ a native-timing issue) or not.
    console.log(`[PILLBAKE] capture key=${spec.key} ready=${ready} badgeLoaded=${badgeLoaded} twoRow=${twoRow}`);
    captureRef(node, { format: 'png', result: 'tmpfile', quality: 1 })
      .then((uri) => { console.log(`[PILLBAKE] OK key=${spec.key}`); onShot(spec.key, uri); })
      .catch((e) => { console.log(`[PILLBAKE] FAIL key=${spec.key}`, e?.message ?? e); onFail(spec.key); });
  }, [ready, badgeLoaded, spec.key, onShot, onFail, twoRow]);

  useEffect(() => {
    if (ready) return;
    const t = setTimeout(() => onFail(spec.key), 1500);
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
        {badge != null && (
          <Image source={badge} style={twoRow ? styles.badgeTwoRow : styles.badgeOneRow} onLoad={() => setBadgeLoaded(true)} onError={() => setBadgeLoaded(true)} />
        )}
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
  bakery: React.ReactNode;
} {
  const [uris, setUris] = useState<Record<string, string>>({});
  // `done` (captured OR failed) drives the throttle window so it advances even on a failed capture.
  const [done, setDone] = useState<Record<string, true>>({});
  const onShot = useCallback((key: string, uri: string) => {
    setUris((prev) => (prev[key] === uri ? prev : { ...prev, [key]: uri }));
    setDone((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  }, []);
  const onFail = useCallback((key: string) => {
    setDone((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  }, []);
  // THROTTLE: bake at most BAKE_CONCURRENCY pills at once. Capturing many rounded views via
  // react-native-view-shot simultaneously floods native/Skia memory and segfaults
  // (SkPath::rewind in View.rebuildOutline) — and froze the UI mid-render. The window advances
  // as each capture finishes or fails, so all pills still bake, just a few at a time.
  const active = specs.filter((s) => !done[s.key]).slice(0, BAKE_CONCURRENCY);
  const bakery = (
    <View style={styles_bakeryHost} pointerEvents="none">
      {active.map((spec) => <PillShot key={spec.key} spec={spec} onShot={onShot} onFail={onFail} />)}
    </View>
  );
  return { uriFor: (key) => uris[key], bakery };
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
export function MapPillMarker({
  coordinate,
  chainId,
  pillUri,
  dimmed = false,
  zIndex = 1,
  anchorBaked = { x: 0.18, y: 0.5 },
  onPress,
}: {
  coordinate: { latitude: number; longitude: number };
  chainId: number;
  pillUri?: string;
  dimmed?: boolean;
  zIndex?: number;
  /** Where the geographic point sits on the baked pill — defaults near the logo
   *  on the left (the badge-only fallback always centres). */
  anchorBaked?: { x: number; y: number };
  onPress?: () => void;
}) {
  const baked: ImageSourcePropType | null = pillUri ? { uri: pillUri } : null;
  const badge = chainBadgeImage(chainId);
  const source: ImageSourcePropType | null = baked ?? (badge != null ? badge : null);
  if (source == null) return null;
  return (
    <Marker
      coordinate={coordinate}
      anchor={baked ? anchorBaked : { x: 0.5, y: 0.5 }}
      image={source}
      opacity={dimmed ? 0.4 : 1}
      tracksViewChanges={false}
      zIndex={zIndex}
      onPress={onPress}
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
    const node = ref.current;
    if (!node) return;
    captureRef(node, { format: 'png', result: 'tmpfile', quality: 1 })
      .then((uri) => onShot(spec.key, uri))
      .catch(() => onFail(spec.key));
  }, [ready, spec.key, onShot, onFail]);
  useEffect(() => {
    if (ready) return;
    const t = setTimeout(() => onFail(spec.key), 1500);
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

export function MapClusterMarker({ coordinate, pillUri, fallback, zIndex = 1, onPress }: {
  coordinate: { latitude: number; longitude: number };
  pillUri?: string;
  /** Shown until the bake lands (e.g. the chain badge on a single-chain map). Without
   *  it the marker renders nothing while un-baked — and the resulting null→Marker
   *  flips insert children mid-array, which is the iOS AIRMap interop crash surface
   *  (NSRangeException in insertReactSubview; see StoreResolutionOverlay). Passing a
   *  fallback mounts the marker ONCE and only swaps its image in place. */
  fallback?: number | ImageURISource;
  zIndex?: number;
  onPress?: () => void;
}) {
  const source: number | ImageURISource | null = pillUri ? { uri: pillUri } : fallback ?? null;
  if (source == null) return null;
  return (
    <Marker
      coordinate={coordinate}
      anchor={{ x: 0.5, y: 0.5 }}
      image={source}
      tracksViewChanges={false}
      zIndex={zIndex}
      onPress={onPress}
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
    ringNeutral: { backgroundColor: '#FFFFFF' },
    ringAccent: { backgroundColor: c.primary },                  // cheapest + selected
    fillCard: { backgroundColor: c.cardBackground },             // neutral + cheapest
    fillPrimary: { backgroundColor: c.primary },                 // selected → solid primary

    badgeOneRow: { width: 28, height: 28, borderRadius: 14 },
    badgeTwoRow: { width: 30, height: 30, borderRadius: 15 },

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
