import { useContext } from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets, initialWindowMetrics } from 'react-native-safe-area-context';
import { BottomTabBarHeightContext } from '@react-navigation/bottom-tabs';
import { FLOATING_TAB_BAR_CLEARANCE } from '../components/FloatingPillTabBar';

// Standard UITabBar item height on iOS. The full clearance is this + the
// home-indicator inset (49 + 34 = 83).
//
// CRITICAL: we add it to the home-indicator inset from `initialWindowMetrics`
// (captured ONCE at startup), NOT the live `useSafeAreaInsets().bottom`. Under
// RNS NativeTabs the live bottom inset is unstable — it toggles between 34 (bar
// excluded) and 83 (bar folded in) across re-layouts and tab revisits. Adding a
// constant 49 to a value that already includes the bar double-counts to 132, so
// the gap visibly grew every time you switched back to the tab. The startup
// home-indicator value never toggles, so this stays a rock-steady 83.
const IOS_TAB_BAR_ITEM_HEIGHT = 49;

/**
 * Bottom clearance for content / FABs sitting under the tab bar, correct under:
 *   - `@react-navigation/bottom-tabs` (Android JS Tabs) → exact height from context
 *   - `expo-router/unstable-native-tabs` (iOS NativeTabs) → standard bar item
 *     height + the stable startup home-indicator inset (see note above)
 *
 * `useBottomTabBarHeight()` from @react-navigation throws outside a JS Bottom
 * Tab Navigator (crashing NativeTabs screens), so we read the context directly
 * and get `undefined` instead.
 */
export function useSafeBottomTabBarHeight(): number {
    const contextHeight = useContext(BottomTabBarHeightContext);
    const insets = useSafeAreaInsets();
    // Android uses the floating pill bar (FloatingPillTabBar), which is
    // absolutely positioned and reserves no layout space — so the measured
    // context height is unreliable. Return its known clearance + the (stable)
    // Android gesture inset instead.
    if (Platform.OS === 'android') return FLOATING_TAB_BAR_CLEARANCE + insets.bottom;
    if (contextHeight != null) return contextHeight;
    if (Platform.OS === 'ios') {
        // Prefer the stable startup inset; only fall back to the live inset if
        // initial metrics were unavailable (rare; mostly non-iOS).
        const homeInset = initialWindowMetrics?.insets.bottom ?? insets.bottom;
        return IOS_TAB_BAR_ITEM_HEIGHT + homeInset;
    }
    return 0;
}
