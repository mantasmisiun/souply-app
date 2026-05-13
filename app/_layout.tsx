import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';
import { useEffect } from 'react';
import { Linking, View } from 'react-native';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import * as FileSystem from 'expo-file-system/legacy';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '../constants/theme';
import { DisplayPreferenceProvider } from '../contexts/DisplayPreferenceContext';
import { OfflineBanner } from '../components/OfflineBanner';
import { LevelUpModal } from '../components/LevelUpModal';
import { useBindNetInfo } from '../state/networkStatus';
import { API_BASE_URL } from '../config/api';
import { useReceiptQueueRunner } from '../hooks/useReceiptQueueRunner';

/**
 * Copy a content:// or file:// URI into the app cache and return the
 * resulting file:// path.
 */
async function normalizeToLocalUri(uri: string, ext = '.tmp'): Promise<string> {
  const dest = `${FileSystem.cacheDirectory}share_input_${Date.now()}${ext}`;
  await FileSystem.copyAsync({ from: uri, to: dest });
  return dest;
}

/**
 * Convert a PDF file:// path to PNG temp files via the server's
 * /api/receipts/pdf-to-image endpoint. Returns file:// URIs for each page.
 */
async function pdfToImageUris(pdfPath: string): Promise<string[]> {
  const localPath = await normalizeToLocalUri(pdfPath, '.pdf');
  const base64 = await FileSystem.readAsStringAsync(localPath, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const res = await fetch(`${API_BASE_URL}/api/receipts/pdf-to-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pdfBase64: base64 }),
  });
  if (!res.ok) throw new Error(`pdf-to-image ${res.status}`);
  const { images } = await res.json() as { images: string[] };
  const uris: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const dest = `${FileSystem.cacheDirectory}share_pdf_page_${Date.now()}_${i}.png`;
    await FileSystem.writeAsStringAsync(dest, images[i], {
      encoding: FileSystem.EncodingType.Base64,
    });
    uris.push(dest);
  }
  return uris;
}

/**
 * Handles files arriving from two iOS entry points and one Android entry point:
 *   1. Share Extension (share sheet) — caught by useShareIntentContext
 *   2. Document Types / Open In — caught by Linking file:// URL events
 *   3. Android ACTION_SEND intent — also caught by useShareIntentContext
 * PDFs are converted to PNG pages via the server before navigating.
 */
function ShareHandler() {
  const router = useRouter();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();

  const navigateWithFiles = async (files: { path: string; mimeType: string }[]) => {
    try {
      const allUris: string[] = [];
      for (const file of files) {
        const isPdf = file.mimeType === 'application/pdf' ||
          file.path.toLowerCase().endsWith('.pdf');
        if (isPdf) {
          const pages = await pdfToImageUris(file.path);
          allUris.push(...pages);
        } else {
          allUris.push(await normalizeToLocalUri(file.path, '.jpg'));
        }
      }
      if (allUris.length === 0) return;
      const params = allUris.length === 1
        ? { uri: allUris[0] }
        : { uris: allUris.map(encodeURIComponent).join(',') };
      router.push({ pathname: '/receipt-process', params } as any);
    } catch (e) {
      console.error('[ShareHandler] failed to process shared file:', e);
    }
  };

  // Share Extension / Android intent
  useEffect(() => {
    if (!hasShareIntent || !shareIntent) return;
    const files = shareIntent.files ?? [];
    if (files.length === 0) { resetShareIntent(); return; }
    navigateWithFiles(files.map(f => ({ path: f.path, mimeType: f.mimeType ?? '' })));
    resetShareIntent();
  }, [hasShareIntent]);

  // Document Types / Open In — file:// URL delivered via Linking
  useEffect(() => {
    const handle = (url: string | null) => {
      if (!url?.startsWith('file://')) return;
      const mimeType = url.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg';
      navigateWithFiles([{ path: url, mimeType }]);
    };
    Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener('url', e => handle(e.url));
    return () => sub.remove();
  }, []);

  return null;
}

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const colors = useTheme();
  // Subscribe to NetInfo once, at the top of the tree. Downstream
  // consumers read via `useNetworkStatus(s => s.isOnline)`.
  useBindNetInfo();
  useReceiptQueueRunner();

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
    <ShareIntentProvider>
    <DisplayPreferenceProvider>
    <ThemeProvider value={navTheme}>
      <View style={{ flex: 1, backgroundColor: colors.pageBackground }}>
      <ShareHandler />
      <OfflineBanner />
      <LevelUpModal />
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
        {/* basket/results/[id] intentionally configures its own <Stack.Screen>
            options from inside the screen — registering a default here
            (title: 'Rezultatai' or a stub headerRight) would win on
            initial-mount timing and leave the refresh button missing
            until the child's options apply. File-based routing picks the
            screen up without this entry. */}
        <Stack.Screen name="shopping-list/[id]" options={{ title: 'Pirkinių sąrašas' }} />
        <Stack.Screen name="receipt/capture" options={{ headerShown: false }} />
        <Stack.Screen name="receipt-process" options={{ title: 'Kvito peržiūra' }} />
        <Stack.Screen name="profile/vote-history" options={{ title: 'Balsavimų istorija' }} />
      </Stack>
      <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
      </View>
    </ThemeProvider>
    </DisplayPreferenceProvider>
    </ShareIntentProvider>
  );
}
