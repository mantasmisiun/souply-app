import { useContext } from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomTabBarHeightContext } from '@react-navigation/bottom-tabs';

// Standard UITabBar item height on iOS. The total visible bar height is
// this + bottom safe-area inset (49 + 34 = 83pt on iPhone X+).
const IOS_TAB_BAR_ITEM_HEIGHT = 49;

/**
 * Returns the bottom tab bar height under either:
 *   - `@react-navigation/bottom-tabs` (Android JS Tabs) — read from context
 *   - `expo-router/unstable-native-tabs` (iOS NativeTabs) — computed from
 *     the standard UITabBar height + safe-area bottom inset
 *
 * `useBottomTabBarHeight` from @react-navigation/bottom-tabs throws when
 * called outside a Bottom Tab Navigator, which crashes screens hosted by
 * NativeTabs. Read the context directly so it returns `null` instead.
 */
export function useSafeBottomTabBarHeight(): number {
    const contextHeight = useContext(BottomTabBarHeightContext);
    const insets = useSafeAreaInsets();
    if (contextHeight != null) return contextHeight;
    if (Platform.OS === 'ios') return IOS_TAB_BAR_ITEM_HEIGHT + insets.bottom;
    return 0;
}
