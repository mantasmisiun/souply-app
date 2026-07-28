import { createRef, type RefObject } from 'react';
import type { View } from 'react-native';

/**
 * Per-tab BlurTargetView refs — the Android real-blur wiring for the floating
 * tab dock (SDK 57 / expo-blur 57, Dimezis BlurView 3.x RenderNode path).
 *
 * Dimezis' structural rule is that a BlurTarget may not contain the BlurView
 * that targets it. The dock (DockedGlassSheet, rendered as the Tabs navigator's
 * tabBar) is an absolute overlay ABOVE the screens — a sibling, outside every
 * screen subtree — so each tab folder's nested Stack can be wrapped in a
 * BlurTargetView and the dock blurs whichever one is focused.
 *
 * ONE stable ref per tab, created at module scope: each tab layout mounts a
 * single instance, and swapping WHICH ref the dock's BlurView receives is what
 * makes expo-blur re-resolve the target (its componentDidUpdate compares
 * `blurTarget.current` across renders — distinct ref objects per tab guarantee
 * the comparison fires exactly on tab switch). The tab bar re-renders on every
 * focus change, so the swap rides the same commit as the switch; screens render
 * BEFORE the tabBar inside BottomTabView, so the newly focused tab's target ref
 * is attached before the BlurView updates.
 *
 * iOS never mounts the BlurTargetViews (the wrap is Android-only) and GlassFill
 * ignores the ref there — refs simply stay null.
 */
export const tabBlurTargets = {
    catalog: createRef<View | null>(),
    basket: createRef<View | null>(),
    templates: createRef<View | null>(),
    menu: createRef<View | null>(),
} as const;

/** The blur-target ref for a tab route name (undefined for unknown routes —
 *  the dock then just keeps its tint fallback). */
export function tabBlurTargetFor(name: string): RefObject<View | null> | undefined {
    return (tabBlurTargets as Record<string, RefObject<View | null> | undefined>)[name];
}
