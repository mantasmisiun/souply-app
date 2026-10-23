import { useMemo } from 'react';
import { Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ScalePressable } from '../ScalePressable';
import { MaterialProgress } from '../MaterialProgress';
import { radius, type AppTheme } from '../../constants/theme';

/**
 * The dock bar's solid-pink action pill — the recipe screen's "Parduotuvės ›"
 * treatment, extracted so every bar-row action (Parduotuvės, the create pane's
 * Sukurti, the edit pane's Išsaugoti) is the SAME pill instead of near-copies
 * of one style block per host.
 *
 * Disabled OR busy fades the pill and disarms the press/scale; busy swaps the
 * label for a small spinner inside the same footprint, so the row never
 * resizes while work is in flight.
 */
export function ActionPill({ colors, label, onPress, disabled = false, busy = false, chevron = false, style }: {
    colors: AppTheme;
    label: string;
    onPress: () => void;
    disabled?: boolean;
    busy?: boolean;
    /** Trailing › — for pills that navigate (Parduotuvės) rather than submit. */
    chevron?: boolean;
    /** Layout-only overrides from the host row (e.g. flex: 1 to span it). */
    style?: StyleProp<ViewStyle>;
}) {
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const inert = disabled || busy;
    return (
        <ScalePressable
            style={[styles.pill, inert && styles.pillDisabled, style]}
            onPress={onPress}
            disabled={inert}
            scaleTo={inert ? 1 : 0.95}
        >
            {busy
                ? <MaterialProgress size="small" color={colors.onPrimary} />
                : (
                    <>
                        <Text style={styles.pillText}>{label}</Text>
                        {chevron && <Ionicons name="chevron-forward" size={16} color={colors.onPrimary} />}
                    </>
                )}
        </ScalePressable>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    pill: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
        backgroundColor: c.primary, borderRadius: radius.pill,
        paddingHorizontal: 20, paddingVertical: 10,
    },
    pillDisabled: { opacity: 0.45 },
    pillText: { fontSize: 15, fontWeight: '700', color: c.onPrimary },
});
