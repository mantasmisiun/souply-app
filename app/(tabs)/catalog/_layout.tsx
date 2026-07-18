import { Stack } from 'expo-router';
import { useTheme } from '@/constants/theme';
import { tabStackOptions } from '@/constants/navHeader';
import { ScreenBackButton } from '@/components/ScreenBackButton';

/**
 * Catalog tab navigator. The whole catalog TREE lives inside this nested Stack
 * — index (categories), L2 (browse/[categoryId]), discounts, product/[id] and
 * the catalog search — so the tab bar STAYS VISIBLE as you browse deeper
 * (SwiftUI's NativeTabs only auto-hides the bar for screens pushed at the app
 * root; pushes inside a tab's nested stack keep it). This is what lets the
 * basket-session dock sit over the tab bar across the whole flow and reappear
 * when dismissed.
 *
 * Each screen still sets its OWN native bar via <CollapsingHeader/> (glass back
 * chevron, no title). The per-route headerLeft here is only first-frame polish:
 * it paints the pink chevron before the screen mounts, avoiding a native-arrow
 * flash. Registered per-route (never in global screenOptions — that triggered
 * the iOS phantom-mount bug).
 */
export default function CatalogLayout() {
    const colors = useTheme();
    return (
        <Stack screenOptions={tabStackOptions(colors)}>
            <Stack.Screen name="index" />
            <Stack.Screen name="discounts" options={{ headerLeft: () => <ScreenBackButton /> }} />
            <Stack.Screen name="browse/[categoryId]" options={{ headerLeft: () => <ScreenBackButton /> }} />
            <Stack.Screen name="product/[id]" options={{ headerLeft: () => <ScreenBackButton /> }} />
            <Stack.Screen name="search" options={{ headerShown: false }} />
        </Stack>
    );
}
