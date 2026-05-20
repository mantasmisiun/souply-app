import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';
import { useEffect } from 'react';
import { Linking, View } from 'react-native';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import * as FileSystem from 'expo-file-system/legacy';

import { useTheme, useResolvedScheme } from '../constants/theme';
import { GlassIconButton } from '../components/GlassIconButton';
import { DisplayPreferenceProvider } from '../contexts/DisplayPreferenceContext';
import { OfflineBanner } from '../components/OfflineBanner';
import { DevUpdateBanner } from '../components/DevUpdateBanner';
import { LevelUpModal } from '../components/LevelUpModal';
import { useBindNetInfo } from '../state/networkStatus';
import { useSettingsStore } from '../state/settingsStore';
import { API_BASE_URL } from '../config/api';
import { useReceiptQueueRunner } from '../hooks/useReceiptQueueRunner';
import '../i18n';
import { useTranslation } from 'react-i18next';
import { installFetchInterceptor } from '../utils/installFetchInterceptor';
import { installCrashReporter } from '../utils/installCrashReporter';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Install the global fetch shim once at module load so every API call
// — including those that bypass `fetchWithTimeout` — sends the right
// Accept-Language header. Safe to import here at the top: the
// interceptor is idempotent and reads i18n.language lazily at call
// time, so swapping languages mid-session works without re-installing.
installFetchInterceptor();
// Catch any uncaught JS error and ship it to /api/dev-log so we can
// diagnose iOS crashes without Xcode. Idempotent.
installCrashReporter();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 60 * 1000,
      gcTime: 24 * 60 * 60 * 1000,
      retry: 3,
      retryDelay: attempt => Math.min(1000 * 2 ** attempt, 30_000),
      refetchOnWindowFocus: false,
    },
  },
});

const queryPersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: 'souply-query-cache-v1',
  throttleTime: 1000,
});

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
  const colorScheme = useResolvedScheme();
  const colors = useTheme();
  const { t } = useTranslation();
  // Subscribe to NetInfo once, at the top of the tree. Downstream
  // consumers read via `useNetworkStatus(s => s.isOnline)`.
  useBindNetInfo();
  useReceiptQueueRunner();

  // Hydrate the user-settings store once at app boot — pulls the
  // persisted language choice (or detects device locale on first launch)
  // and syncs it into i18next. Subsequent renders see the right
  // translations because i18next emits `languageChanged` and
  // useTranslation re-renders consumers.
  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  useEffect(() => {
    hydrateSettings().catch((e) => console.warn('[settings] hydrate failed', e));
  }, [hydrateSettings]);

  // Hydrate admin-mode flag and, if the user last left the app in admin
  // mode, route into the admin section immediately. Cheap — the store
  // reads one AsyncStorage key. No-op when the user has never been an
  // admin on this device.
  const router = useRouter();
  useEffect(() => {
    (async () => {
      const { useAdminModeStore } = await import('../state/adminModeStore');
      await useAdminModeStore.getState().hydrate();
      if (useAdminModeStore.getState().mode === 'admin') {
        router.replace('/(admin)/flags' as any);
      }
    })().catch((e) => console.warn('[adminMode] hydrate failed', e));
    // Intentionally one-shot — once on boot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister: queryPersister,
        maxAge: 24 * 60 * 60 * 1000,
        buster: 'v1',
      }}
    >
    <ShareIntentProvider>
    <DisplayPreferenceProvider>
    <ThemeProvider value={navTheme}>
      <View style={{ flex: 1, backgroundColor: colors.pageBackground }}>
      <ShareHandler />
      <DevUpdateBanner />
      <OfflineBanner />
      <LevelUpModal />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.pageBackground },
          headerTintColor: colors.textPrimary,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.pageBackground },
          // Hide the previous route's title next to the iOS back
          // chevron. Without this the back button rendered as
          // "< (tabs)" on every screen pushed from the tab group
          // because (tabs) is a route group with no display title —
          // iOS falls back to the literal route name. Keep the
          // NATIVE back button — overriding it via a custom
          // headerLeft caused expo-router to mount duplicate
          // screens on iOS (a phantom view above the real one).
          headerBackTitle: '',
          headerBackButtonDisplayMode: 'minimal',
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="(admin)" options={{ headerShown: false }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
        <Stack.Screen name="product" options={{ headerShown: false }} />
        {/* discounts + browse/[categoryId] live at the root so the iOS
            NativeTabs tab bar hides on push (it stays visible when a
            screen is inside a tab's nested stack). Each screen sets its
            own <Stack.Screen options/> inline. */}
        <Stack.Screen name="discounts" />
        <Stack.Screen name="browse/[categoryId]" />
        <Stack.Screen name="basket/[id]" options={{ title: t('screens.basket') }} />
        {/* basket/results/[id] intentionally configures its own <Stack.Screen>
            options from inside the screen — registering a default here
            (title: 'Rezultatai' or a stub headerRight) would win on
            initial-mount timing and leave the refresh button missing
            until the child's options apply. File-based routing picks the
            screen up without this entry. */}
        <Stack.Screen name="shopping-list/[id]" options={{ title: t('screens.shoppingList') }} />
        <Stack.Screen name="receipt/capture" options={{ headerShown: false }} />
        <Stack.Screen name="receipt-process" options={{ title: t('screens.receiptProcess') }} />
        <Stack.Screen name="profile/vote-history" options={{ title: t('screens.voteHistory') }} />
        <Stack.Screen
          name="settings"
          options={{
            title: t('settings.title'),
            // Custom back chevron — the iOS 26 native back button in
            // the liquid-glass nav bar is unresponsive on this
            // screen (confirmed: chevron renders, tap does nothing).
            // Setting headerLeft on the specific screen entry (not
            // in global screenOptions) sidesteps the phantom-screen
            // duplicate-mount bug that hit when headerLeft was set
            // globally on the root Stack.
            headerLeft: () => (
              <GlassIconButton
                icon="chevron-back"
                onPress={() => router.canGoBack() && router.back()}
                size={24}
              />
            ),
          }}
        />
        <Stack.Screen name="profile/restore-account" options={{ title: t('restore.title') }} />
        <Stack.Screen
          name="profile/audit-log"
          options={{
            title: t('admin.auditLogTitle'),
            // White header matches the chip strip directly below it,
            // so the top of the screen reads as one continuous surface.
            headerStyle: { backgroundColor: colors.cardBackground },
          }}
        />
      </Stack>
      <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
      </View>
    </ThemeProvider>
    </DisplayPreferenceProvider>
    </ShareIntentProvider>
    </PersistQueryClientProvider>
  );
}
