import { requireNativeViewManager } from 'expo-modules-core';
import {
  ActivityIndicator,
  Platform,
  processColor,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

type Size = number | 'small' | 'large';

interface Props {
  color?: string;
  /** Like ActivityIndicator: 'small' | 'large' | a dp number. */
  size?: Size;
  style?: StyleProp<ViewStyle>;
}

type NativeProps = { color?: number | null; size?: number; style?: StyleProp<ViewStyle> };

// Android only — the native Material You CircularProgressIndicator (registered by
// the local `souply-progress` Expo module). null on every other platform so we
// never touch a native view that doesn't exist there.
const NativeProgress =
  Platform.OS === 'android'
    ? requireNativeViewManager<NativeProps>('SouplyProgress')
    : null;

const toDp = (s: Size): number => (typeof s === 'number' ? s : s === 'large' ? 40 : 20);

/**
 * Drop-in replacement for `<ActivityIndicator>`:
 *   • Android → the stock Material You CircularProgressIndicator (native).
 *   • iOS / anything else → the platform `ActivityIndicator`.
 * Accepts the same `size` ('small' | 'large' | number) so it swaps in 1:1.
 */
export function MaterialProgress({ color, size = 'small', style }: Props) {
  if (NativeProgress) {
    const d = Math.max(16, toDp(size)); // Material needs a sane minimum diameter
    return (
      <NativeProgress
        color={color ? (processColor(color) as number) : undefined}
        size={d}
        style={[{ width: d, height: d }, style]}
      />
    );
  }
  // iOS / fallback — ActivityIndicator accepts 'small' | 'large' | number directly.
  return <ActivityIndicator size={size} color={color} style={style} />;
}
