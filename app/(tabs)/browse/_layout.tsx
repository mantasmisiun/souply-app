import { Stack, useRouter } from 'expo-router';
import { TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../../constants/theme';

export default function BrowseLayout() {
    const router = useRouter();
    const colors = useTheme();

    // Both L1 (index) and L2 ([categoryId]) get the same magnifying-
    // glass icon in the right side of the nav bar — tap pushes the
    // dedicated /search screen with the products mode preselected.
    // Single shared definition so the two screens stay in sync if
    // the destination route or params ever change.
    const searchHeaderRight = () => (
        <TouchableOpacity
            onPress={() =>
                router.push({
                    pathname: '/search',
                    params: { mode: 'products', source: 'browse' },
                })
            }
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
        >
            <Ionicons name="search" size={24} color={colors.primary} />
        </TouchableOpacity>
    );

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
                    headerRight: searchHeaderRight,
                }}
            />
            <Stack.Screen
                name="[categoryId]"
                options={({ route }: any) => ({
                    title: route.params?.name ? decodeURIComponent(route.params.name) : '',
                    headerRight: searchHeaderRight,
                })}
            />
        </Stack>
    );
}