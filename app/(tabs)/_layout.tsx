import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import { useTheme, type AppTheme } from '../../constants/theme';
import { useProfileStore } from '../../state/profileStore';
import { HapticTab } from '../../components/haptic-tab';

function Badge({ count, styles }: { count: number; styles: ReturnType<typeof makeStyles> }) {
    if (count === 0) return null;
    return (
        <View style={styles.badge}>
            <Text style={styles.badgeText}>{count > 9 ? '9+' : count}</Text>
        </View>
    );
}

export default function TabLayout() {
    const colors = useTheme();
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
                name="browse"
                options={{
                    title: 'Naršyti',
                    headerShown: false,
                    tabBarIcon: ({ focused, color, size }) => (
                        <Ionicons name={focused ? 'search' : 'search-outline'} size={size} color={color} />
                    ),
                }}
            />
            <Tabs.Screen
                name="basket"
                options={{
                    title: 'Krepšelis',
                    tabBarIcon: ({ focused, color, size }) => (
                        <View>
                            <Ionicons name={focused ? 'cart' : 'cart-outline'} size={size} color={color} />
                            <Badge count={basketCount} styles={styles} />
                        </View>
                    ),
                }}
            />
            <Tabs.Screen
                name="shoppingList"
                options={{
                    title: 'Pirkinių sąrašas',
                    tabBarIcon: ({ focused, color, size }) => (
                        <View>
                            <Ionicons name={focused ? 'list' : 'list-outline'} size={size} color={color} />
                            <Badge count={listCount} styles={styles} />
                        </View>
                    ),
                }}
            />
            <Tabs.Screen
                name="receipts"
                options={{
                    title: 'Analizė',
                    tabBarIcon: ({ focused, color, size }) => (
                        <View>
                            <Ionicons name={focused ? 'receipt' : 'receipt-outline'} size={size} color={color} />
                            {pendingSwipeCount > 0 && <Badge count={pendingSwipeCount} styles={styles} />}
                        </View>
                    ),
                }}
            />
            <Tabs.Screen
                name="menu"
                options={{
                    title: 'Profilis',
                    tabBarIcon: ({ focused, color, size }) => (
                        <Ionicons name={focused ? 'person' : 'person-outline'} size={size} color={color} />
                    ),
                }}
            />
        </Tabs>
    );
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
