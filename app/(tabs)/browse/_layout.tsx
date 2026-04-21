import { Stack, useRouter } from 'expo-router';
import { TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../../constants/theme';

export default function BrowseLayout() {
    const router = useRouter();
    const colors = useTheme();

    return (
        <Stack
            screenOptions={{
                headerStyle: { backgroundColor: colors.pageBackground },
                headerTintColor: colors.textPrimary,
                headerShadowVisible: false,
                contentStyle: { backgroundColor: colors.pageBackground },
            }}
        >
            <Stack.Screen
                name="index"
                options={{
                    title: 'Naršyti',
                    headerRight: () => (
                        <TouchableOpacity
                            onPress={() =>
                            router.push({
                                pathname: '/search',
                                params: { mode: 'products', source: 'browse' },
                            })
                            }
                            style={{ marginRight: 12 }}
                        >
                            <Ionicons name="search" size={24} color={colors.primary} />
                        </TouchableOpacity>
                    ),
                }}
            />
            <Stack.Screen name="[categoryId]" />
        </Stack>
    );
}