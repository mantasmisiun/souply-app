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
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import MapView, { type Region } from 'react-native-maps';
import { DARK_MAP_STYLE } from '../../constants/darkMapStyle';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
    showsUserLocation?: boolean;

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
}

export function MapPickerScaffold(props: MapPickerScaffoldProps) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { bottom: bottomInset } = useSafeAreaInsets();
    const isDark = useResolvedScheme() === 'dark';

    const mapBlock = (
        <View style={styles.mapBlock}>
            <MapView
                ref={props.mapRef}
                style={StyleSheet.absoluteFillObject}
                initialRegion={props.initialRegion}
                onMapReady={props.onMapReady}
                onRegionChangeComplete={props.onRegionChangeComplete}
                showsUserLocation={props.showsUserLocation ?? true}
                customMapStyle={isDark ? DARK_MAP_STYLE : undefined}
                toolbarEnabled={false}
            >
                {props.mapChildren}
            </MapView>
            {props.overlay}
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
    });
