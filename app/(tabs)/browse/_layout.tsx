import { Stack, useRouter } from 'expo-router';
import { TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export default function BrowseLayout() {
    const router = useRouter();

    return (
        <Stack>
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
                            <Ionicons name="search" size={24} color="#2e7d32" />
                        </TouchableOpacity>
                    ),
                }}
            />
            <Stack.Screen name="[categoryId]" />
        </Stack>
    );
}