import { useRouter } from 'expo-router';
import { GlassIconButton } from './GlassIconButton';

/**
 * Standard header back button used on screens where the native iOS 26
 * liquid-glass back button is unresponsive. Drop it into headerLeft via
 * `headerLeft: () => <ScreenBackButton />`.
 */
export function ScreenBackButton({ color }: { color?: string } = {}) {
    const router = useRouter();
    return (
        <GlassIconButton
            icon="chevron-back"
            onPress={() => router.canGoBack() && router.back()}
            size={24}
            color={color}
        />
    );
}
