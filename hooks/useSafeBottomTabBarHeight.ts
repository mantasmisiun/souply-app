import { useContext } from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets, initialWindowMetrics } from 'react-native-safe-area-context';
import { BottomTabBarHeightContext } from '@react-navigation/bottom-tabs';

// Standard UITabBar item height — used ONLY to seed the first-render estimate
// below, never as the live value.
const IOS_TAB_BAR_ITEM_HEIGHT = 49;

// Survives across mounts/tab-switches (module stays loaded). expo-router ships
// its SafeAreaProvider with NO initialMetrics on native, and the native tab
// bar's inset doesn't propagate into safe-area-context until a layout pass — on
// first launch that doesn't happen until the user switches tabs. So on the very
// first render useSafeAreaInsets().bottom is 0. Seed the cache with a sane
// estimate (synchronous window home-indicator inset + standard bar height) so
// the first frame already CLEARS the bar instead of letting it cover the last
// row; it then converges to the exact inset the moment that resolves.
let cachedIosBottom = (initialWindowMetrics?.insets.bottom ?? 0) + IOS_TAB_BAR_ITEM_HEIGHT;

/**
 * Bottom clearance for content sitting under the tab bar, correct under either:
 *   - `@react-navigation/bottom-tabs` (Android JS Tabs) → exact height from context
 *   - `expo-router/unstable-native-tabs` (iOS NativeTabs) → the bottom safe-area
 *     inset, which is ALREADY the full clearance.
 *
 * Why no "+ 49" on iOS: NativeTabs renders a native `UITabBarController`
 * (react-native-screens `RNSTabBarController`). UIKit folds the tab bar into
 * each child view-controller's `safeAreaInsets.bottom`, so `insets.bottom` here
 * already equals bar height + home indicator. Adding a hard-coded 49 on top
 * double-counted it — the source of the phantom gap, made worse on iOS 26 where
 * the glass bar isn't 49pt anyway. Reading the real inset means it's exact on
 * every device and OS version, no magic numbers.
 *
 * `useBottomTabBarHeight()` from @react-navigation throws outside a JS Bottom
 * Tab Navigator (crashing NativeTabs screens), so we read the context directly
 * and get `undefined` instead.
 */
export function useSafeBottomTabBarHeight(): number {
    const contextHeight = useContext(BottomTabBarHeightContext);
    const insets = useSafeAreaInsets();
    if (contextHeight != null) return contextHeight;
    if (Platform.OS === 'ios') {
        if (insets.bottom > 0) cachedIosBottom = insets.bottom;
        return cachedIosBottom;
    }
    return 0;
}
