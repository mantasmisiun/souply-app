import { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScreenBackButton } from './ScreenBackButton';
import { useTheme, spacing, typography, type AppTheme } from '../constants/theme';

/**
 * In-screen nav bar for screens that hide the native header: the standard
 * chrome row — pink back chevron (ScreenBackButton) + a left-aligned title —
 * mirroring the trip-final screen's `chrome`/`title` styles. Owns its top
 * safe-area inset, so hosts must NOT pad the status bar themselves.
 */
export function ScreenNavBar({
    title,
    subtitle,
    onBack,
}: {
    title: string;
    /** Optional muted subline under the title (e.g. multi-receipt progress). */
    subtitle?: string;
    onBack: () => void;
}) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const insets = useSafeAreaInsets();
    return (
        <View style={[styles.chrome, { paddingTop: insets.top + 8 }]}>
            <ScreenBackButton onPress={onBack} />
            <View style={styles.titleWrap}>
                <Text style={styles.title} numberOfLines={1}>{title}</Text>
                {!!subtitle && <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text>}
            </View>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    chrome: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
    titleWrap: { flex: 1, minWidth: 0 },
    title: { fontSize: 22, fontWeight: '800', color: c.textPrimary },
    subtitle: { ...typography.labelSmall, color: c.textMuted, marginTop: 1 },
});
