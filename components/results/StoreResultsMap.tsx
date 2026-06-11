import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Image, Platform, StyleSheet, useColorScheme, TouchableOpacity, Dimensions } from 'react-native';
import MapView, { Marker, Polyline, type Region } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Asset } from 'expo-asset';
import { Ionicons } from '@expo/vector-icons';
import { spacing, radius, elevation, iconSize, type AppTheme } from '../../constants/theme';
import { chainBrandColorById } from '../../utils/chainBrandName';
import { chainPinImage, chainBadgeImage } from '../../utils/chainLogoAssets';
import { DARK_MAP_STYLE } from '../../constants/darkMapStyle';
import { formatEuro } from '../../utils/formatCurrency';
import { type StoreLite } from '../../utils/candidatePool';
import { clusterByGrid, type Cluster, type GridRegion } from '../../utils/mapClustering';

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

const SCREEN_H = Dimensions.get('window').height;

type Props = {
    pins: MapPin[];
    userCoords: { lat: number; lng: number } | null;
    focusCoords: LatLng[] | null;
    /** The recommended (cheapest, pink) store — the map centers here on load and
     *  when nothing is selected, instead of fitting every pin. */
    recommendedCoords?: LatLng | null;
    /** Route mode: the two trip endpoints (start/end) — drawn as markers and
     *  used as the route line's ends instead of the user dot. */
    routeEndpoints?: { from: LatLng; to: LatLng } | null;
    onSelectStore: (storeId: number) => void;
    colors: AppTheme;
    /** Every store in Lithuania (un-priced) — the background directory layer.
     *  Clustered when zoomed out, individual muted logos when zoomed in. */
    directory?: StoreLite[];
    /** Store ids that already carry a price pill → excluded from the directory
     *  layer so we never double-render the same store. */
    pricedStoreIds?: Set<number>;
    /** Store currently being lazily priced (tap → fetch) — shown dimmed. */
    pricingStoreId?: number | null;
    /** Tap an un-priced directory store → lazily price it. */
    onLazyPrice?: (storeId: number) => void;
    /** Ordered route (user → stops) drawn for a selected split combo. */
    routeCoords?: LatLng[] | null;
    /** Tap empty map (not a marker) → dismiss the options sheet. */
    onMapPress?: () => void;
    /** Height (px) the bottom sheet currently occludes, so centering/fitting
     *  keeps content in the visible area above it. 0 = nothing covering. */
    bottomOverlay?: number;
    /** Reports the nearest un-priced stores currently in view (capped at the
     *  batch limit) so the parent can offer an "price this area" button. */
    onVisibleUnpricedChange?: (storeIds: number[]) => void;
};

type Styles = ReturnType<typeof makeStyles>;

/**
 * One store pin = a baked circular chain BADGE + an attached PRICE pill. They're
 * TWO markers on purpose: Android won't rasterise a child <Image> inside a custom
 * marker view, so the logo has to ride the marker's native `image` prop (a
 * pre-composed logo-on-brand PNG — chainBadgeImage). The price is dynamic text,
 * so it's a separate View marker seated to the badge's right; it re-snapshots
 * briefly on any visual change then freezes. The badge is a native image, so it
 * always renders and never needs tracking.
 *
 * Colour encodes value: cheapest = pink ring, others = white ring; selected =
 * solid pink pill. The badge marker sits one z above its pill so it stays on top.
 */
