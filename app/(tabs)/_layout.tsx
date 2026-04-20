import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';

function Badge({ count }: { count: number }) {
    if (count === 0) return null;
    return (
        <View style={styles.badge}>
            <Text style={styles.badgeText}>{count > 9 ? '9+' : count}</Text>
        </View>
    );
}

export default function TabLayout() {
    const [basketCount, setBasketCount] = useState(0);
    const [listCount, setListCount] = useState(0);

    const fetchCounts = async () => {
        try {
            const userId = await getUserId();
            const [basketRes, listRes] = await Promise.all([
                fetch(`${API_BASE_URL}/api/baskets/user/${userId}`),
                fetch(`${API_BASE_URL}/api/shopping-lists/user/${userId}`),
            ]);
            const baskets = await basketRes.json();
            const lists = await listRes.json();

            setBasketCount(Array.isArray(baskets)
                ? baskets.filter((b: any) => b.status !== 'completed').length
                : 0
            );
            setListCount(Array.isArray(lists)
                ? lists.filter((l: any) => l.status === 'active').length
                : 0
            );
        } catch (error) {
            console.error('Failed to fetch counts:', error);
        }
    };

    useEffect(() => {
        fetchCounts();
        const interval = setInterval(fetchCounts, 10000);
        return () => clearInterval(interval);
    }, []);

    return (
        <Tabs
            screenOptions={{
                tabBarActiveTintColor: '#2e7d32',
                tabBarInactiveTintColor: 'gray',
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
                            <Badge count={basketCount} />
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
                            <Badge count={listCount} />
                        </View>
                    ),
                }}
            />
            <Tabs.Screen
                name="receipts"
                options={{
                    title: 'Analizė',
                    tabBarIcon: ({ focused, color, size }) => (
                    <Ionicons name={focused ? 'receipt' : 'receipt-outline'} size={size} color={color} />
                    ),
                }}
            />
        </Tabs>
    );
}

const styles = StyleSheet.create({
    badge: {
        position: 'absolute',
        top: -4,
        right: -8,
        backgroundColor: '#c62828',
        borderRadius: 10,
        minWidth: 16,
        height: 16,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 3,
    },
    badgeText: { color: 'white', fontSize: 9, fontWeight: '700' },
});