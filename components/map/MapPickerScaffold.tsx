import {
    ReactNode,
    RefObject,
    useMemo } from 'react';
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    Platform,
    Keyboard,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import MapView, { type Region } from 'react-native-maps';
import { DARK_MAP_STYLE } from '../../constants/darkMapStyle';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LiquidGlass } from '../LiquidGlass';
import { useTheme, useResolvedScheme, spacing, radius, typography, elevation, type AppTheme } from '../../constants/theme';

/**
 * Shared map-picker shell — the map + address search row + bottom confirm
 * panel, with the iOS (floating search over a full-bleed map) vs Android
 * (search strip above the map) layout split.
 *
 * Used by BOTH the home/work location preset picker (fixed centre pin, drag to
 * choose a point) and the receipt store-resolution screen (tap a store marker).
 * The differing bits are passed in:
 *   - `mapChildren`: rendered INSIDE <MapView> (markers, polylines).
 *   - `overlay`: rendered ABSOLUTELY over the map (e.g. a centre pin + hint).
 *   - selection model + confirm enablement are the caller's concern.
 */
export interface MapPickerScaffoldProps {
    mapRef: RefObject<MapView | null>;
    initialRegion: Region;
    onMapReady?: () => void;
    onRegionChangeComplete?: (r: Region) => void;
    /** Continuous (per-frame) camera updates — throttle in the caller. */
    onRegionChange?: (r: Region) => void;
    /** Tap on the map itself (NOT a marker) — e.g. clear the selection.
     *  NOTE: iOS fires this for MARKER presses too — callers must guard
     *  (event action + a timestamp set in their marker onPress handlers). */
    onMapPress?: (e: { nativeEvent?: { action?: string } }) => void;
    showsUserLocation?: boolean;

    /** While false, an opaque themed cover + spinner hides the raw white MapView
     *  during native GL init. Undefined (callers that don't pass it) = no cover. */
    mapReady?: boolean;
    /** False = don't mount the native MapView yet (the themed cover shows via
     *  mapReady=false). Lets hosts defer GL init past a Modal slide animation,
     *  which otherwise stutters on the shared main thread. */
    mountMap?: boolean;

    searchText: string;
    onSearchTextChange: (v: string) => void;
    onSearch: () => void;
    searching?: boolean;
    searchError?: string | null;
    searchPlaceholder: string;

    confirmLabel: string;
    confirmEnabled: boolean;
    confirmLoading?: boolean;
    onConfirm: () => void;

    /** Markers etc. rendered inside the MapView. */
    mapChildren?: ReactNode;
    /** Absolute overlay over the map (centre pin, hint bar, header chip…). */
    overlay?: ReactNode;

    /**
     * Full-bleed map with FLOATING LIQUID-GLASS chrome (store-resolution screen):
     * the map fills the whole surface; a back button + title + search float in a
     * glass cluster at the top, and the confirm button floats at the bottom with
     * NO panel behind it, appearing only once `confirmEnabled`. Off (default) keeps
     * the classic header-strip + solid bottom-panel layout (the location picker).
     */
    glassChrome?: boolean;
    /** Glass-chrome only: floating top-left control (e.g. a glass back chevron). */
    headerLeft?: ReactNode;
    /** Glass-chrome only: the screen title, shown in a see-through glass chip. */
    title?: string;
    /** Glass-chrome only: custom content INSIDE the title chip instead of the plain
     *  `title` text (e.g. the preset picker's tap-to-rename title). Wins over `title`. */
    titleNode?: ReactNode;
    /** Glass-chrome only: keep the floating confirm pill mounted even while
     *  `confirmEnabled` is false (rendered disabled). Default (off) hides it until
     *  enabled — the store-resolution behaviour. */
    confirmAlwaysVisible?: boolean;
}

