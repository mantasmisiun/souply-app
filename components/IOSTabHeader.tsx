import { Platform, View, Text, StyleSheet, type ViewStyle, type StyleProp } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../constants/theme';
import type { ReactNode } from 'react';

interface Props {
    title: string;
    rightAction?: ReactNode;
    style?: StyleProp<ViewStyle>;
}

/**
 * iOS-only large-title header for tabs hosted by `NativeTabs`. NativeTabs
 * renders no UINavigationController, so each tab screen is otherwise
 * missing the nav bar that iOS users expect (title + right actions). On
 * Android the JS Tabs navigator provides its own header — this component
 * returns null there.
 */
export function IOSTabHeader({ title, rightAction, style }: Props) {
    const colors = useTheme();
    const insets = useSafeAreaInsets();
    if (Platform.OS !== 'ios') return null;
    return (
        <View
            style={[
                {
                    paddingTop: insets.top,
                    height: insets.top + 44,
                    paddingHorizontal: 16,
                    backgroundColor: colors.pageBackground,
                    justifyContent: 'center',
                },
                style,
            ]}
        >
            <Text
                style={{
                    fontSize: 17,
                    fontWeight: '600',
                    color: colors.textPrimary,
                    textAlign: 'center',
                }}
                numberOfLines={1}
            >
                {title}
            </Text>
            {rightAction ? <View style={styles.rightSlot}>{rightAction}</View> : null}
        </View>
    );
}

const styles = StyleSheet.create({
    rightSlot: { position: 'absolute', right: 16, bottom: 8 },
});