function StorePin({ pin, styles, colors, selected, dimmed, zRank, onPress }: {
    pin: MapPin; styles: Styles; colors: AppTheme; selected: boolean; dimmed: boolean; zRank: number; onPress: (id: number) => void;
}) {
    const badge = chainBadgeImage(pin.chainId);
    const cheapest = pin.recommended;
    const priced = pin.euro != null;
    const tap = () => onPress(pin.storeId);

    const variant = selected ? styles.pillSelected : cheapest ? styles.pillCheapest : styles.pillNeutral;
    const priceColor = selected ? '#FFFFFF' : colors.textPrimary;

    // Price pill is text-only → re-snapshot briefly on visual change, then freeze.
    const [tracks, setTracks] = useState(true);
    useEffect(() => {
        setTracks(true);
        const t = setTimeout(() => setTracks(false), 450);
        return () => clearTimeout(t);
    }, [pin.euro, pin.recommended, selected, dimmed]);

    const coordinate = { latitude: pin.latitude, longitude: pin.longitude };

    return (
        <>
            {priced && (
                <Marker
                    coordinate={coordinate}
                    anchor={{ x: 0, y: 0.5 }}
                    tracksViewChanges={tracks}
                    opacity={dimmed ? 0.4 : 1}
                    zIndex={zRank * 2}
                    onPress={tap}
                >
                    <View style={[styles.pill, variant]}>
                        <Text style={[styles.pillPrice, { color: priceColor }]} numberOfLines={1} allowFontScaling={false}>
                            {formatEuro(pin.euro as number)}
                        </Text>
                    </View>
                </Marker>
            )}
            {badge != null && (
                <Marker
                    coordinate={coordinate}
                    // Negative x → the badge's left edge sits ~5.5dp RIGHT of the
                    // coord (= the pill's left edge), so the logo has the same
                    // gap on the left as it does top/bottom. Google Maps honours
                    // out-of-range anchor fractions; this is Android's seat.
                    anchor={{ x: -0.18, y: 0.5 }}
                    image={badge}
                    opacity={dimmed ? 0.4 : 1}
                    tracksViewChanges={false}
                    zIndex={zRank * 2 + 1}
                    onPress={tap}
                />
            )}
        </>
    );
}

/**
 * A clustered group of un-priced directory stores. The count is a text View
 * marker → it needs a brief tracksViewChanges window to snapshot (same Fabric
 * caveat as the price pill); it remounts whenever the grid re-buckets, so each
 * fresh bubble paints once then freezes. Tap → zoom into the cluster.
 */
function ClusterBubble({ cluster, styles, onPress }: {
    cluster: Cluster; styles: Styles; onPress: (c: Cluster) => void;
}) {
    const [tracks, setTracks] = useState(true);
    useEffect(() => {
        setTracks(true);
        const t = setTimeout(() => setTracks(false), 350);
        return () => clearTimeout(t);
    }, [cluster.count]);
    const big = cluster.count >= 25;
    return (
        <Marker
            coordinate={{ latitude: cluster.latitude, longitude: cluster.longitude }}
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={tracks}
            zIndex={1}
            onPress={() => onPress(cluster)}
        >
            <View style={[styles.cluster, big && styles.clusterBig]}>
                <Text style={styles.clusterText}>{cluster.count}</Text>
            </View>
        </Marker>
    );
}

/**
 * A single un-priced directory store — just the logo (no pill). Reads as "store
 * here, tap to see its basket price". Dimmed while its price is being fetched.
 *
 * Platform split: Android uses the native `image` prop (child images don't
 * rasterise there). iOS renders a slightly LARGER child image inside a padded
 * tap area — the native-asset size is too small to spot/tap comfortably, and
 * iOS renders child images fine. The brief tracksViewChanges window lets the
 * (preloaded) image snapshot once, then freezes for performance.
 */
