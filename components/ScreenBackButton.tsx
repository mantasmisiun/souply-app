import { useRouter } from 'expo-router';
import { GlassIconButton } from './GlassIconButton';

/**
 * Standard header back button used on screens where the native iOS 26
 * liquid-glass back button is unresponsive. Drop it into headerLeft via
 * `headerLeft: () => <ScreenBackButton />`.
 *
 * Pass `onPress` to override the default pop — e.g. a screen that hosts an
 * in-place phase (the swipe queue inside receipt-process) must run its own
 * exit continuation instead of popping the whole host screen.
 */
export function ScreenBackButton({ color, onPress }: { color?: string; onPress?: () => void } = {}) {
    const router = useRouter();
    return (
        <GlassIconButton
            icon="chevron-back"
            onPress={onPress ?? (() => router.canGoBack() && router.back())}
            size={24}
            color={color}
        />
    );
}
