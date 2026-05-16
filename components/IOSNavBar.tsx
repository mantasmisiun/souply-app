import { BlurView } from 'expo-blur';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../constants/theme';

interface Props {
    title: string;
    /**
     * When true, the bar uses a card-color solid background instead of
     * blur — used by the Receipts tab to match the white chip strip
     * directly below the bar so they read as one continuous surface.
     */
    solid?: boolean;
}

/**
 * In-content nav bar for iOS-only tabs that use NativeTabs (which
 * provides only the tab bar at the bottom — each tab is responsible
 * for its own header). Matches the iOS 26 native large-title-pinned
 * style: 44pt content height with safe-area top padding, centered
 * title, translucent liquid-glass background.
 *
 * Android tab screens use the React Navigation built-in header
 * configured via `Tabs.Screen options` and shouldn't render this.
 */
export function IOSNavBar({ title, solid }: Props) {
    const insets = useSafeAreaInsets();
    const colors = useTheme();
    return (
        <View
            style={{
                paddingTop: insets.top,
                backgroundColor: solid ? colors.cardBackground : 'transparent',
            }}
        >
            {!solid && (
                <BlurView
                    tint="systemChromeMaterial"
                    intensity={80}
                    style={StyleSheet.absoluteFill}
                />
            )}
            <View
                style={{
                    height: 44,
                    paddingHorizontal: 16,
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            >
                <Text
                    numberOfLines={1}
                    style={{
                        fontSize: 17,
                        fontWeight: '600',
                        color: colors.textPrimary,
                    }}
                >
                    {title}
                </Text>
            </View>
        </View>
    );
}
