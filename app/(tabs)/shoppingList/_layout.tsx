import { Stack } from 'expo-router';
import { useTheme } from '../../../constants/theme';

export default function ShoppingListLayout() {
    const colors = useTheme();
    return (
        <Stack
            screenOptions={{
                headerStyle: { backgroundColor: colors.cardBackground },
                headerTintColor: colors.textPrimary,
                headerShadowVisible: false,
                contentStyle: { backgroundColor: colors.pageBackground },
            }}
        />
    );
}