export function MapPickerScaffold(props: MapPickerScaffoldProps) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { bottom: bottomInset, top: topInset } = useSafeAreaInsets();
    const isDark = useResolvedScheme() === 'dark';

    const mapBlock = (
        <View style={styles.mapBlock}>
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
                // it fought the bubble drill-down zoom and made "empty" taps that
                // hit an invisible marker recentre the map. All camera moves on
                // these pickers are explicit animateToRegion calls.
                moveOnMarkerPress={false}
                    showsUserLocation={props.showsUserLocation ?? true}
                    customMapStyle={isDark ? DARK_MAP_STYLE : undefined}
                    toolbarEnabled={false}
                    // Android: Google's built-in My Location button anchors to the
                    // map's top edge — full-bleed that's UNDER the status bar and
                    // the floating glass chrome. Pad the map's UI area below them
                    // (back row ~40 + search ~48 + gaps ≈ 110dp under the inset).
                    mapPadding={Platform.OS === 'android'
                        ? { top: topInset + 110, right: 0, bottom: 0, left: 0 }
                        : undefined}
                    // Typing in the search field leaves the keyboard up, covering the
                    // confirm pill; a native MapView never dismisses it on its own. Any
                    // touch on the map (tap OR the start of a drag) closes the keyboard —
                    // covers both scaffold users (location preset picker + store resolution).
                    onTouchStart={Keyboard.dismiss}
                >
                    {props.mapChildren}
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

    const searchInput = (
        // iOS: floats inside a row → flex:1 to fill the row width. Android: the
        // search strip is a column (stretch), so NO flex — `flex:1` there sets
        // flexBasis:0 and collapses the field to 0 height.
        <View style={[styles.searchInputWrap, Platform.OS === 'ios' && [styles.searchInputWrapShadow, { flex: 1 }]]}>
            <Ionicons name="search" size={20} color={colors.textSecondary} />
            <TextInput
                style={styles.searchInput}
                value={props.searchText}
                onChangeText={props.onSearchTextChange}
                placeholder={props.searchPlaceholder}
                placeholderTextColor={colors.textMuted}
                returnKeyType="search"
                onSubmitEditing={props.onSearch}
            />
            {props.searching && <MaterialProgress size="small" color={colors.primary} />}
        </View>
    );

    const confirmPanel = (
        <View style={[styles.bottomPanel, { paddingBottom: Math.max(bottomInset, 16) }]}>
            <TouchableOpacity
                style={[styles.confirmBtn, (!props.confirmEnabled || props.confirmLoading) && styles.btnDisabled]}
                onPress={props.onConfirm}
                disabled={!props.confirmEnabled || props.confirmLoading}
            >
                {props.confirmLoading
                    ? <MaterialProgress color={colors.onPrimary} />
                    : <Text style={styles.confirmBtnText}>{props.confirmLabel}</Text>}
            </TouchableOpacity>
        </View>
    );

    // FULL-BLEED GLASS CHROME (store-resolution): the map fills the whole surface;
    // a glass cluster (back chevron + title chip + glass search) floats at the top and
    // the confirm pill floats at the bottom with no panel, only once a store is picked.
    if (props.glassChrome) {
        const chromeFallback = Platform.OS === 'android' ? 'solid' : 'blur';
        const glassSearch = (
            <LiquidGlass fallback={chromeFallback} style={styles.glassSearchWrap}>
                <View style={styles.glassSearchInner}>
                    <Ionicons name="search" size={20} color={colors.textSecondary} />
                    <TextInput
                        style={styles.searchInput}
                        value={props.searchText}
                        onChangeText={props.onSearchTextChange}
                        placeholder={props.searchPlaceholder}
                        placeholderTextColor={colors.textMuted}
                        returnKeyType="search"
                        onSubmitEditing={props.onSearch}
                    />
                    {props.searching && <MaterialProgress size="small" color={colors.primary} />}
                </View>
            </LiquidGlass>
        );
        return (
            <View style={styles.root}>
                {mapBlock}
                {/* Floating top cluster — reserves the status-bar inset itself. */}
                <View style={[styles.glassTop, { top: topInset + spacing.sm }]} pointerEvents="box-none">
                    <View style={styles.glassTopRow} pointerEvents="box-none">
                        {props.headerLeft}
                        {(props.titleNode != null || props.title != null) && (
                            <LiquidGlass fallback={chromeFallback} style={styles.titleChip}>
                                {props.titleNode ?? (
                                    <Text style={styles.titleChipText} numberOfLines={1}>{props.title}</Text>
                                )}
                            </LiquidGlass>
                        )}
                    </View>
                    {glassSearch}
                    {/* Error toast BELOW the search (normal flow, not absolute over it) and
                        pointerEvents:none, so it never blocks tapping/editing the field. The
                        caller auto-dismisses it after a few seconds. */}
                    {props.searchError && (
                        <View style={styles.glassErrorToast} pointerEvents="none">
                            <Text style={styles.errorText}>{props.searchError}</Text>
                        </View>
                    )}
                </View>
                {/* Confirm floats over the map, no panel. Default: mounted only once
                    enabled (store-resolution). confirmAlwaysVisible keeps it mounted,
                    rendered disabled, for pickers where a selection always exists. */}
                {(props.confirmEnabled || props.confirmAlwaysVisible) && (
                    <View style={[styles.confirmFloat, { paddingBottom: Math.max(bottomInset, 16) }]} pointerEvents="box-none">
                        <TouchableOpacity
                            style={[styles.confirmBtn, styles.confirmBtnFloating,
                                (!props.confirmEnabled || props.confirmLoading) && styles.btnDisabled]}
                            onPress={props.onConfirm}
                            disabled={!props.confirmEnabled || props.confirmLoading}
                        >
                            {props.confirmLoading
                                ? <MaterialProgress color={colors.onPrimary} />
                                : <Text style={styles.confirmBtnText}>{props.confirmLabel}</Text>}
                        </TouchableOpacity>
                    </View>
                )}
            </View>
        );
    }

    if (Platform.OS === 'ios') {
        return (
            <View style={styles.root}>
                {mapBlock}
                <View style={styles.searchRowFloating}>{searchInput}</View>
                {props.searchError && (
                    <View style={styles.errorBubble}>
                        <Text style={styles.errorText}>{props.searchError}</Text>
                    </View>
                )}
                {confirmPanel}
            </View>
        );
    }

    return (
        <View style={[styles.root, { backgroundColor: colors.pageBackground }]}>
            <View style={styles.androidForm}>
                {searchInput}
                {props.searchError && <Text style={styles.errorTextInline}>{props.searchError}</Text>}
            </View>
            {mapBlock}
            {confirmPanel}
        </View>
    );
}

