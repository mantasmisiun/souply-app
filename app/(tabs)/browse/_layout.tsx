import { Stack, useRouter } from 'expo-router';
import { useTheme } from '../../../constants/theme';
import { GlassIconButton } from '../../../components/GlassIconButton';

export default function BrowseLayout() {
    const router = useRouter();
    const colors = useTheme();

    // Both L1 (index) and L2 ([categoryId]) get the same magnifying-
    // glass icon in the right side of the nav bar — tap pushes the
    // dedicated /search screen with the products mode preselected.
    // Single shared definition so the two screens stay in sync if
    // the destination route or params ever change.
    const searchHeaderRight = () => (
        <GlassIconButton
            icon="search"
            onPress={() =>
                router.push({
                    pathname: '/search',
                    params: { mode: 'products', source: 'browse' },
                })
            }
        />
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
            <Stack.Screen
                name="index"
                options={{
                    // index renders its own IOSTabHeader so all five tabs
                    // share the same custom top bar. [categoryId] keeps
                    // the native Stack header to get the back chevron.
                    headerShown: false,
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