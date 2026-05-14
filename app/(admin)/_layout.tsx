import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../constants/theme';
import { HapticTab } from '../../components/haptic-tab';

/**
 * Tab bar shown when the user is in admin mode (toggled from Profilis).
 *
 * Layout: Images / placeholder / placeholder / placeholder / Profile.
 * The placeholders are intentionally inert — they'll be wired up as
 * additional admin tabs ship (amounts, names, dead-end orphans, audit).
 * Until then they show a "Tuoj bus" hint when tapped so users don't
 * think the app is broken.
 *
 * Mode switching lives in `state/adminModeStore`. Profilis on the user
 * side has a "Pereiti į admin panelį"; this side's Profilis has
 * "Sugrįžti į vartotojo panelį" — both flip the persisted store flag
 * and `router.replace` to the appropriate root.
 */

function PlaceholderTabIcon({ color, size }: { color: string; size: number }) {
    return <Ionicons name="ellipsis-horizontal" size={size} color={color} />;
}

export default function AdminTabLayout() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    return (
        <Tabs
            screenOptions={{
                tabBarButton: HapticTab,
                tabBarActiveTintColor: colors.primary,
                tabBarInactiveTintColor: colors.textSecondary,
                tabBarStyle: {
                    backgroundColor: colors.cardBackground,
                    borderTopColor: colors.borderSubtle,
                },
                headerStyle: { backgroundColor: colors.pageBackground },
                headerTintColor: colors.textPrimary,
                headerShadowVisible: false,
            }}
        >
            <Tabs.Screen
                name="images"
                options={{
                    title: t('admin.tabImages'),
                    tabBarIcon: ({ focused, color, size }) => (
                        <Ionicons
                            name={focused ? 'image' : 'image-outline'}
                            size={size}
                            color={color}
                        />
                    ),
                }}
            />
            <Tabs.Screen
                name="placeholder1"
                options={{
                    title: t('admin.tabPlaceholder'),
                    tabBarIcon: ({ color, size }) => <PlaceholderTabIcon color={color} size={size} />,
                }}
            />
            <Tabs.Screen
                name="placeholder2"
                options={{
                    title: t('admin.tabPlaceholder'),
                    tabBarIcon: ({ color, size }) => <PlaceholderTabIcon color={color} size={size} />,
                }}
            />
            <Tabs.Screen
                name="placeholder3"
                options={{
                    title: t('admin.tabPlaceholder'),
                    tabBarIcon: ({ color, size }) => <PlaceholderTabIcon color={color} size={size} />,
                }}
            />
            <Tabs.Screen
                name="menu"
                options={{
                    title: t('tabs.profilis'),
                    tabBarIcon: ({ focused, color, size }) => (
                        <Ionicons name={focused ? 'person' : 'person-outline'} size={size} color={color} />
                    ),
                }}
            />
        </Tabs>
    );
}

const makeStyles = (_c: AppTheme) => StyleSheet.create({});
