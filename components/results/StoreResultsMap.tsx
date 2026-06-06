import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, useColorScheme, TouchableOpacity } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
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
 * The logo pin (native image — the only thing that rasterises reliably on
 * Android, see chainLogoAssets). The selected store swaps to the bigger
 * pink-ringed asset; pins fade when another store is selected.
 */
function LogoPin({ pin, styles, selected, dimmed, onPress }: {
    pin: MapPin; styles: Styles; selected: boolean; dimmed: boolean; onPress: (id: number) => void;
}) {
    const img = chainPinImage(pin.chainId, selected);
    return (
        <Marker
            coordinate={{ latitude: pin.latitude, longitude: pin.longitude }}
            anchor={{ x: 0.5, y: 0.5 }}
            image={img ?? undefined}
            opacity={dimmed ? 0.4 : 1}
            zIndex={selected ? 30 : pin.recommended ? 18 : pin.euro != null ? 10 : 2}
            tracksViewChanges={false}
            onPress={() => onPress(pin.storeId)}
        >
            {!img ? (
                <View style={[styles.fallbackTile, { backgroundColor: chainBrandColorById(pin.chainId) }, dimmed && styles.dim]}>
                    <Text style={styles.fallbackText}>{pin.chainName[0]}</Text>
                </View>
            ) : undefined}
        </Marker>
    );
}

/**
 * Price tag — a text-only marker (rasterises fine) anchored just BELOW the logo
 * so the two read as one pin. Colour encodes value: cheapest = green (+ ribbon),
 * others = neutral surface. Selected gets a pink ring; dimmed when another store
 * is selected. Shown for every PRICED pin (un-priced pins show logo only).
 */
function PriceTag({ pin, styles, colors, selected, dimmed, onPress }: {
    pin: MapPin; styles: Styles; colors: AppTheme; selected: boolean; dimmed: boolean; onPress: (id: number) => void;
}) {
    // Re-rasterise briefly whenever the visual state changes, then freeze.
    const [tracks, setTracks] = useState(true);
    useEffect(() => {
        setTracks(true);
        const t = setTimeout(() => setTracks(false), 500);
        return () => clearTimeout(t);
    }, [pin.euro, pin.recommended, selected, dimmed]);

    const cheapest = pin.recommended;
    return (
        <Marker
            coordinate={{ latitude: pin.latitude, longitude: pin.longitude }}
            anchor={{ x: 0.5, y: 0 }}
            tracksViewChanges={tracks}
            zIndex={selected ? 31 : cheapest ? 20 : 11}
            onPress={() => onPress(pin.storeId)}
        >
            <View style={styles.tagColumn}>
                <View style={styles.tagSpacer} />
                <View style={[
                    styles.tag,
                    cheapest ? styles.tagCheapest : styles.tagNeutral,
                    selected && styles.tagSelected,
                    dimmed && styles.dim,
                ]}>
                    <Text style={[styles.tagText, cheapest ? styles.tagTextCheapest : { color: colors.textPrimary }]} numberOfLines={1}>
                        {pin.euro != null ? formatEuro(pin.euro) : ''}
                    </Text>
                </View>
            </View>
        </Marker>
    );
}

export default function StoreResultsMap({ pins, userCoords, focusCoords, onSelectStore, colors }: Props) {
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const mapRef = useRef<MapView>(null);
    const isDark = useColorScheme() === 'dark';

    const anySelected = useMemo(() => pins.some(p => p.active), [pins]);

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
                    <LogoPin
                        key={`${pin.storeId}-${pin.active ? 'a' : 'i'}`}
                        pin={pin} styles={styles}
                        selected={pin.active}
                        dimmed={anySelected && !pin.active}
                        onPress={onSelectStore}
                    />
                ))}
                {pins.filter(p => p.euro != null).map(pin => (
                    <PriceTag
                        key={`price-${pin.storeId}-${pin.active ? 'a' : 'i'}`}
                        pin={pin} styles={styles} colors={colors}
                        selected={pin.active}
                        dimmed={anySelected && !pin.active}
                        onPress={onSelectStore}
                    />
                ))}
            </MapView>

            {/* Floating controls — top-right, below the header toggle. */}
            <View style={styles.controls} pointerEvents="box-none">
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
    fallbackTile: {
        width: 32, height: 32, borderRadius: 16,
        alignItems: 'center', justifyContent: 'center',
        borderWidth: 2, borderColor: '#FFFFFF',
    },
    fallbackText: { fontSize: 13, fontWeight: '800', color: '#FFFFFF' },
    dim: { opacity: 0.4 },

    // Price tag sits a touch below the centred logo so the two read as one pin.
    tagColumn: { alignItems: 'center' },
    tagSpacer: { height: 24 },
    tag: {
        alignItems: 'center', justifyContent: 'center',
        borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3,
        borderWidth: 2, borderColor: '#FFFFFF',
        elevation: 6, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.28, shadowRadius: 3,
    },
    tagNeutral: { backgroundColor: c.cardBackground },
    // Cheapest = the app's pink (primary); others = neutral surface.
    tagCheapest: { backgroundColor: c.primary },
    tagSelected: { borderColor: c.primary, transform: [{ scale: 1.08 }] },
    tagText: { fontSize: 13, fontWeight: '800' },
    tagTextCheapest: { color: '#FFFFFF' },

    userDotRing: {
        width: 22, height: 22, borderRadius: 11,
        backgroundColor: 'rgba(26,115,232,0.25)',
        alignItems: 'center', justifyContent: 'center',
    },
    userDot: {
        width: 12, height: 12, borderRadius: 6,
        backgroundColor: '#1A73E8', borderWidth: 2, borderColor: '#FFFFFF',
    },

    controls: { position: 'absolute', top: 12, right: 12, gap: 10 },
    ctrlBtn: {
        width: 42, height: 42, borderRadius: 21,
        backgroundColor: c.cardBackground,
        alignItems: 'center', justifyContent: 'center',
        elevation: 5, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4,
        borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    },
});
