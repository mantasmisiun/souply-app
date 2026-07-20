import { ReactNode, RefObject } from 'react';
import { Platform, Keyboard } from 'react-native';
import MapView, { type Region } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MapCanvas } from './MapCanvas';
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
    /** Keep the confirm pill mounted while disabled (default true — point picks
     *  always show it). Store picks pass false → it appears only once a store is
     *  tapped (confirmEnabled). */
    confirmAlwaysVisible?: boolean;
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
    const { top: topInset } = useSafeAreaInsets();
    const pick = props.pick ?? null;

    return (
        <MapCanvas
            mapRef={props.mapRef}
            initialRegion={props.initialRegion}
            onMapReady={props.onMapReady}
            onRegionChangeComplete={props.onRegionChangeComplete}
            onRegionChange={props.onRegionChange}
            onPress={props.onMapPress}
            showsUserLocation={props.showsUserLocation ?? true}
            // Any touch on the map (tap OR drag start) closes the keyboard — a
            // native MapView never dismisses it on its own.
            onTouchStart={Keyboard.dismiss}
            // Android: Google's My Location button anchors to the map's top edge
            // (full-bleed, under the status bar + floating chrome) — pad below.
            mapPadding={Platform.OS === 'android'
                ? { top: topInset + (props.androidTopPad ?? 110), right: 0, bottom: 0, left: 0 }
                : undefined}
            mountMap={props.mountMap}
            mapReady={props.mapReady}
            overlay={
                <>
                    {/* Base-mode companions — hidden during a pick session so the
                        pick chrome has the stage (the sheet rides persistentOverlay). */}
                    {pick == null ? props.baseOverlay : null}
                    {props.persistentOverlay}

                    {/* Pick session: Cancel + title + optional search on top; the
                        session's own overlay (centre pin etc.) under them. */}
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
                                confirmAlwaysVisible={pick.confirmAlwaysVisible ?? true}
                            />
                        </>
                    )}
                </>
            }
        >
            {props.children}
        </MapCanvas>
    );
}

function CancelButton({ onPress }: { onPress: () => void }) {
    return <GlassIconButton icon="close" glass solid onPress={onPress} size={22} />;
}
