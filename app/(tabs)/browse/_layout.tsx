import { Stack } from 'expo-router';
import { useTheme } from '../../../constants/theme';

/**
 * The browse tab only contains its root (index.tsx). Pushed screens —
 * /discounts and /browse/[categoryId] — live at the app root so the iOS
 * NativeTabs tab bar hides on push (SwiftUI doesn't auto-hide for screens
 * pushed inside a tab's nested stack).
 */
export default function BrowseLayout() {
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