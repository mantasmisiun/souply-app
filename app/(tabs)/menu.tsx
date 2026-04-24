import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { useTheme, type AppTheme } from '../../constants/theme';

/**
 * Dev-only hub. Lives behind the __DEV__ gate in _layout.tsx so it
 * never renders in release builds. Each row is a link to a dev tool
 * under app/dev/*. New tools = one new row here + one new file there.
 */
export default function MenuScreen() {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();

    const items: Array<{ label: string; icon: keyof typeof Ionicons.glyphMap; route: string }> = [
        { label: 'Kvitų paketinis testas', icon: 'flask-outline', route: '/dev/receipt-batch' },
        { label: 'Admin', icon: 'shield-outline', route: '/dev/admin' },
    ];

    return (
        <ScrollView style={styles.container} contentContainerStyle={styles.content}>
            <Text style={styles.sectionTitle}>Kūrėjo įrankiai</Text>
            {items.map((item) => (
                <TouchableOpacity
                    key={item.route}
                    style={styles.row}
                    onPress={() => router.push(item.route as any)}
                >
                    <Ionicons name={item.icon} size={22} color={colors.textSecondary} />
                    <Text style={styles.rowText}>{item.label}</Text>
                    <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                </TouchableOpacity>
            ))}
        </ScrollView>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    content: { padding: 16 },
    sectionTitle: {
        fontSize: 13, fontWeight: '700', color: c.textMuted,
        marginBottom: 8, textTransform: 'uppercase',
    },
    row: {
        flexDirection: 'row', alignItems: 'center', gap: 12,
        backgroundColor: c.cardBackground,
        paddingVertical: 14, paddingHorizontal: 16,
        borderRadius: 10, marginBottom: 8,
    },
    rowText: { flex: 1, fontSize: 15, color: c.textPrimary, fontWeight: '500' },
});
