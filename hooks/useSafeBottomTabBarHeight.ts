import { useContext } from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets, initialWindowMetrics } from 'react-native-safe-area-context';
// SDK 57: expo-router forked react-navigation — the context the JS Tabs bar
// actually provides is the fork's, so it MUST be imported from expo-router/js-tabs
// (the standalone package's context would be a different React context instance).
import { BottomTabBarHeightContext } from 'expo-router/js-tabs';
import { FLOATING_TAB_BAR_CLEARANCE } from '../components/FloatingPillTabBar';
import { useBasketSession } from '../state/basketSession';

// Visual gap kept between a screen's last item and the top of the floating bar
// (covers the grabber-peek strip + a breathing gap), so padding = published
// collapsed-clearance + this. A constant gap keeps the distance consistent
// whether the tab bar or the taller session bar is showing.
const BAR_TOP_GAP = 24;

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
    // Whichever floating dock is the visible bottom bar publishes its collapsed
    // clearance: the session bar (taller) wins when a session is live, else the
    // tab bar. Both values already fold in insets.bottom.
    const tabBarClearance = useBasketSession(s => s.tabBarClearance);
    const sessionBarClearance = useBasketSession(s => s.sessionBarClearance);
    const floatingClearance = sessionBarClearance ?? (tabBarClearance || 0);

    // Android uses the floating pill bar (FloatingPillTabBar), which is
    // absolutely positioned and reserves no layout space — so the measured
    // context height is unreliable. Pad by the ACTUAL published dock clearance
    // (falls back to the constant estimate until the dock reports).
    if (Platform.OS === 'android') {
        const base = floatingClearance > 0 ? floatingClearance : FLOATING_TAB_BAR_CLEARANCE + insets.bottom;
        return base + BAR_TOP_GAP;
    }
    // iOS: the native tab bar height — but if the (floating) session bar is
    // live, clear whichever is taller.
    let base: number;
    if (contextHeight != null) base = contextHeight;
    else if (Platform.OS === 'ios') {
        // Prefer the stable startup inset; only fall back to the live inset if
        // initial metrics were unavailable (rare; mostly non-iOS).
        const homeInset = initialWindowMetrics?.insets.bottom ?? insets.bottom;
        base = IOS_TAB_BAR_ITEM_HEIGHT + homeInset;
    } else base = 0;
    if (sessionBarClearance != null) return Math.max(base, sessionBarClearance + BAR_TOP_GAP);
    return base;
}
