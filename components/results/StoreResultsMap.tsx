import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, useColorScheme, TouchableOpacity } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Asset } from 'expo-asset';
import { Ionicons } from '@expo/vector-icons';
import { type AppTheme } from '../../constants/theme';
import { chainBrandColorById } from '../../utils/chainBrandName';
import { chainPinImage } from '../../utils/chainLogoAssets';
import { DARK_MAP_STYLE } from '../../constants/darkMapStyle';
import { formatEuro } from '../../utils/formatCurrency';

export type MapPin = {
    storeId: number;
    chainId: number;
    chainName: string;
    miniLogoUrl: string | null;
    latitude: number;
    longitude: number;
    euro: number | null;
    active: boolean;
    recommended: boolean;
};

type LatLng = { latitude: number; longitude: number };

type Props = {
    pins: MapPin[];
    userCoords: { lat: number; lng: number } | null;
    focusCoords: LatLng[] | null;
    onSelectStore: (storeId: number) => void;
    colors: AppTheme;
};

type Styles = ReturnType<typeof makeStyles>;

/**
 * One store pin = a circular LOGO badge + an attached PRICE pill that read as a
 * single unit. The logo is the marker's NATIVE `image` (the only thing that
 * paints reliably on Android / the new architecture — a child `<Image>` stays
 * blank, which is the bug we kept hitting). The price is a separate text-only
 * View marker at the same coordinate, anchored to the left so it emerges from
 * behind the logo's right side.
 *
 * Colour encodes value: cheapest = the app pink, others = neutral surface.
 * Selected swaps to the bigger pink-ringed logo + scales the pill; rest dim.
 */
function StorePin({ pin, styles, colors, selected, dimmed, zRank, onPress }: {
    pin: MapPin; styles: Styles; colors: AppTheme; selected: boolean; dimmed: boolean; zRank: number; onPress: (id: number) => void;
}) {
    const logo = chainPinImage(pin.chainId, false); // constant size — no swap on select
    const cheapest = pin.recommended;
    const priced = pin.euro != null;
    const tap = () => onPress(pin.storeId);

    // The price pill is text-only → re-snapshot briefly on visual change, then freeze.
    const [tracks, setTracks] = useState(true);
    useEffect(() => {
        setTracks(true);
        const t = setTimeout(() => setTracks(false), 450);
        return () => clearTimeout(t);
    }, [pin.euro, pin.recommended, selected, dimmed]);

    return (
        <>
            {priced && (
                <Marker
                    coordinate={{ latitude: pin.latitude, longitude: pin.longitude }}
                    anchor={{ x: 0, y: 0.5 }}
                    tracksViewChanges={tracks}
                    opacity={dimmed ? 0.4 : 1}
                    zIndex={zRank * 2}
                    onPress={tap}
                >
                    <View style={[
                        styles.pill,
                        selected ? styles.pillSelected : cheapest ? styles.pillCheapest : styles.pillNeutral,
                    ]}>
                        <Text style={[styles.pillPrice, { color: selected ? '#FFFFFF' : colors.textPrimary }]} numberOfLines={1}>
                            {formatEuro(pin.euro as number)}
                        </Text>
                    </View>
                </Marker>
            )}
            <Marker
                coordinate={{ latitude: pin.latitude, longitude: pin.longitude }}
                anchor={{ x: -0.17, y: 0.5 }}
                image={logo ?? undefined}
                opacity={dimmed ? 0.4 : 1}
                tracksViewChanges={false}
                zIndex={zRank * 2 + 1}
                onPress={tap}
            >
                {logo == null ? (
                    <View style={[styles.fallbackChip, { backgroundColor: chainBrandColorById(pin.chainId) }, dimmed && styles.dim]}>
                        <Text style={styles.fallbackText}>{(pin.chainName[0] ?? '?').toUpperCase()}</Text>
                    </View>
                ) : undefined}
            </Marker>
        </>
    );
}

