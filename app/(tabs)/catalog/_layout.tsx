import { Stack } from 'expo-router';
import { useTheme } from '@/constants/theme';
import { tabStackOptions } from '@/constants/navHeader';

/**
 * Catalog tab navigator. The whole catalog TREE lives inside this nested Stack
 * — index (categories), L2 (browse/[categoryId]), discounts, product/[id] and
 * the catalog search — so the tab bar STAYS VISIBLE as you browse deeper
 * (SwiftUI's NativeTabs only auto-hides the bar for screens pushed at the app
 * root; pushes inside a tab's nested stack keep it). This is what lets the
 * basket-session dock sit over the tab bar across the whole flow and reappear
 * when dismissed.
 *
 * These screens render NO native bar — CollapsingHeader draws its own floating
 * chrome (back chip / actions) over a gradient fade. headerShown is false
 * per-route here as FIRST-FRAME polish so no bar flashes before the screen's
 * own <Stack.Screen options={{ headerShown: false }}/> lands. (Never in global
 * screenOptions — that triggered the iOS phantom-mount bug.)
 */
export default function CatalogLayout() {
    const colors = useTheme();
    return (
        // Explicit slide animation: the default Android fade-through push kept
        // STICKING mid-transition on re-pushes of these barless screens (screen
        // stuck at partial/zero alpha — "washed" or "empty" pages, with the row
        // content still ghosting through the tab-bar blur, which redraws the
        // hierarchy in software). A translation-based push avoids the alpha
        // animator entirely.
        <Stack screenOptions={{ ...tabStackOptions(colors), animation: 'slide_from_right' }}>
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="discounts" options={{ headerShown: false }} />
            <Stack.Screen name="browse/[categoryId]" options={{ headerShown: false }} />
            <Stack.Screen name="product/[id]" options={{ headerShown: false }} />
            <Stack.Screen name="search" options={{ headerShown: false }} />
        </Stack>
    );
}
