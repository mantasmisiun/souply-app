import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '../constants/theme';
import { DisplayPreferenceProvider } from '../contexts/DisplayPreferenceContext';

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const colors = useTheme();

  // Derive React Navigation's theme from our app theme so every default
  // surface (headers, cards, borders) picks up the palette automatically.
  const navTheme = {
    ...(colorScheme === 'dark' ? DarkTheme : DefaultTheme),
    colors: {
      ...(colorScheme === 'dark' ? DarkTheme : DefaultTheme).colors,
      background: colors.pageBackground,
      card: colors.pageBackground,
      text: colors.textPrimary,
      border: colors.border,
      primary: colors.primary,
      notification: colors.primary,
    },
  };

  return (
    <DisplayPreferenceProvider>
    <ThemeProvider value={navTheme}>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.pageBackground },
          headerTintColor: colors.textPrimary,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.pageBackground },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
        <Stack.Screen name="product" options={{ headerShown: false }} />
        <Stack.Screen name="basket/[id]" options={{ title: 'Krepšelis' }} />
        <Stack.Screen name="basket/results/[id]" options={{ title: 'Rezultatai' }} />
        <Stack.Screen name="basket/results/store" options={{ title: 'Parduotuvė' }} />
        <Stack.Screen name="shopping-list/[id]" options={{ title: 'Pirkinių sąrašas' }} />
        <Stack.Screen name="receipt/capture" options={{ headerShown: false }} />
        <Stack.Screen name="receipt-process" options={{ title: 'Kvito peržiūra' }} />
      </Stack>
      <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
    </ThemeProvider>
    </DisplayPreferenceProvider>
  );
}