/** Preload the chain logo assets once so the native marker images paint instantly. */
let _logosPreloaded = false;
function preloadLogos() {
    if (_logosPreloaded) return;
    _logosPreloaded = true;
    const mods = [1, 2, 3, 4, 5]
        .flatMap(id => [chainPinImage(id, false), chainPinImage(id, true)])
        .filter((m): m is number => m != null);
    Asset.loadAsync(mods).catch(() => { _logosPreloaded = false; });
}

export default function StoreResultsMap({ pins, userCoords, focusCoords, onSelectStore, colors }: Props) {
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const mapRef = useRef<MapView>(null);
    const isDark = useColorScheme() === 'dark';
    const insets = useSafeAreaInsets();

    useEffect(() => { preloadLogos(); }, []);

    const anySelected = useMemo(() => pins.some(p => p.active), [pins]);

    // A contiguous zIndex rank per pin so each pin's logo + pill stack as ONE
    // unit (no logo leaking over a neighbouring pin's pill). Higher rank = on
    // top: selected first, then cheapest, then southern pins (lower latitude).
    const zRankMap = useMemo(() => {
        const order = [...pins].sort((a, b) => {
            if (a.active !== b.active) return a.active ? 1 : -1;
            if (a.recommended !== b.recommended) return a.recommended ? 1 : -1;
            return b.latitude - a.latitude;
        });
        const m = new Map<number, number>();
        order.forEach((p, i) => m.set(p.storeId, i + 1));
        return m;
    }, [pins]);

    const allCoords = useMemo(() => {
        const c: LatLng[] = pins.map(p => ({ latitude: p.latitude, longitude: p.longitude }));
        if (userCoords) c.push({ latitude: userCoords.lat, longitude: userCoords.lng });
        return c;
    }, [pins, userCoords]);
    const allCoordsRef = useRef(allCoords);
    allCoordsRef.current = allCoords;

    const initialRegion = useMemo(() => {
        const c = allCoords;
        if (c.length === 0) return { latitude: 54.6872, longitude: 25.2797, latitudeDelta: 0.1, longitudeDelta: 0.1 };
        const lats = c.map(p => p.latitude), lngs = c.map(p => p.longitude);
        const minLat = Math.min(...lats), maxLat = Math.max(...lats);
        const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
        return {
            latitude: (minLat + maxLat) / 2,
            longitude: (minLng + maxLng) / 2,
            latitudeDelta: Math.max((maxLat - minLat) * 1.6, 0.02),
            longitudeDelta: Math.max((maxLng - minLng) * 1.6, 0.02),
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const fitAll = useCallback(() => {
        if (allCoordsRef.current.length === 0) return;
        mapRef.current?.fitToCoordinates(allCoordsRef.current, {
            edgePadding: { top: 100, right: 80, bottom: 220, left: 80 },
            animated: true,
        });
    }, []);

    const goToUser = useCallback(() => {
        if (!userCoords) return;
        mapRef.current?.animateToRegion(
            { latitude: userCoords.lat, longitude: userCoords.lng, latitudeDelta: 0.02, longitudeDelta: 0.02 },
            350,
        );
    }, [userCoords]);

    const allKey = useMemo(() => allCoords.map(c => `${c.latitude},${c.longitude}`).join('|'), [allCoords]);
    const focusKey = useMemo(
        () => (focusCoords && focusCoords.length ? focusCoords.map(c => `${c.latitude},${c.longitude}`).join('|') : 'all'),
        [focusCoords],
    );
    useEffect(() => {
        const t = setTimeout(() => {
            if (focusCoords && focusCoords.length === 1) {
                mapRef.current?.animateToRegion(
                    { latitude: focusCoords[0].latitude, longitude: focusCoords[0].longitude, latitudeDelta: 0.0075, longitudeDelta: 0.0075 },
                    350,
                );
            } else if (focusCoords && focusCoords.length > 1) {
                mapRef.current?.fitToCoordinates(focusCoords, {
                    edgePadding: { top: 130, right: 100, bottom: 280, left: 100 },
                    animated: true,
                });
            } else {
                fitAll();
            }
        }, 60);
        return () => clearTimeout(t);
    }, [focusKey, allKey, focusCoords, fitAll]);

    return (
        <View style={StyleSheet.absoluteFill}>
            <MapView
                ref={mapRef}
                style={StyleSheet.absoluteFill}
                initialRegion={initialRegion}
                onMapReady={fitAll}
                customMapStyle={isDark ? DARK_MAP_STYLE : undefined}
                rotateEnabled={false}
                pitchEnabled={false}
                toolbarEnabled={false}
                moveOnMarkerPress={false}
                showsCompass={false}
                showsMyLocationButton={false}
            >
                {userCoords && (
                    <Marker
                        coordinate={{ latitude: userCoords.lat, longitude: userCoords.lng }}
                        anchor={{ x: 0.5, y: 0.5 }}
                        tracksViewChanges={false}
                        zIndex={5}
                    >
                        <View style={styles.userDotRing}>
                            <View style={styles.userDot} />
                        </View>
                    </Marker>
                )}
                {pins.map(pin => (
                    <StorePin
                        key={`${pin.storeId}-${pin.active ? 'a' : 'i'}`}
                        pin={pin} styles={styles} colors={colors}
                        selected={pin.active}
                        dimmed={anySelected && !pin.active}
                        zRank={zRankMap.get(pin.storeId) ?? 0}
                        onPress={onSelectStore}
                    />
                ))}
            </MapView>

            {/* Floating controls — top-right, clear of the status bar. */}
            <View style={[styles.controls, { top: insets.top + 12 }]} pointerEvents="box-none">
                <TouchableOpacity style={styles.ctrlBtn} onPress={fitAll} activeOpacity={0.8}>
                    <Ionicons name="scan-outline" size={20} color={colors.textPrimary} />
                </TouchableOpacity>
                {userCoords && (
                    <TouchableOpacity style={styles.ctrlBtn} onPress={goToUser} activeOpacity={0.8}>
                        <Ionicons name="locate" size={20} color={colors.primary} />
                    </TouchableOpacity>
                )}
            </View>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    dim: { opacity: 0.4 },

    // Price pill. Tall enough that the 24dp logo (a separate native-image
    // marker, inset via anchor) clears the top/bottom with an even gap; extra
    // left padding seats the logo + leaves a gap before the price.
    pill: {
        alignItems: 'center', justifyContent: 'center',
        borderRadius: 999, paddingLeft: 34, paddingRight: 12, paddingVertical: 8,
        borderWidth: 2,
        elevation: 6, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 3,
    },
    // Not selected: neutral surface bg; cheapest gets a PINK ring, rest WHITE.
    pillNeutral: { backgroundColor: c.cardBackground, borderColor: '#FFFFFF' },
    pillCheapest: { backgroundColor: c.cardBackground, borderColor: c.primary },
    // Selected: solid pink bg + pink border (no scale — that caused white corners).
    pillSelected: { backgroundColor: c.primary, borderColor: c.primary },
    pillPrice: { fontSize: 13, fontWeight: '800' },

    // Fallback badge for a chain with no bundled logo asset.
    fallbackChip: {
        width: 30, height: 30, borderRadius: 15,
        alignItems: 'center', justifyContent: 'center',
        borderWidth: 2, borderColor: '#FFFFFF',
    },
    fallbackText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },

    // User location — solid, white-ringed, with a visible accuracy halo
    // (Google-style) so it reads clearly on the dark map too.
    userDotRing: {
        width: 28, height: 28, borderRadius: 14,
        backgroundColor: 'rgba(26,115,232,0.30)',
        alignItems: 'center', justifyContent: 'center',
    },
    userDot: {
        width: 16, height: 16, borderRadius: 8,
        backgroundColor: '#1A73E8', borderWidth: 3, borderColor: '#FFFFFF',
        elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.3, shadowRadius: 2,
    },

    controls: { position: 'absolute', right: 12, gap: 10 },
    ctrlBtn: {
        width: 42, height: 42, borderRadius: 21,
        backgroundColor: c.cardBackground,
        alignItems: 'center', justifyContent: 'center',
        elevation: 5, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4,
        borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    },
});
