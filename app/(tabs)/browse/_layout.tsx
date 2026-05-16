import { Stack, useRouter } from 'expo-router';
import { useRef } from 'react';
import { useTheme } from '../../../constants/theme';
import { GlassIconButton } from '../../../components/GlassIconButton';

export default function BrowseLayout() {
    const router = useRouter();
    const colors = useTheme();

    // Tap-debounce so a quick double-tap on the search icon doesn't push
    // /search twice onto the stack. The transition animation makes the
    // button visible (and tappable) for the first ~300ms after press.
    const lastSearchPushAt = useRef(0);
    const pushSearch = () => {
        const now = Date.now();
        if (now - lastSearchPushAt.current < 600) return;
        lastSearchPushAt.current = now;
        router.push({
            pathname: '/search',
            params: { mode: 'products', source: 'browse' },
        });
    };

    // [categoryId] uses the native Stack header so the back chevron + L2
    // title come for free. The L1 index screen renders its own TabHeader
    // (matching the other four tabs), so headerShown is false there.
    const searchHeaderRight = () => (
        <GlassIconButton icon="search" onPress={pushSearch} />
    );

    return (
        <Stack
            screenOptions={{
                headerStyle: { backgroundColor: colors.pageBackground },
                headerTintColor: colors.textPrimary,
                headerShadowVisible: false,
                contentStyle: { backgroundColor: colors.pageBackground },
                // Hide the previous route's title next to the iOS back
                // chevron. Without this the back button rendered as
                // "< Naršyti" on Nuolaidos and other pushed screens.
                // Keep the NATIVE back button — overriding it via a
                // custom headerLeft in a nested stack causes expo-
                // router to mount the screen twice on iOS, creating a
                // phantom duplicate Naršyti above the real one.
                headerBackTitle: '',
                headerBackButtonDisplayMode: 'minimal',
            }}
        >
            <Stack.Screen name="index" options={{ headerShown: false }} />
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