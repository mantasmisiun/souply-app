import { ReactNode, RefObject, useMemo } from 'react';
import { View, StyleSheet, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import MapView, { type Region, type EdgePadding } from 'react-native-maps';
import { MaterialProgress } from '@/components/MaterialProgress';
import { DARK_MAP_STYLE } from '../../constants/darkMapStyle';
import { useTheme, useResolvedScheme, type AppTheme } from '../../constants/theme';

/**
 * The ONE MapView primitive every map surface shares (extracted from MapHost;
 * StoreResultsMap and MapHost both render through it). It owns only the parts
 * that are genuinely common — the native MapView with the shared defaults
 * (dark style, no toolbar, no marker-press recenter), the mount gate (defer GL
 * init) and the themed cover-until-ready — plus two slots:
 *   · children → markers/polylines INSIDE the map
 *   · overlay  → chrome/controls/pills OVER the map (outside the MapView)
 *
 * Everything else is a pass-through prop: unset props fall back to MapView's own
 * defaults, so each caller declares only what it overrides (the picker sets
 * `onTouchStart`/top `mapPadding`; the stores map sets `scrollEnabled`/bottom
 * `mapPadding`/`rotate|pitch|compass=false`). A fix to the shared MapView setup
 * now lands in one place for both.
 */
export interface MapCanvasProps {
    mapRef: RefObject<MapView | null>;
    initialRegion: Region;
    /** Root container style (default flex:1). */
    style?: StyleProp<ViewStyle>;
    /** Markers/polylines rendered INSIDE the MapView. */
    children?: ReactNode;
    /** Chrome/controls rendered OVER the map (outside the MapView). */
    overlay?: ReactNode;

    onMapReady?: () => void;
    onRegionChange?: (r: Region) => void;
    /** `details.isGesture` (Google/Android only) = the move came from the user,
     *  not a programmatic animation. */
    onRegionChangeComplete?: (r: Region, details?: { isGesture?: boolean }) => void;
    /** Fires continuously while the user drags the map (both platforms) — use it
     *  to tell a real drag from a programmatic camera move. */
    onPanDrag?: () => void;
    onPress?: (e: { nativeEvent?: { action?: string; position?: { x: number; y: number }; coordinate?: { latitude: number; longitude: number } } }) => void;
    /** Native map POI tap (Google provider only — Android; iOS uses Apple maps). */
    onPoiClick?: (e: { nativeEvent?: { name?: string; placeId?: string; coordinate?: { latitude: number; longitude: number } } }) => void;
    onLayout?: (e: LayoutChangeEvent) => void;
    onTouchStart?: () => void;

    scrollEnabled?: boolean;
    zoomEnabled?: boolean;
    rotateEnabled?: boolean;
    pitchEnabled?: boolean;
    showsCompass?: boolean;
    showsUserLocation?: boolean;
    showsMyLocationButton?: boolean;
    mapPadding?: EdgePadding;

    /** False = don't mount the native MapView yet (defer GL init past a
     *  modal/nav animation); the cover shows meanwhile. */
    mountMap?: boolean;
    /** False = overlay an opaque themed cover + spinner (hides the raw white
     *  GL surface + marker pop-in during native init). */
    mapReady?: boolean;
}

export function MapCanvas(props: MapCanvasProps) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const isDark = useResolvedScheme() === 'dark';

    return (
        <View style={[styles.root, props.style]}>
            {props.mountMap !== false && (
                <MapView
                    ref={props.mapRef}
                    style={StyleSheet.absoluteFillObject}
                    initialRegion={props.initialRegion}
                    onMapReady={props.onMapReady}
                    onRegionChange={props.onRegionChange}
                    onRegionChangeComplete={props.onRegionChangeComplete}
                    onPress={props.onPress}
                    onPoiClick={props.onPoiClick}
                    onPanDrag={props.onPanDrag}
                    onLayout={props.onLayout}
                    onTouchStart={props.onTouchStart}
                    mapPadding={props.mapPadding}
                    scrollEnabled={props.scrollEnabled}
                    zoomEnabled={props.zoomEnabled}
                    rotateEnabled={props.rotateEnabled}
                    pitchEnabled={props.pitchEnabled}
                    showsCompass={props.showsCompass}
                    showsUserLocation={props.showsUserLocation ?? true}
                    showsMyLocationButton={props.showsMyLocationButton}
                    // Shared defaults for every map surface:
                    //  · Android's default `moveOnMarkerPress` recenters on ANY tapped
                    //    marker (incl. invisible ones) — every camera move here is an
                    //    explicit animateToRegion instead.
                    moveOnMarkerPress={false}
                    toolbarEnabled={false}
                    customMapStyle={isDark ? DARK_MAP_STYLE : undefined}
                >
                    {props.children}
                </MapView>
            )}

            {props.overlay}

            {props.mapReady === false && (
                <View style={[StyleSheet.absoluteFillObject, styles.mapCover]}>
                    <MaterialProgress size="large" color={colors.primary} />
                </View>
            )}
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    root: { flex: 1 },
    mapCover: { backgroundColor: c.pageBackground, alignItems: 'center', justifyContent: 'center' },
});
