import { Tabs } from 'expo-router';
import { NativeTabs, Icon, Label, Badge } from 'expo-router/unstable-native-tabs';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { Component, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform, View, Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import { useTheme, type AppTheme } from '../../constants/theme';
import { useProfileStore } from '../../state/profileStore';
import { HapticTab } from '../../components/haptic-tab';
import { devLog } from '../../utils/devLog';

class NativeTabsBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { hasError: boolean }> {
    state = { hasError: false };
    static getDerivedStateFromError() { return { hasError: true }; }
    componentDidCatch(error: Error, info: { componentStack?: string | null }) {
        devLog('tabs.iosBoundaryCaught', {
            name: error?.name,
            message: error?.message,
            stack: error?.stack?.split('\n').slice(0, 30).join('\n'),
            componentStack: info?.componentStack?.split('\n').slice(0, 30).join('\n'),
        });
    }
    render() { return this.state.hasError ? this.props.fallback : this.props.children; }
}

function TabBadge({ count, styles }: { count: number; styles: ReturnType<typeof makeStyles> }) {
    if (count === 0) return null;
    return (
        <View style={styles.badge}>
            <Text style={styles.badgeText}>{count > 9 ? '9+' : count}</Text>
        </View>
    );
}

export default function TabLayout() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const [basketCount, setBasketCount] = useState(0);
    const [listCount, setListCount] = useState(0);
    const [pendingSwipeCount, setPendingSwipeCount] = useState(0);

    const fetchCounts = async () => {
        try {
            const userId = await getUserId();
            const [basketRes, listRes, profileRes] = await Promise.all([
                fetch(`${API_BASE_URL}/api/baskets/user/${userId}`),
                fetch(`${API_BASE_URL}/api/shopping-lists/user/${userId}`),
                fetch(`${API_BASE_URL}/api/users/${userId}/profile`),
            ]);
            const baskets = await basketRes.json();
            const lists = await listRes.json();
            const profile = await profileRes.json();

            setBasketCount(Array.isArray(baskets)
                ? baskets.filter((b: any) => b.status !== 'completed').length
                : 0
            );
            setListCount(Array.isArray(lists)
                ? lists.filter((l: any) => l.status === 'active').length
                : 0
            );
            setPendingSwipeCount(profile?.pendingSwipeCount ?? (profile?.pendingSwipes ? 1 : 0));
        } catch (error) {
            console.error('Failed to fetch counts:', error);
        }
    };

    useEffect(() => {
        fetchCounts();
        const interval = setInterval(fetchCounts, 10000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        useProfileStore.getState().fetchProfile();
    }, []);

    const jsTabs = (
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
                name="browse"
                options={{
                    title: t('tabs.browse'),
                    headerShown: false,
                    tabBarIcon: ({ focused, color, size }) => (
                        <Ionicons name={focused ? 'search' : 'search-outline'} size={size} color={color} />
                    ),
                }}
            />
            <Tabs.Screen
                name="basket"
                options={{
                    title: t('tabs.basket'),
                    tabBarIcon: ({ focused, color, size }) => (
                        <View>
                            <Ionicons name={focused ? 'cart' : 'cart-outline'} size={size} color={color} />
                            <TabBadge count={basketCount} styles={styles} />
                        </View>
                    ),
                }}
            />
            <Tabs.Screen
                name="shoppingList"
                options={{
                    title: t('tabs.shoppingList'),
                    tabBarIcon: ({ focused, color, size }) => (
                        <View>
                            <Ionicons name={focused ? 'list' : 'list-outline'} size={size} color={color} />
                            <TabBadge count={listCount} styles={styles} />
                        </View>
                    ),
                }}
            />
            <Tabs.Screen
                name="receipts"
                options={{
                    title: t('tabs.receipts'),
                    headerStyle: { backgroundColor: colors.cardBackground },
                    tabBarIcon: ({ focused, color, size }) => (
                        <View>
                            <Ionicons name={focused ? 'receipt' : 'receipt-outline'} size={size} color={color} />
                            {pendingSwipeCount > 0 && <TabBadge count={pendingSwipeCount} styles={styles} />}
                        </View>
                    ),
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

    if (Platform.OS === 'ios') {
        devLog('tabs.iosLayoutMount', { basketCount, listCount, pendingSwipeCount });
        const fmt = (n: number) => (n > 0 ? (n > 9 ? '9+' : String(n)) : undefined);
        const basketBadge = fmt(basketCount);
        const listBadge = fmt(listCount);
        const swipeBadge = fmt(pendingSwipeCount);
        return (
            <NativeTabsBoundary fallback={jsTabs}>
                <NativeTabs tintColor={colors.primary}>
                    <NativeTabs.Trigger name="browse">
                        <Icon sf="magnifyingglass" />
                        <Label>{t('tabs.browse')}</Label>
                    </NativeTabs.Trigger>
                    <NativeTabs.Trigger name="basket">
                        <Icon sf={{ default: 'cart', selected: 'cart.fill' }} />
                        <Label>{t('tabs.basket')}</Label>
                        {basketBadge ? <Badge>{basketBadge}</Badge> : null}
                    </NativeTabs.Trigger>
                    <NativeTabs.Trigger name="shoppingList">
                        <Icon sf="list.bullet" />
                        <Label>{t('tabs.shoppingList')}</Label>
                        {listBadge ? <Badge>{listBadge}</Badge> : null}
                    </NativeTabs.Trigger>
                    <NativeTabs.Trigger name="receipts">
                        <Icon sf={{ default: 'doc.text', selected: 'doc.text.fill' }} />
                        <Label>{t('tabs.receipts')}</Label>
                        {swipeBadge ? <Badge>{swipeBadge}</Badge> : null}
                    </NativeTabs.Trigger>
                    <NativeTabs.Trigger name="menu">
                        <Icon sf={{ default: 'person', selected: 'person.fill' }} />
                        <Label>{t('tabs.profilis')}</Label>
                    </NativeTabs.Trigger>
                </NativeTabs>
            </NativeTabsBoundary>
        );
    }

    return jsTabs;
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    badge: {
        position: 'absolute',
        top: -4,
        right: -8,
        backgroundColor: c.primary,
        borderRadius: 10,
        minWidth: 16,
        height: 16,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 3,
    },
    badgeText: { color: c.onPrimary, fontSize: 9, fontWeight: '700' },
});
