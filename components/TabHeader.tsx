import { View, Text, StyleSheet, type ViewStyle, type StyleProp } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../constants/theme';
import type { ReactNode } from 'react';

interface Props {
    title: string;
    rightAction?: ReactNode;
    style?: StyleProp<ViewStyle>;
}

/**
 * Cross-platform tab top bar. NativeTabs on iOS and JS Tabs on Android
 * both leave the per-tab header up to the screen, so we render a single
 * 44pt-tall (+ safe-area) bar with a centered 17pt semibold title and an
 * optional right-side action. Used by all five tab screens to keep the
 * top of every tab visually identical.
 */
export function TabHeader({ title, rightAction, style }: Props) {
    const colors = useTheme();
    const insets = useSafeAreaInsets();
    return (
        <View
            style={[
                {
                    paddingTop: insets.top,
                    height: insets.top + 44,
                    paddingHorizontal: 16,
                    backgroundColor: colors.cardBackground,
                    justifyContent: 'center',
                    zIndex: 1,
                    elevation: 0,
                },
                style,
            ]}
        >
            <Text
                style={{
                    fontSize: 17,
                    fontWeight: '600',
                    color: colors.textPrimary,
                    textAlign: 'left',
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
