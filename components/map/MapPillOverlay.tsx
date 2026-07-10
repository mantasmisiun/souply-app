import React from 'react';
import { Image, Pressable, StyleSheet, View, type ImageSourcePropType } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
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
 * Pills are ordinary RN views: image updates, taps, opacity and zIndex all
 * behave deterministically. The native map keeps only tiles, the route
 * polyline and the user dot — a near-static children set, which also removes
 * the marker-churn crash surface (AIRMap nil-insert) from this screen.
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

function OverlayPill({
    pill,
    region,
    mapW,
    mapH,
}: {
    pill: OverlayPillSpec;
    region: SharedValue<Region>;
    mapW: SharedValue<number>;
    mapH: SharedValue<number>;
}) {
    const { latitude, longitude, w, h, isPill, dimmed } = pill;
    const style = useAnimatedStyle(() => {
        const r = region.value;
        const W = mapW.value;
        const H = mapH.value;
        if (W <= 0 || H <= 0 || r.longitudeDelta <= 0) {
            return { opacity: 0, transform: [{ translateX: -1e4 }, { translateY: 0 }] };
        }
        // Web-Mercator projection of lat/lng into the current viewport.
        // The scale comes ONLY from longitudeDelta: Mercator is ISOTROPIC
        // (mercator-units per px identical in x and y on an unrotated map), and
        // the longitude span is unambiguous — unlike latitudeDelta, whose exact
        // semantics vs the visible rect vary (deriving the y-scale from it made
        // pills drift vertically during vertical pans while x stayed glued).
        const mercPerPx = (r.longitudeDelta * Math.PI / 180) / W;
        const x = W / 2 + ((longitude - r.longitude) * Math.PI / 180) / mercPerPx;
        const y = H / 2 + (mercY(r.latitude) - mercY(latitude)) / mercPerPx;
        // The geographic point sits at the pill's anchor: near the logo for a
        // baked pill (matches the old marker's anchorBaked), centre for a badge.
        const left = x - w * (isPill ? 0.16 : 0.5);
        const top = y - h * 0.5;
        const off = x < -W * 0.5 || x > W * 1.5 || y < -H * 0.5 || y > H * 1.5;
        return {
            opacity: off ? 0 : dimmed ? 0.4 : 1,
            transform: [{ translateX: left }, { translateY: top }],
        };
    });
    // NO zIndex on the pill: on Fabric a positioned view with zIndex stacks
    // against ANCESTOR siblings too — pills escaped this overlay and painted
    // over the results sheet. Stacking among pills comes purely from sibling
    // order (MapPillOverlay renders them sorted by z, selected last = on top),
    // and the zIndex-free tree keeps the sheet (a later sibling) above the map.
    return (
        <Animated.View style={[styles.pill, { width: w, height: h }, style]}>
            <Pressable
                onPress={__DEV__ && pill.debugId
                    ? () => { console.log(`[PILL ${pill.debugId}] TAP (overlay)`); pill.onPress(); }
                    : pill.onPress}
                hitSlop={6}
            >
                <Image source={pill.source} style={{ width: w, height: h }} resizeMode="contain" />
            </Pressable>
        </Animated.View>
    );
}

export function MapPillOverlay({
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
    // stacking — the selected pin's pill is ALWAYS on top).
    const sorted = [...pills].sort((a, b) => a.z - b.z);
    return (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
            {sorted.map((p) => (
                <OverlayPill key={p.id} pill={p} region={region} mapW={mapW} mapH={mapH} />
            ))}
        </View>
    );
}

const styles = StyleSheet.create({
    // Positioned purely by the animated transform; must start at the origin.
    pill: { position: 'absolute', left: 0, top: 0 },
});
