import { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, radius, typography, type AppTheme } from '../constants/theme';
import { type ProfileData } from '../state/profileStore';
import { formatEuro } from '../utils/formatCurrency';

/**
 * Aggregate template stats for a CREATOR account — templates, visits, uses and
 * the savings their followers made. Creator-gated: regular users have nothing to
 * put in these four boxes. Split out of the old CreatorProfileHeader so the
 * identity row above it (ProfileIdentityHeader) is shared by every account type.
 */
export function CreatorStatsCards({ profile }: { profile: ProfileData }) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const cards: { label: string; value: string }[] = [
        { label: t('profilis.statTemplates'), value: String(profile.templateCount ?? 0) },
        { label: t('profilis.statVisits'), value: String(profile.totalVisits ?? 0) },
        { label: t('profilis.statUses'), value: String(profile.totalUses ?? 0) },
        { label: t('profilis.statFollowerSavings'), value: formatEuro(profile.totalFollowerSavingsEur ?? 0) },
    ];

    return (
        <View style={styles.cards}>
            {cards.map((c, i) => (
                <View key={i} style={styles.card}>
                    <Text style={styles.cardValue} numberOfLines={1}>{c.value}</Text>
                    <Text style={styles.cardLabel} numberOfLines={1}>{c.label}</Text>
                </View>
            ))}
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    cards: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.lg },
    card: {
        flex: 1, backgroundColor: c.cardBackground, borderRadius: radius.lg,
        paddingVertical: spacing.md, paddingHorizontal: 6, alignItems: 'center', gap: 3,
        borderWidth: 1, borderColor: c.border,
    },
    cardValue: { ...typography.subheading, fontWeight: '800', color: c.primary },
    cardLabel: { ...typography.caption, fontWeight: '600', color: c.textSecondary, textAlign: 'center' },
});
