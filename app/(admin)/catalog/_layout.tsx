import { Stack } from 'expo-router';
import { useTheme } from '../../../constants/theme';

export default function CatalogLayout() {
    const colors = useTheme();
    return (
        <Stack
            screenOptions={{
                headerStyle: { backgroundColor: colors.pageBackground },
                headerTintColor: colors.textPrimary,
                headerShadowVisible: false,
                contentStyle: { backgroundColor: colors.pageBackground },
                headerBackTitle: '',
                headerBackButtonDisplayMode: 'minimal',
            }}
        >
            <Stack.Screen name="index" options={{ headerShown: false }} />
        </Stack>
    );
}
