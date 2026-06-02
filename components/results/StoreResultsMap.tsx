import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
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

/** Floating price pill above the selected pin. Text-only view → rasterises
 *  reliably on Android (unlike images in markers). */
function PricePin({ pin, styles, onPress }: { pin: MapPin; styles: Styles; onPress: (id: number) => void }) {
    const [tracks, setTracks] = useState(true);
    useEffect(() => {
        setTracks(true);
        const t = setTimeout(() => setTracks(false), 800);
        return () => clearTimeout(t);
    }, [pin.euro]);
    return (
        <Marker
            coordinate={{ latitude: pin.latitude, longitude: pin.longitude }}
            anchor={{ x: 0, y: 0.5 }}
            tracksViewChanges={tracks}
            zIndex={12}
            onPress={() => onPress(pin.storeId)}
        >
            <View style={styles.priceRow}>
                <View style={styles.priceSpacer} />
                <View style={styles.pricePill}>
                    <Text style={styles.pricePillText}>{pin.euro != null ? formatEuro(pin.euro) : ''}</Text>
                </View>
            </View>
        </Marker>
    );
}

function PinMarker({ pin, styles, onPress }: { pin: MapPin; styles: Styles; onPress: (id: number) => void }) {
    const img = chainPinImage(pin.chainId, pin.active);
    return (
        <Marker
            coordinate={{ latitude: pin.latitude, longitude: pin.longitude }}
            anchor={{ x: 0.5, y: 0.5 }}
            image={img ?? undefined}
            zIndex={pin.active ? 10 : 1}
            tracksViewChanges={false}
            onPress={() => onPress(pin.storeId)}
        >
            {!img ? (
                <View style={[styles.fallbackTile, { backgroundColor: chainBrandColorById(pin.chainId) }]}>
                    <Text style={styles.fallbackText}>{pin.chainName[0]}</Text>
                </View>
            ) : undefined}
        </Marker>
    );
}

export default function StoreResultsMap({ pins, userCoords, focusCoords, onSelectStore, colors }: Props) {
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const mapRef = useRef<MapView>(null);
    const isDark = useColorScheme() === 'dark';

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
            edgePadding: { top: 100, right: 80, bottom: 200, left: 80 },
            animated: true,
        });
    }, []);

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
                    edgePadding: { top: 130, right: 100, bottom: 260, left: 100 },
                    animated: true,
                });
            } else {
                fitAll();
            }
        }, 60);
        return () => clearTimeout(t);
    }, [focusKey, allKey, focusCoords, fitAll]);

    return (
        <MapView
            ref={mapRef}
            style={StyleSheet.absoluteFill}
            initialRegion={initialRegion}
            onMapReady={fitAll}
            customMapStyle={isDark ? DARK_MAP_STYLE : undefined}
            scrollEnabled={false}
            zoomEnabled={false}
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
                >
                    <View style={styles.userDotRing}>
                        <View style={styles.userDot} />
                    </View>
                </Marker>
            )}
            {pins.map(pin => (
                <PinMarker key={`${pin.storeId}-${pin.active ? 'a' : 'i'}`} pin={pin} styles={styles} onPress={onSelectStore} />
            ))}
            {pins.filter(p => p.active && p.euro != null).map(pin => (
                <PricePin key={`price-${pin.storeId}`} pin={pin} styles={styles} onPress={onSelectStore} />
            ))}
        </MapView>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    fallbackTile: {
        width: 30, height: 30, borderRadius: 15,
        alignItems: 'center', justifyContent: 'center',
        borderWidth: 2, borderColor: '#FFFFFF',
    },
    fallbackText: { fontSize: 12, fontWeight: '800', color: '#FFFFFF' },
    // Price pill sits to the RIGHT of the (centred) logo pin.
    priceRow: { flexDirection: 'row', alignItems: 'center' },
    priceSpacer: { width: 30 },
    pricePill: {
        backgroundColor: c.primary, borderRadius: 999,
        paddingHorizontal: 11, paddingVertical: 4,
        borderWidth: 2, borderColor: '#FFFFFF',
        elevation: 7, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4,
    },
    pricePillText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
    userDotRing: {
        width: 22, height: 22, borderRadius: 11,
        backgroundColor: 'rgba(26,115,232,0.25)',
        alignItems: 'center', justifyContent: 'center',
    },
    userDot: {
        width: 12, height: 12, borderRadius: 6,
        backgroundColor: '#1A73E8', borderWidth: 2, borderColor: '#FFFFFF',
    },
});