const makeStyles = (c: AppTheme) =>
    StyleSheet.create({
        root: { flex: 1 },
        mapBlock: { flex: 1, overflow: 'hidden' },
        // Opaque themed cover over the MapView until onMapReady — hides the raw white
        // GL surface + the marker/pill pop-in during native init.
        mapCover: { backgroundColor: c.pageBackground, alignItems: 'center', justifyContent: 'center' },
        searchRowFloating: {
            position: 'absolute', top: spacing.md, left: spacing.md, right: spacing.md,
            flexDirection: 'row', alignItems: 'center', gap: spacing.sm, zIndex: 10,
        },
        errorBubble: {
            position: 'absolute', top: 64, left: spacing.md, right: spacing.md,
            backgroundColor: c.error, borderRadius: radius.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, zIndex: 11,
        },
        errorText: { ...typography.bodySmall, fontWeight: '500', color: '#fff' },
        androidForm: {
            paddingHorizontal: spacing.md, paddingVertical: spacing.sm, backgroundColor: c.cardBackground,
            borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.borderSubtle,
        },
        errorTextInline: { ...typography.labelSmall, fontWeight: '400', color: c.error, marginTop: spacing.xs },
        // M3-style filled search field: tonal surface, large radius, leading icon.
        searchInputWrap: {
            flexDirection: 'row', alignItems: 'center', gap: spacing.sm, height: 48,
            backgroundColor: c.surfaceMuted, borderRadius: radius.lg, paddingHorizontal: spacing.lg,
        },
        searchInputWrapShadow: { ...elevation.level2 },
        searchInput: { ...typography.body, flex: 1, color: c.textPrimary, paddingVertical: 0 },
        bottomPanel: {
            backgroundColor: c.cardBackground, borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: c.borderSubtle, paddingHorizontal: spacing.lg, paddingTop: spacing.md,
        },
        confirmBtn: { backgroundColor: c.primary, borderRadius: radius.pill, paddingVertical: spacing.md, alignItems: 'center' },
        btnDisabled: { opacity: 0.5 },
        confirmBtnText: { ...typography.bodyStrong, fontWeight: '700', color: c.onPrimary },

        // ── Glass-chrome (full-bleed map + floating liquid-glass controls) ──
        glassTop: {
            position: 'absolute', left: spacing.md, right: spacing.md, zIndex: 10,
            gap: spacing.sm,
        },
        glassTopRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
        // See-through glass title chip next to the back chevron — hugs its text
        // (alignSelf so it doesn't stretch to the row height, no flex so it doesn't
        // stretch to the row width).
        // Painted hairlines ONLY on the Android blur fallback (needs edge
        // definition). iOS native glass carries the SYSTEM edge treatment and
        // follows the user's Liquid Glass appearance setting (Clear/Tinted) —
        // a border painted on top diverges from the default material look.
        titleChip: {
            alignSelf: 'center', overflow: 'hidden', borderRadius: radius.pill,
            ...(Platform.OS === 'android'
                ? { backgroundColor: c.cardBackground, elevation: 3 }
                : null),
            paddingHorizontal: spacing.lg, height: 40, justifyContent: 'center',
        },
        titleChipText: { ...typography.bodyStrong, fontWeight: '700', color: c.textPrimary },
        // Glass search field floating below the title row.
        glassSearchWrap: {
            overflow: 'hidden', borderRadius: radius.lg, height: 48,
            ...(Platform.OS === 'android'
                ? { backgroundColor: c.cardBackground, elevation: 3 }
                : null),
        },
        glassSearchInner: {
            flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
            paddingHorizontal: spacing.lg,
        },
        // Confirm pill floating over the map (no panel behind it).
        confirmFloat: {
            position: 'absolute', left: spacing.lg, right: spacing.lg, bottom: 0, zIndex: 10,
        },
        confirmBtnFloating: { ...elevation.level3 },
        // Search-error toast: sits in the glass top cluster's normal column flow, just under
        // the search field (so it can't cover it), self-sized, auto-dismissed by the caller.
        glassErrorToast: {
            alignSelf: 'flex-start', maxWidth: '100%',
            backgroundColor: c.error, borderRadius: radius.md,
            paddingHorizontal: spacing.lg, paddingVertical: spacing.sm,
        },
    });
