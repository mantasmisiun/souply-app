import { View, Text, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { useMemo } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, type AppTheme } from '../../constants/theme';

/**
 * Placeholder for future admin-scoped tooling. Reached from the Menu
 * tab (dev-only). Intentionally empty for now — purpose is to reserve
 * the route and surface the entry point.
 */
export default function AdminPlaceholderScreen() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    return (
        <View style={styles.container}>
            <Stack.Screen options={{ title: 'Admin' }} />
            <Ionicons name="construct-outline" size={48} color={colors.textMuted} />
            <Text style={styles.title}>Admin</Text>
            <Text style={styles.subtitle}>Placeholder — ateityje bus admin įrankiai</Text>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
        gap: 10,
        backgroundColor: c.pageBackground,
    },
    title: { fontSize: 18, fontWeight: '700', color: c.textPrimary },
    subtitle: { fontSize: 13, color: c.textSecondary, textAlign: 'center' },
});
