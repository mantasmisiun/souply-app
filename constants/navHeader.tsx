import type { ReactNode } from 'react';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import type { AppTheme } from './theme';
import { ScreenBackButton } from '../components/ScreenBackButton';

/**
 * Single source of truth for the app's top navigation bars.
 *
 * Every top bar is a native (iOS 26 liquid-glass) bar that carries ONLY the
 * glass back chevron and glass actions — never a title. The title (and any
 * subtitle/breadcrumb) is rendered left-aligned in the screen body via
 * <ScreenHeading/>. This is the only way to get an always-left, glass-free
 * title on iOS: react-native-screens centres bar titles and (on 4.16) can't
 * strip the iOS-26 glass capsule off a custom left-bar title.
 *
 * Screens pull their `Stack` screenOptions from `tabStackOptions` and their
 * per-screen bar from `glassHeaderOptions`, then render `<ScreenHeading/>` at
 * the top of their content. No screen hand-rolls header config.
 */

/** Shared `<Stack>` screenOptions for every tab's nested navigator. */
export const tabStackOptions = (colors: AppTheme): NativeStackNavigationOptions => ({
    headerStyle: { backgroundColor: colors.cardBackground },
    headerTintColor: colors.primary,
    headerTitleStyle: { color: colors.textPrimary },
    headerShadowVisible: false,
    contentStyle: { backgroundColor: colors.pageBackground },
    headerBackTitle: '',
    headerBackButtonDisplayMode: 'minimal',
});

/**
 * Per-screen native bar: titleless, with an optional glass back chevron and an
 * optional right-side action. Pair with a <ScreenHeading/> in the body for the
 * actual (left-aligned) title.
 *
 * THE RULE: a bar with no back button AND no action is empty — so it's hidden
 * entirely (`headerShown: false`) and <CollapsingHeader/> takes the status-bar
 * inset instead, reclaiming the otherwise-empty bar height.
 */
export const glassHeaderOptions = (
    opts: { back?: boolean; right?: ReactNode; background?: string } = {},
): NativeStackNavigationOptions => {
    if (!opts.back && !opts.right) {
        return { headerShown: false };
    }
    return {
        headerShown: true,
        // No bar title — it would render centred (and route-name fallback shows
        // "product/[id]"). The title lives in <ScreenHeading/>.
        title: '',
        headerTitle: () => null,
        headerShadowVisible: false,
        ...(opts.background ? { headerStyle: { backgroundColor: opts.background } } : {}),
        ...(opts.back ? { headerLeft: () => <ScreenBackButton /> } : {}),
        ...(opts.right ? { headerRight: () => opts.right } : {}),
    };
};
