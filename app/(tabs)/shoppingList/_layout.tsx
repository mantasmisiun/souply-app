import { Stack } from 'expo-router';
import { useTheme } from '../../../constants/theme';
import { tabStackOptions } from '../../../constants/navHeader';

export default function ShoppingListLayout() {
    const colors = useTheme();
    return <Stack screenOptions={tabStackOptions(colors)} />;
}
