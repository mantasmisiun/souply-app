import { useMemo } from 'react';
import { TouchableOpacity, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useSheetDismiss } from './GlassSheet';
import { useTheme, radius, type AppTheme } from '../constants/theme';

/**
 * The X for a GlassSheet's title row. Dismisses through the sheet's own
 * animation (SheetDismissContext) rather than yanking it off screen, so an
 * in-sheet close looks identical to a backdrop tap or a drag-down.
 *
 * Outside a sheet it falls back to `onPress` — or renders nothing to press if
 * neither is available, which is the honest outcome for a misplaced button.
 */
export function SheetCloseButton({ onPress, style }: {
    /** Fallback when this isn't inside a GlassSheet. */
    onPress?: () => void;
    style?: StyleProp<ViewStyle>;
}) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const dismiss = useSheetDismiss();
    const handle = dismiss ?? onPress;
    if (!handle) return null;
    return (
        <TouchableOpacity
            onPress={handle}
            hitSlop={8}
            style={[styles.btn, style]}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
        >
            <Ionicons name="close" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    btn: {
        width: 40, height: 40, borderRadius: radius.pill,
        alignItems: 'center', justifyContent: 'center',
        // Light pink, matching the Receptai card's cover-emoji chip. A neutral
        // beige chip sat oddly next to the app's pink chrome; the ✕ is a chip in
        // the same family, not a separate grey control.
        backgroundColor: (c as any).primaryMuted ?? c.surfaceMuted,
    },
});
