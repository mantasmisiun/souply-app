import { View, Text, StyleSheet } from 'react-native';
import { useMemo } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../constants/theme';

/**
 * Placeholder admin tab. Reserved for the next admin surface we ship
 * (likely the missing-amounts cleanup). Renders an explicit "Tuoj bus"
 * screen so a tap doesn't look like a broken navigation.
 */
export default function AdminPlaceholder1() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    return (
        <View style={styles.page}>
            <Ionicons name="construct-outline" size={48} color={colors.textMuted} />
            <Text style={styles.title}>{t('admin.placeholderTitle')}</Text>
            <Text style={styles.body}>{t('admin.placeholderBody')}</Text>
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    page: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12, backgroundColor: c.pageBackground },
    title: { fontSize: 18, fontWeight: '700', color: c.textPrimary, marginTop: 8 },
    body: { fontSize: 14, color: c.textSecondary, textAlign: 'center' },
});
