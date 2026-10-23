import { TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LiquidGlass } from '../LiquidGlass';
import { useTheme, radius, elevation, iconSize } from '../../constants/theme';

/**
 * The one back button for full-bleed MAP surfaces — a liquid-glass circle with a
 * pink chevron (solid card fallback for contrast over map tiles). Shared so every
 * map screen's back button looks and behaves identically: the store-results map,
 * the preset point-pick and the store-resolution pick all render THIS, instead of
 * each rolling its own (the GlassIconButton chip's Expressive squircle press-morph
 * is the in-page-header voice, not the map's — hence the mismatch it replaces).
 */
export function MapBackButton({ onPress }: { onPress: () => void }) {
    const colors = useTheme();
    return (
        // Glass clips to its rounded shape (overflow hidden), so the shadow rides
        // an outer wrapper — a clipped view can't cast one.
        <TouchableOpacity style={styles.shadow} onPress={onPress} activeOpacity={0.8} hitSlop={8}>
            <LiquidGlass style={[styles.btn, { backgroundColor: colors.cardBackground, borderColor: colors.border }]} fallback="solid">
                <Ionicons name="chevron-back" size={iconSize.lg} color={colors.primary} />
            </LiquidGlass>
        </TouchableOpacity>
    );
}

const styles = StyleSheet.create({
    shadow: { borderRadius: radius.pill, ...elevation.level2 },
    btn: {
        width: 42, height: 42, borderRadius: radius.pill, overflow: 'hidden',
        alignItems: 'center', justifyContent: 'center',
        borderWidth: StyleSheet.hairlineWidth,
    },
});