function DirectoryPin({ store, styles, pricing, onPress }: {
    store: StoreLite; styles: Styles; pricing: boolean; onPress: (id: number) => void;
}) {
    const logo = chainPinImage(store.chainId, false);
    const tap = () => onPress(store.id);

    const [tracks, setTracks] = useState(Platform.OS === 'ios');
    useEffect(() => {
        if (Platform.OS !== 'ios') return;
        const t = setTimeout(() => setTracks(false), 400);
        return () => clearTimeout(t);
    }, []);

    if (Platform.OS === 'ios') {
        return (
            <Marker
                coordinate={{ latitude: store.latitude, longitude: store.longitude }}
                anchor={{ x: 0.5, y: 0.5 }}
                tracksViewChanges={tracks}
                opacity={pricing ? 0.45 : 1}
                zIndex={1}
                onPress={tap}
            >
                <View style={styles.dirHit}>
                    {logo != null
                        ? <Image source={logo} style={styles.dirLogo} resizeMode="contain" />
                        : (
                            <View style={[styles.fallbackChip, { backgroundColor: chainBrandColorById(store.chainId) }]}>
                                <Text style={styles.fallbackText}>{(store.chainName[0] ?? '?').toUpperCase()}</Text>
                            </View>
                        )}
                </View>
            </Marker>
        );
    }

    return (
        <Marker
            coordinate={{ latitude: store.latitude, longitude: store.longitude }}
            anchor={{ x: 0.5, y: 0.5 }}
            image={logo ?? undefined}
            opacity={pricing ? 0.45 : 0.92}
            tracksViewChanges={false}
            zIndex={1}
            onPress={tap}
        >
            {logo == null ? (
                <View style={[styles.fallbackChip, { backgroundColor: chainBrandColorById(store.chainId) }]}>
                    <Text style={styles.fallbackText}>{(store.chainName[0] ?? '?').toUpperCase()}</Text>
                </View>
            ) : undefined}
        </Marker>
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

export default function StoreResultsMap({
    pins, userCoords, focusCoords, recommendedCoords, routeEndpoints, onSelectStore, colors,
    directory, pricedStoreIds, pricingStoreId, onLazyPrice, routeCoords, onMapPress,
    onVisibleUnpricedChange, bottomOverlay = 0,
}: Props) {
    // How much of the bottom is covered by the sheet (capped so a fully-extended
    // sheet doesn't try to cram everything into a sliver — at that point the map
    // isn't visible anyway). Read via a ref in the stable callbacks.
    const occlusion = Math.min(Math.max(bottomOverlay, 0), SCREEN_H * 0.55);
    const occlusionRef = useRef(occlusion);
    occlusionRef.current = occlusion;
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const mapRef = useRef<MapView>(null);
    const isDark = useColorScheme() === 'dark';
    const insets = useSafeAreaInsets();

    // react-native-maps fires the map's onPress right after a marker's onPress
    // (and even on marker taps on some platforms). Without this guard, tapping a
    // pin would open the sheet and then the map-press would instantly close it —
    // which read as "tapping a pin does nothing". Record the last marker tap and
    // swallow any map-press within a short window of it.
    const markerPressRef = useRef(0);
    const markMarkerPress = useCallback(() => { markerPressRef.current = Date.now(); }, []);
    const handleStoreTap = useCallback((id: number) => { markMarkerPress(); onSelectStore(id); }, [markMarkerPress, onSelectStore]);
    const handleDirTap = useCallback((id: number) => { markMarkerPress(); onLazyPrice?.(id); }, [markMarkerPress, onLazyPrice]);
    const handleMapPress = useCallback(() => {
        if (Date.now() - markerPressRef.current < 350) return;
        onMapPress?.();
    }, [onMapPress]);

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

    // Render order = z order. react-native-maps ignores `zIndex` re-ordering on
    // Android (marker insertion order wins), so we render pins from lowest to
    // highest zRank → active/selected pins render LAST and always sit on top
    // (fixes a 2nd selected store hiding behind a neutral pin, and a re-selected
    // store rendering below its former combo partner).
    const pinsByZ = useMemo(
        () => [...pins].sort((a, b) => (zRankMap.get(a.storeId) ?? 0) - (zRankMap.get(b.storeId) ?? 0)),
        [pins, zRankMap],
    );

    const allCoords = useMemo(() => {
        const c: LatLng[] = pins.map(p => ({ latitude: p.latitude, longitude: p.longitude }));
        if (routeEndpoints) { c.push(routeEndpoints.from, routeEndpoints.to); }
        else if (userCoords) c.push({ latitude: userCoords.lat, longitude: userCoords.lng });
        return c;
    }, [pins, userCoords, routeEndpoints]);
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

    // Current map region drives the directory grid clustering. Seeded from the
    // initial fit; updated when the user pans/zooms (after the gesture settles).
    const [region, setRegion] = useState<GridRegion>(initialRegion);

    // Directory layer: every un-priced store, bucketed into clusters/singles for
    // the current zoom. Priced stores are excluded (they render as pills).
    const directoryPts = useMemo(() => {
        if (!directory || directory.length === 0) return [];
        return directory
            .filter(s =>
                Number.isFinite(s.latitude) && Number.isFinite(s.longitude) &&
                !(pricedStoreIds?.has(s.id)))
            .map(s => ({ ...s, id: s.id, latitude: s.latitude, longitude: s.longitude }));
    }, [directory, pricedStoreIds]);

    const { clusters, singles } = useMemo(
        () => clusterByGrid(directoryPts, region),
        [directoryPts, region],
    );

    // Report the nearest un-priced stores in view (capped at the batch limit) so
    // the parent can offer a "price this area" button. Keyed so we only emit on
    // an actual change of the set.
    const lastUnpricedRef = useRef('');
    useEffect(() => {
        if (!onVisibleUnpricedChange) return;
        const cx = region.latitude, cy = region.longitude;
        const nearest = [...singles]
            .sort((a, b) =>
                ((a.latitude - cx) ** 2 + (a.longitude - cy) ** 2) -
                ((b.latitude - cx) ** 2 + (b.longitude - cy) ** 2))
            .slice(0, 10)
            .map(s => s.id);
        const key = nearest.join(',');
        if (key !== lastUnpricedRef.current) {
            lastUnpricedRef.current = key;
            onVisibleUnpricedChange(nearest);
        }
    }, [singles, region, onVisibleUnpricedChange]);

    // Tap a cluster → zoom one step into it (thirds the visible span, recentred).
    const onClusterPress = useCallback((c: Cluster) => {
        markMarkerPress();
        mapRef.current?.animateToRegion({
            latitude: c.latitude,
            longitude: c.longitude,
            latitudeDelta: Math.max(region.latitudeDelta / 3, 0.01),
            longitudeDelta: Math.max(region.longitudeDelta / 3, 0.01),
        }, 350);
    }, [region.latitudeDelta, region.longitudeDelta, markMarkerPress]);

    // Bottom edge-padding for fits = the sheet occlusion (plus a base margin so
    // content clears the very bottom when nothing's covering).
    const fitBottomPad = () => Math.max(occlusionRef.current + 24, 90);
    // Centering a single point: shift the camera south by half the occlusion so
    // the point lands in the centre of the VISIBLE area above the sheet.
    const centerOn = useCallback((lat: number, lng: number, delta: number) => {
        const off = (occlusionRef.current / 2) * (delta / SCREEN_H);
        mapRef.current?.animateToRegion(
            { latitude: lat - off, longitude: lng, latitudeDelta: delta, longitudeDelta: delta },
            350,
        );
    }, []);

    const fitAll = useCallback(() => {
        if (allCoordsRef.current.length === 0) return;
        mapRef.current?.fitToCoordinates(allCoordsRef.current, {
            edgePadding: { top: 100, right: 80, bottom: fitBottomPad(), left: 80 },
            animated: true,
        });
    }, []);

    // Default view when nothing is selected: center on the recommended (pink)
    // store rather than fitting every pin — so load lands on the best option.
    const recRef = useRef(recommendedCoords);
    recRef.current = recommendedCoords;
    const centerDefault = useCallback(() => {
        const r = recRef.current;
        if (r) centerOn(r.latitude, r.longitude, 0.06);
        else fitAll();
    }, [fitAll, centerOn]);

    const goToUser = useCallback(() => {
        if (!userCoords) return;
        centerOn(userCoords.lat, userCoords.lng, 0.02);
    }, [userCoords, centerOn]);

    const allKey = useMemo(() => allCoords.map(c => `${c.latitude},${c.longitude}`).join('|'), [allCoords]);
    const focusKey = useMemo(
        () => (focusCoords && focusCoords.length ? focusCoords.map(c => `${c.latitude},${c.longitude}`).join('|') : 'all'),
        [focusCoords],
    );
    useEffect(() => {
        const t = setTimeout(() => {
            if (focusCoords && focusCoords.length === 1) {
                centerOn(focusCoords[0].latitude, focusCoords[0].longitude, 0.0075);
            } else if (focusCoords && focusCoords.length > 1) {
                mapRef.current?.fitToCoordinates(focusCoords, {
                    edgePadding: { top: 110, right: 90, bottom: Math.max(occlusion + 24, 90), left: 90 },
                    animated: true,
                });
            } else {
                centerDefault();
            }
        }, 60);
        return () => clearTimeout(t);
        // `occlusion` in deps → re-frame when the sheet moves to a new stage.
    }, [focusKey, allKey, focusCoords, centerDefault, centerOn, occlusion]);

    return (
        <View style={StyleSheet.absoluteFill}>
            <MapView
                ref={mapRef}
                style={StyleSheet.absoluteFill}
                initialRegion={initialRegion}
                onMapReady={centerDefault}
                onPress={handleMapPress}
                onRegionChangeComplete={setRegion}
                customMapStyle={isDark ? DARK_MAP_STYLE : undefined}
                rotateEnabled={false}
                pitchEnabled={false}
                toolbarEnabled={false}
                moveOnMarkerPress={false}
                showsCompass={false}
                showsMyLocationButton={false}
            >
                {/* Split-combo route line (user → stops), under the markers. */}
                {routeCoords && routeCoords.length >= 2 && (
                    <Polyline
                        coordinates={routeCoords}
                        strokeColor={colors.primary}
                        strokeWidth={4}
                        lineDashPattern={[2, 8]}
                        lineCap="round"
                    />
                )}
                {/* Directory layer (un-priced, below the priced pills + user dot). */}
                {clusters.map(c => (
                    <ClusterBubble key={`c-${c.id}`} cluster={c} styles={styles} onPress={onClusterPress} />
                ))}
                {singles.map(s => (
                    <DirectoryPin
                        key={`d-${s.id}`}
                        store={s}
                        styles={styles}
                        pricing={pricingStoreId === s.id}
                        onPress={handleDirTap}
                    />
                ))}
                {/* Route mode → start/end endpoint markers (the trip's two
                    locations). Otherwise the user's current-location dot. */}
                {routeEndpoints ? (
                    <>
                        <Marker coordinate={routeEndpoints.from} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false} zIndex={5}>
                            <View style={[styles.endpointDot, { backgroundColor: colors.success }]} />
                        </Marker>
                        <Marker coordinate={routeEndpoints.to} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false} zIndex={5}>
                            <View style={[styles.endpointDot, { backgroundColor: colors.primary }]} />
                        </Marker>
                    </>
                ) : userCoords && (
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
                {pinsByZ.map(pin => (
                    <StorePin
                        // Key encodes z-rank AND the visual variant. z-rank: on a
                        // selection change ranks reshuffle → pins remount and
                        // re-insert in sorted (pinsByZ) order (react-native-maps
                        // adds remounted markers on top, so highlighted pins render
                        // LAST = on top). Variant (s/r/n + dim): forces a remount —
                        // and thus a re-rasterise of the frozen marker — whenever a
                        // pin's pill colour changes, even if its rank didn't (e.g.
                        // tapping the already-recommended store: cheapest → selected).
                        key={`${pin.storeId}-${zRankMap.get(pin.storeId) ?? 0}-${pin.active ? 's' : pin.recommended ? 'r' : 'n'}${anySelected && !pin.active ? 'd' : ''}`}
                        pin={pin} styles={styles} colors={colors}
                        selected={pin.active}
                        dimmed={anySelected && !pin.active}
                        zRank={zRankMap.get(pin.storeId) ?? 0}
                        onPress={handleStoreTap}
                    />
                ))}
            </MapView>

            {/* Floating controls — top-right, clear of the status bar. */}
            <View style={[styles.controls, { top: insets.top + spacing.md }]} pointerEvents="box-none">
                <TouchableOpacity style={styles.ctrlBtn} onPress={fitAll} activeOpacity={0.8}>
                    <Ionicons name="scan-outline" size={iconSize.md} color={colors.textPrimary} />
                </TouchableOpacity>
                {userCoords && (
                    <TouchableOpacity style={styles.ctrlBtn} onPress={goToUser} activeOpacity={0.8}>
                        <Ionicons name="locate" size={iconSize.md} color={colors.primary} />
                    </TouchableOpacity>
                )}
            </View>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    dim: { opacity: 0.4 },

    // Price pill. The 30dp chain badge is a separate native-image marker
    // left-anchored at the same coordinate, so it sits over the pill's left;
    // paddingLeft clears it and leaves a gap before the price.
    pill: {
        alignItems: 'center', justifyContent: 'center',
        borderRadius: 999, paddingLeft: 38, paddingRight: 12, paddingVertical: 8,
        borderWidth: 2,
        elevation: 6, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 3,
    },
    // Not selected: neutral surface bg; cheapest gets a PINK ring, rest WHITE.
    pillNeutral: { backgroundColor: c.cardBackground, borderColor: '#FFFFFF' },
    pillCheapest: { backgroundColor: c.cardBackground, borderColor: c.primary },
    // Selected: solid pink bg + pink border (no scale — that caused white corners).
    pillSelected: { backgroundColor: c.primary, borderColor: c.primary },
    pillPrice: { fontSize: 13, fontWeight: '800' },

    // Single-marker pill: badge + price in one row, badge left-aligned by flex
    // (variants pillNeutral/pillCheapest/pillSelected supply bg + border).
    pillRow: {
        flexDirection: 'row', alignItems: 'center', gap: 5,
        borderRadius: 999, paddingLeft: 4, paddingRight: 11, paddingVertical: 4,
        borderWidth: 2,
        elevation: 6, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 3,
    },
    // iOS un-priced directory pin: bigger logo + transparent padding so it's
    // easy to see and gives a comfortable tap target.
    dirHit: { padding: 6, alignItems: 'center', justifyContent: 'center' },
    dirLogo: { width: 36, height: 36 },

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
    // Route-mode trip endpoints (start = success/green, end = primary/pink).
    endpointDot: {
        width: 18, height: 18, borderRadius: 9, borderWidth: 3, borderColor: '#FFFFFF',
        elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.3, shadowRadius: 2,
    },

    // Directory cluster bubble — neutral surface, pink ring + count.
    cluster: {
        minWidth: 36, height: 36, paddingHorizontal: 8, borderRadius: 18,
        backgroundColor: c.cardBackground, borderWidth: 2, borderColor: c.primary,
        alignItems: 'center', justifyContent: 'center',
        elevation: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.25, shadowRadius: 2,
    },
    clusterBig: { minWidth: 46, height: 46, borderRadius: 23 },
    clusterText: { fontSize: 13, fontWeight: '800', color: c.primary },

    controls: { position: 'absolute', right: spacing.md, gap: spacing.sm },
    ctrlBtn: {
        width: 42, height: 42, borderRadius: radius.pill,
        backgroundColor: c.cardBackground,
        alignItems: 'center', justifyContent: 'center',
        ...elevation.level2,
        borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    },
});
