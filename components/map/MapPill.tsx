import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Image, StyleSheet, Text, View, type ImageSourcePropType } from 'react-native';
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
function PillShot({ spec, onShot }: { spec: MapPillSpec; onShot: (key: string, uri: string) => void }) {
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const ref = useRef<View>(null);
  const badge = chainBadgeImage(spec.chainId);
  const twoRow = spec.lines.length >= 2;
  const variantStyle =
    spec.variant === 'selected' ? styles.selected : spec.variant === 'cheapest' ? styles.cheapest : styles.neutral;
  const primaryColor = spec.variant === 'selected' ? '#FFFFFF' : colors.textPrimary;
  const secondaryColor = spec.variant === 'selected' ? 'rgba(255,255,255,0.85)' : colors.textSecondary;

  // Snapshot once the row (and its logo) have laid out. Both onLayout and the
  // logo's onLoad call it — whichever is last wins, so the capture always
  // includes the loaded logo.
  const grab = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    captureRef(node, { format: 'png', result: 'tmpfile', quality: 1 })
      .then((uri) => onShot(spec.key, uri))
      .catch(() => {});
  }, [spec.key, onShot]);

  return (
    <View
      ref={ref}
      collapsable={false}
      style={[styles.pill, twoRow ? styles.pillTwoRow : styles.pillOneRow, variantStyle]}
      onLayout={grab}
    >
      {badge != null && (
        <Image source={badge} style={twoRow ? styles.badgeTwoRow : styles.badgeOneRow} onLoad={grab} />
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
  const onShot = useCallback((key: string, uri: string) => {
    setUris((prev) => (prev[key] === uri ? prev : { ...prev, [key]: uri }));
  }, []);
  const bakery = (
    <View style={styles_bakeryHost} pointerEvents="none">
      {specs.map((spec) => (uris[spec.key] ? null : <PillShot key={spec.key} spec={spec} onShot={onShot} />))}
    </View>
  );
  return { uriFor: (key) => uris[key], bakery };
}

const styles_bakeryHost = { position: 'absolute' as const, top: -10000, left: 0 };

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

function ClusterShot({ spec, onShot }: { spec: MapClusterSpec; onShot: (key: string, uri: string) => void }) {
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const ref = useRef<View>(null);
  const grab = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    captureRef(node, { format: 'png', result: 'tmpfile', quality: 1 })
      .then((uri) => onShot(spec.key, uri))
      .catch(() => {});
  }, [spec.key, onShot]);
  return (
    <View ref={ref} collapsable={false} style={[styles.cluster, spec.big && styles.clusterBig]} onLayout={grab}>
      <Text style={styles.clusterText} allowFontScaling={false}>{spec.count}</Text>
    </View>
  );
}

export function useBakedClusters(specs: MapClusterSpec[]): {
  uriFor: (key: string) => string | undefined;
  bakery: React.ReactNode;
} {
  const [uris, setUris] = useState<Record<string, string>>({});
  const onShot = useCallback((key: string, uri: string) => {
    setUris((prev) => (prev[key] === uri ? prev : { ...prev, [key]: uri }));
  }, []);
  const bakery = (
    <View style={styles_bakeryHost} pointerEvents="none">
      {specs.map((spec) => (uris[spec.key] ? null : <ClusterShot key={spec.key} spec={spec} onShot={onShot} />))}
    </View>
  );
  return { uriFor: (key) => uris[key], bakery };
}

export function MapClusterMarker({ coordinate, pillUri, zIndex = 1, onPress }: {
  coordinate: { latitude: number; longitude: number };
  pillUri?: string;
  zIndex?: number;
  onPress?: () => void;
}) {
  // Until the bake lands (a frame or two) there's no native cluster asset to fall
  // back to, so render nothing rather than a clipped child view.
  if (!pillUri) return null;
  return (
    <Marker
      coordinate={coordinate}
      anchor={{ x: 0.5, y: 0.5 }}
      image={{ uri: pillUri }}
      tracksViewChanges={false}
      zIndex={zIndex}
      onPress={onPress}
    />
  );
}

const makeStyles = (c: AppTheme) =>
  StyleSheet.create({
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      borderWidth: 2,
      elevation: 6,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.3,
      shadowRadius: 3,
    },
    // Price pill. FINITE radius (== half its ~40px height) for a stadium shape — a
    // huge raw borderRadius + borderWidth crashes Android's new-arch BorderDrawable
    // ("Required value was null"), same as the 2-row pill did at 999. RN clamps to
    // min(w,h)/2 so 22 still renders fully-rounded ends.
    pillOneRow: { gap: 5, borderRadius: 22, paddingLeft: 4, paddingRight: 11, paddingVertical: 4 },
    // Address pill — taller but still a true stadium pill (fully-rounded ends). Uses a
    // FINITE radius == half the pill height (content 30 + 2×5 pad + 2×2 border ≈ 44 → 22+),
    // NOT 999: a huge raw borderRadius + borderWidth crashes Android's new-arch BorderDrawable
    // (drawRoundedBorders "Required value was null") on this taller view. RN clamps to
    // min(w,h)/2 anyway, so 24 still renders fully-rounded ends.
    // Equal 6px-ish inset for the logo on left/top/bottom (badge height == the two text rows = 30).
    pillTwoRow: { gap: 8, borderRadius: 24, paddingLeft: 6, paddingRight: 14, paddingVertical: 5 },

    neutral: { backgroundColor: c.cardBackground, borderColor: '#FFFFFF' },
    cheapest: { backgroundColor: c.cardBackground, borderColor: c.primary },
    selected: { backgroundColor: c.primary, borderColor: c.primary },

    badgeOneRow: { width: 28, height: 28, borderRadius: 14 },
    badgeTwoRow: { width: 30, height: 30, borderRadius: 15 },

    textColTwoRow: { justifyContent: 'center' },
    valueText: { fontSize: 13, fontWeight: '800' },
    streetText: { fontSize: 12, fontWeight: '700', lineHeight: 16 },
    numberText: { fontSize: 11, fontWeight: '600', lineHeight: 14 },

    // Cluster count bubble (baked off-screen → no shadow, which doesn't rasterise anyway).
    cluster: {
      minWidth: 36, height: 36, paddingHorizontal: 8, borderRadius: 18,
      backgroundColor: c.cardBackground, borderWidth: 2, borderColor: c.primary,
      alignItems: 'center', justifyContent: 'center',
    },
    clusterBig: { minWidth: 46, height: 46, borderRadius: 23 },
    clusterText: { fontSize: 13, fontWeight: '800', color: c.primary },
  });
