import { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

/**
 * The dock bar title grows as the sheet opens — `base`px collapsed →
 * `base + grow`px at full (the stage-2/3 title-size increase the main map dock
 * uses). Shared so every dock scales its title identically off the sheet's
 * 0→1 progress shared value.
 */
export function useDockTitleStyle(progress: SharedValue<number>, base = 15, grow = 5) {
    return useAnimatedStyle(() => ({ fontSize: base + grow * progress.value }));
}
