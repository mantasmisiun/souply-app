import { View, Text, StyleSheet } from 'react-native';
import { useState } from 'react';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { ScreenBackButton } from '../../components/ScreenBackButton';
import { DockedGlassSheet } from '../../components/DockedGlassSheet';
import { DockTabsRow } from '../../components/FloatingPillTabBar';
import { useTheme, spacing, type AppTheme } from '../../constants/theme';

type Tab = 'basket' | 'history';

/**
 * Family-shopping screen — the destination of the pinned card on the Shopping
 * tab. Standard chrome (back + title) + the receipt-stats-style floating tab
 * bar (Basket / History). Tab bodies are scaffolds only — the real content
 * ships in a follow-up per the forthcoming spec.
 */
export default function FamilyScreen() {
    const colors = useTheme();
    const insets = useSafeAreaInsets();
    const { t } = useTranslation();
    const styles = makeStyles(colors);
    const [tab, setTab] = useState<Tab>('basket');

    return (
        <>
            <Stack.Screen options={{ headerShown: false }} />
            <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
                <View style={styles.chrome}>
                    <ScreenBackButton />
                    <Text style={styles.title} numberOfLines={1}>{t('family.screenTitle')}</Text>
                </View>

                <View style={styles.body}>
                    <Ionicons
                        name={tab === 'basket' ? 'cart-outline' : 'time-outline'}
                        size={48}
                        color={colors.textMuted}
                    />
                    <Text style={styles.placeholderTitle}>
                        {tab === 'basket' ? t('family.tabBasket') : t('family.tabHistory')}
                    </Text>
                    <Text style={styles.placeholderSub}>{t('family.comingSoon')}</Text>
                </View>
            </View>

            <DockedGlassSheet
                compact
                barRowHeight={0}
                barRow={
                    <DockTabsRow
                        hug
                        tabs={[
                            { key: 'basket', label: t('family.tabBasket'), icon: 'cart-outline' },
                            { key: 'history', label: t('family.tabHistory'), icon: 'time-outline' },
                        ]}
                        activeKey={tab}
                        onSelect={(k) => setTab(k as Tab)}
                    />
                }
            />
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },
    chrome: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
    title: { flex: 1, fontSize: 22, fontWeight: '800', color: c.textPrimary },
    body: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.xl },
    placeholderTitle: { fontSize: 18, fontWeight: '800', color: c.textPrimary },
    placeholderSub: { fontSize: 13, color: c.textSecondary, textAlign: 'center' },
});
