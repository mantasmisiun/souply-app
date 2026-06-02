import { Stack } from 'expo-router';
import { useTheme } from '../../constants/theme';

export default function ProductLayout() {
    const colors = useTheme();
    return (
        <Stack
            screenOptions={{
                // Match the app-wide nav: pink back chevron, dark left-aligned
                // title, no back-title clutter.
                headerTintColor: colors.primary,
                headerTitleStyle: { color: colors.textPrimary },
                headerTitleAlign: 'left',
                headerShadowVisible: false,
                headerBackTitle: '',
                headerBackButtonDisplayMode: 'minimal',
            }}
        />
    );
}
