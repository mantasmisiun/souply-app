import { ReactNode, useMemo } from 'react';
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    Platform,
} from 'react-native';
import { MaterialProgress } from '@/components/MaterialProgress';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LiquidGlass } from '../LiquidGlass';
import { useTheme, spacing, radius, typography, elevation, type AppTheme } from '../../constants/theme';

/**
 * Floating pick-mode chrome — the liquid-glass top cluster (back chevron +
 * title chip + search field + error toast) and the floating confirm pill,
 * WITHOUT the map. Extracted from MapPickerScaffold's glassChrome branch so
 * the 2.0 unified map host can overlay the same chrome onto a map it owns
 * (point-pick / store-resolution modes), while MapPickerScaffold keeps using
 * it for the standalone screens.
 *
 * Renders two absolutely-positioned clusters — the parent must be the map's
 * positioning context (typically the full-bleed map root view).
 */
export interface MapPickChromeProps {
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

    /** Floating top-left control (e.g. a glass back chevron / Cancel). */
    headerLeft?: ReactNode;
    /** Screen title, shown in a see-through glass chip. */
    title?: string;
    /** Custom content INSIDE the title chip instead of the plain `title` text
     *  (e.g. the preset picker's tap-to-rename title). Wins over `title`. */
    titleNode?: ReactNode;
    /** Keep the floating confirm pill mounted even while `confirmEnabled` is
     *  false (rendered disabled). Default (off) hides it until enabled — the
     *  store-resolution behaviour. */
    confirmAlwaysVisible?: boolean;
    /** Hide the search field (pick modes that don't need address search). */
    hideSearch?: boolean;
}

export function MapPickChrome(props: MapPickChromeProps) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { bottom: bottomInset, top: topInset } = useSafeAreaInsets();
    const chromeFallback = Platform.OS === 'android' ? 'solid' : 'blur';

    return (
        <>
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
                {!props.hideSearch && (
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
                )}
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
        </>
    );
}

const makeStyles = (c: AppTheme) =>
    StyleSheet.create({
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
        searchInput: { ...typography.body, flex: 1, color: c.textPrimary, paddingVertical: 0 },
        // Confirm pill floating over the map (no panel behind it).
        confirmFloat: {
            position: 'absolute', left: spacing.lg, right: spacing.lg, bottom: 0, zIndex: 10,
        },
        confirmBtn: { backgroundColor: c.primary, borderRadius: radius.pill, paddingVertical: spacing.md, alignItems: 'center' },
        confirmBtnFloating: { ...elevation.level3 },
        btnDisabled: { opacity: 0.5 },
        confirmBtnText: { ...typography.bodyStrong, fontWeight: '700', color: c.onPrimary },
        // Search-error toast: sits in the glass top cluster's normal column flow, just under
        // the search field (so it can't cover it), self-sized, auto-dismissed by the caller.
        errorText: { ...typography.bodySmall, fontWeight: '500', color: '#fff' },
        glassErrorToast: {
            alignSelf: 'flex-start', maxWidth: '100%',
            backgroundColor: c.error, borderRadius: radius.md,
            paddingHorizontal: spacing.lg, paddingVertical: spacing.sm,
        },
    });
