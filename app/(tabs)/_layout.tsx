import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

export default function TabLayout() {
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
                        <Ionicons name={focused ? 'cart' : 'cart-outline'} size={size} color={color} />
                    ),
                }}
            />
            <Tabs.Screen
                name="shoppingList"
                options={{
                    title: 'Pirkinių sąrašas',
                    tabBarIcon: ({ focused, color, size }) => (
                        <Ionicons name={focused ? 'list' : 'list-outline'} size={size} color={color} />
                    ),
                }}
            />
            <Tabs.Screen
                name="receipts"
                options={{
                    title: 'Kvitai',
                    tabBarIcon: ({ focused, color, size }) => (
                        <Ionicons name={focused ? 'receipt' : 'receipt-outline'} size={size} color={color} />
                    ),
                }}
            />
        </Tabs>
    );
}