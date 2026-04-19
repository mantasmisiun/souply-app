import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';

import { useColorScheme } from '@/hooks/use-color-scheme';

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
        <Stack.Screen name="product" options={{ headerShown: false }} />
        <Stack.Screen name="basket/[id]" options={{ title: 'Krepšelis' }} />
        <Stack.Screen name="basket/results/[id]" options={{ title: 'Rezultatai' }} />
        <Stack.Screen name="basket/results/store" options={{ title: 'Parduotuvė' }} />
        <Stack.Screen name="shopping-list/[id]" options={{ title: 'Pirkinių sąrašas' }} />
        <Stack.Screen name="receipt/capture" options={{ headerShown: false }} />
        <Stack.Screen name="receipt-process" options={{ title: 'Kvito peržiūra' }} />
        <Stack.Screen name="receipt/[id]" options={{ title: 'Kvitas' }} />
      </Stack>
      <StatusBar style="auto" />
    </ThemeProvider>
  );
}