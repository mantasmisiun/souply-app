import { Platform, Dimensions } from 'react-native';
import { radius } from '../constants/theme';

/**
 * The device DISPLAY's physical corner radius (pt) — for Find-My-style
 * CONCENTRIC rounding: an element floating `inset` away from the screen edges
 * looks native when its corner radius is the display's radius minus that inset,
 * so both curves share a centre.
 *
 * iOS keeps the real value private (`UIScreen._displayCornerRadius`), so this is
 * the standard heuristic: home-indicator iPhones are 47.33pt (X→14 non-Pro) or
 * 55pt (14 Pro and later — taller logical screens); home-BUTTON devices and
 * Android (radii vary wildly per OEM) fall back to the app's own token, which
 * simply looks like our normal rounding rather than pretending to know.
 */
export function displayCornerRadius(bottomInset: number): number {
    if (Platform.OS !== 'ios' || bottomInset <= 0) return radius.xl;
    const { width, height } = Dimensions.get('window');
    return Math.max(width, height) >= 850 ? 55 : 47.33;
}

/** Corner radius for a surface floating `inset` pt inside the screen edges,
 *  concentric with the display's own corners (floored to stay visibly round). */
export function concentricRadius(bottomInset: number, inset: number): number {
    return Math.max(radius.lg, displayCornerRadius(bottomInset) - inset);
}
