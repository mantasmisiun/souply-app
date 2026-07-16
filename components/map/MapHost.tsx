import { ReactNode, RefObject, useMemo } from 'react';
import { View, StyleSheet, Platform, Keyboard } from 'react-native';
import MapView, { type Region } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialProgress } from '@/components/MaterialProgress';
import { DARK_MAP_STYLE } from '../../constants/darkMapStyle';
import { useTheme, useResolvedScheme, type AppTheme } from '../../constants/theme';
import { MapPickChrome } from './MapPickChrome';
import { GlassIconButton } from '../GlassIconButton';

/**
 * THE one-map host (Souply 2.0): a single full-bleed MapView that every map
 * surface shares, switched between modes instead of navigating between maps.
 *
 *   · base mode — the caller renders its own companions over the map (the
 *     GlassStageSheet stack, StoreCountToggle, glass back button) via the
 *     overlay slots; the host stays out of the way.
 *   · pick session (`pick` prop non-null) — the Find-My choreography: the
 *     caller collapses/freezes its sheet (single-entry snaps) and the host
 *     overlays MapPickChrome (Cancel top-left, title chip, optional address
 *     search) with the confirm action. Confirm/cancel return to base mode.
 *
 * The host deliberately does NOT own markers: marker sets are caller state
 * (append-only discipline per the SRO contract — pills/badges swap images in
 * place, never remount mid-array).
 */

export interface MapPickSession {
    /** 'point' = drag-the-map centre pin; 'store' = tap a store marker. */
    kind: 'point' | 'store';
    /** Title chip text (e.g. "Namai", "Priskirti parduotuvę"). */
    title?: string;
    /** Custom title-chip content (e.g. tap-to-rename input). Wins over title. */
    titleNode?: ReactNode;
    /** Custom top-left control — defaults to a glass Cancel (X) button wired
     *  to onCancel. Standalone pick screens pass a back chevron instead. */
    headerLeft?: ReactNode;
    confirmLabel: string;
    confirmEnabled: boolean;
    confirmLoading?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    /** Address search in the chrome — omit to hide the field (store picks
     *  usually don't need it; point picks do). */
    search?: {
        text: string;
        onChangeText: (v: string) => void;
        onSubmit: () => void;
        searching?: boolean;
        error?: string | null;
        placeholder: string;
    };
    /** Extra overlay for the session (centre pin, drag hint…). */
    overlay?: ReactNode;
}

export interface MapHostProps {
    mapRef: RefObject<MapView | null>;
    initialRegion: Region;
    onMapReady?: () => void;
    onRegionChangeComplete?: (r: Region) => void;
    /** Continuous (per-frame) camera updates — throttle in the caller. */
    onRegionChange?: (r: Region) => void;
    /** Tap on the map itself (NOT a marker). iOS fires this for MARKER presses
     *  too — callers must guard (event action + marker-press timestamps). */
    onMapPress?: (e: { nativeEvent?: { action?: string } }) => void;
    showsUserLocation?: boolean;
    /** While false, an opaque themed cover + spinner hides the raw white
     *  MapView during native GL init. */
    mapReady?: boolean;
    /** False = defer mounting the native MapView (GL init) — e.g. past a
     *  modal slide animation. The cover shows meanwhile. */
    mountMap?: boolean;
    /** Extra top padding for Android's map UI (below floating chrome). */
    androidTopPad?: number;

    /** Markers/polylines INSIDE the MapView — caller-owned (append-only). */
    children?: ReactNode;

    /** Base-mode companions over the map (sheet, toggles, back button…).
     *  Hidden while a pick session is active — EXCEPT the caller's sheet,
     *  which the caller keeps mounted itself (collapsed + frozen) so the
     *  bar can morph instead of unmounting. */
    baseOverlay?: ReactNode;
    /** Overlay that stays through BOTH modes (e.g. the frozen sheet). */
    persistentOverlay?: ReactNode;

    /** Active pick session — non-null switches the host to pick mode. */
    pick?: MapPickSession | null;
}

export function MapHost(props: MapHostProps) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const isDark = useResolvedScheme() === 'dark';
    const { top: topInset } = useSafeAreaInsets();
    const pick = props.pick ?? null;

    return (
        <View style={styles.root}>
            {props.mountMap !== false && (
                <MapView
                    ref={props.mapRef}
                    style={StyleSheet.absoluteFillObject}
                    initialRegion={props.initialRegion}
                    onMapReady={props.onMapReady}
                    onRegionChangeComplete={props.onRegionChangeComplete}
                    onRegionChange={props.onRegionChange}
                    onPress={props.onMapPress}
                    // Android default (true) pans the camera to ANY tapped marker —
                    // it fights drill-down zooms and makes "empty" taps that hit an
                    // invisible marker recentre the map. All camera moves on the
                    // one-map surface are explicit animateToRegion calls.
                    moveOnMarkerPress={false}
                    showsUserLocation={props.showsUserLocation ?? true}
                    customMapStyle={isDark ? DARK_MAP_STYLE : undefined}
                    toolbarEnabled={false}
                    // Android: Google's My Location button anchors to the map's top
                    // edge — full-bleed that's UNDER the status bar and the floating
                    // chrome. Pad the map's UI area below them.
                    mapPadding={Platform.OS === 'android'
                        ? { top: topInset + (props.androidTopPad ?? 110), right: 0, bottom: 0, left: 0 }
                        : undefined}
                    // Any touch on the map (tap OR drag start) closes the keyboard —
                    // a native MapView never dismisses it on its own.
                    onTouchStart={Keyboard.dismiss}
                >
                    {props.children}
                </MapView>
            )}

            {/* Base-mode companions — hidden during a pick session so the pick
                chrome has the stage (the caller's sheet rides persistentOverlay). */}
            {pick == null ? props.baseOverlay : null}
            {props.persistentOverlay}

            {/* Pick session: Cancel + title + optional search float on top;
                the session's own overlay (centre pin etc.) under them. */}
            {pick != null && (
                <>
                    {pick.overlay}
                    <MapPickChrome
                        searchText={pick.search?.text ?? ''}
                        onSearchTextChange={pick.search?.onChangeText ?? (() => {})}
                        onSearch={pick.search?.onSubmit ?? (() => {})}
                        searching={pick.search?.searching}
                        searchError={pick.search?.error}
                        searchPlaceholder={pick.search?.placeholder ?? ''}
                        hideSearch={pick.search == null}
                        confirmLabel={pick.confirmLabel}
                        confirmEnabled={pick.confirmEnabled}
                        confirmLoading={pick.confirmLoading}
                        onConfirm={pick.onConfirm}
                        title={pick.title}
                        titleNode={pick.titleNode}
                        headerLeft={pick.headerLeft ?? <CancelButton onPress={pick.onCancel} />}
                        confirmAlwaysVisible
                    />
                </>
            )}

            {props.mapReady === false && (
                <View style={[StyleSheet.absoluteFillObject, styles.mapCover]}>
                    <MaterialProgress size="large" color={colors.primary} />
                </View>
            )}
        </View>
    );
}

function CancelButton({ onPress }: { onPress: () => void }) {
    return <GlassIconButton icon="close" glass solid onPress={onPress} size={22} />;
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    root: { flex: 1 },
    // Opaque themed cover over the MapView until onMapReady — hides the raw
    // white GL surface + marker pop-in during native init.
    mapCover: { backgroundColor: c.pageBackground, alignItems: 'center', justifyContent: 'center' },
});
