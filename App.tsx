import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import BrowseScreen from './screens/BrowseScreen';
import BasketScreen from './screens/BasketScreen';
import ShoppingListScreen from './screens/ShoppingListScreen';
import ReceiptScreen from './screens/ReceiptScreen';

const Tab = createBottomTabNavigator();

export default function App() {
    return (
        <SafeAreaProvider>
            <NavigationContainer>
                <Tab.Navigator
                    screenOptions={({ route }) => ({
                        tabBarIcon: ({ focused, color, size }) => {
                            let iconName: any;
                            if (route.name === 'Naršyti') iconName = focused ? 'search' : 'search-outline';
                            else if (route.name === 'Krepšelis') iconName = focused ? 'cart' : 'cart-outline';
                            else if (route.name === 'Pirkinių sąrašas') iconName = focused ? 'list' : 'list-outline';
                            else if (route.name === 'Kvitai') iconName = focused ? 'receipt' : 'receipt-outline';
                            return <Ionicons name={iconName} size={size} color={color} />;
                        },
                        tabBarActiveTintColor: '#2e7d32',
                        tabBarInactiveTintColor: 'gray',
                        headerShown: true,
                    })}
                >
                    <Tab.Screen name="Naršyti" component={BrowseScreen} />
                    <Tab.Screen name="Krepšelis" component={BasketScreen} />
                    <Tab.Screen name="Pirkinių sąrašas" component={ShoppingListScreen} />
                    <Tab.Screen name="Kvitai" component={ReceiptScreen} />
                </Tab.Navigator>
            </NavigationContainer>
        </SafeAreaProvider>
    );
}