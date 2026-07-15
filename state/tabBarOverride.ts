import { create } from "zustand";
import type { Ionicons } from "@expo/vector-icons";

/**
 * Tab-bar override — lets a screen temporarily MORPH the Android floating
 * pill tab bar (components/FloatingPillTabBar) into a contextual action bar
 * (e.g. the shopping-list multi-select: complete / delete / cancel) instead
 * of floating a second bar behind it.
 *
 * While an override is set the tabs are not reachable — deliberate: the
 * selection flow owns the bar until it's dismissed (cancel item, an action,
 * or the screen's back handler). The OWNING SCREEN is responsible for
 * clearing the override on unmount/blur, or the tabs would stay hijacked.
 *
 * iOS uses native tabs (can't be re-rendered from JS) — screens keep their
 * inline overlay bar there; this store is only consumed by the JS pill bar.
 */
export interface TabBarOverrideAction {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  /** Destructive red tint (delete). */
  destructive?: boolean;
}

interface TabBarOverrideState {
  actions: TabBarOverrideAction[] | null;
  setOverride: (actions: TabBarOverrideAction[]) => void;
  clearOverride: () => void;
}

export const useTabBarOverride = create<TabBarOverrideState>((set) => ({
  actions: null,
  setOverride: (actions) => set({ actions }),
  clearOverride: () => set({ actions: null }),
}));
