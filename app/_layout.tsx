import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';
import { useEffect } from 'react';
import { InteractionManager, Linking, Platform, View } from 'react-native';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { useTheme, useResolvedScheme } from '../constants/theme';
import { GlassIconButton } from '../components/GlassIconButton';
import { ScreenBackButton } from '../components/ScreenBackButton';
import { DisplayPreferenceProvider } from '../contexts/DisplayPreferenceContext';
import { OfflineBanner } from '../components/OfflineBanner';
import { ReceiptProcessingBanner } from '../components/ReceiptProcessingBanner';
import { EnvBadge } from '../components/EnvBadge';
import { MaskRedactionHost } from '../components/MaskRedactionHost';
import { BasketSessionHost } from '../components/basket/BasketSessionHost';
import { DevUpdateBanner } from '../components/DevUpdateBanner';
import { UsernameGate } from '../components/UsernameGate';
import UpdateGateModal from '../components/UpdateGateModal';
import { useAppUpdates } from '../hooks/useAppUpdates';
import { looksLikePdf, normalizeToLocalUri } from '../utils/pdfToImages';
import { installReanimatedWarnTrace } from '@/utils/reanimatedWarnTrace';
import { LevelUpModal } from '../components/LevelUpModal';
import { useBindNetInfo } from '../state/networkStatus';
import { useSettingsStore } from '../state/settingsStore';
import { useTemplateAddState } from '../state/templateAddState';
import { useReceiptQueueRunner } from '../hooks/useReceiptQueueRunner';
import { usePushNotifications } from '../hooks/usePushNotifications';
import '../i18n';
import { useTranslation } from 'react-i18next';
import { installFetchInterceptor } from '../utils/installFetchInterceptor';
import { installCrashReporter } from '../utils/installCrashReporter';
import { Sentry } from '../config/sentry';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { KeyboardProvider } from 'react-native-keyboard-controller';

// Install the global fetch shim once at module load so every API call
// — including those that bypass `fetchWithTimeout` — sends the right
// Accept-Language header. Safe to import here at the top: the
// interceptor is idempotent and reads i18n.language lazily at call
// time, so swapping languages mid-session works without re-installing.
installFetchInterceptor();
// Catch any uncaught JS error and ship it to /api/dev-log so we can
// diagnose iOS crashes without Xcode. Idempotent.
installCrashReporter();

// DEV: name the component behind Reanimated's "reading .value during render"
// warning (the warning itself doesn't say). No-op in production builds.
installReanimatedWarnTrace();

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

// PDF/page-image helpers moved to utils/pdfToImages.ts — conversion now runs
// as a background stage inside the scan session / receipt queue instead of
// blocking here before navigation.

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

  /** Push a route AFTER the first layout settles. iOS ONLY quirk: a share-
   *  extension launch pushes /receipt-process while the NATIVE tab bar
   *  (UITabBarController) is doing its first layout — the bar keeps a stale
   *  frame BELOW the screen and stays there after popping back. A sub-half-
   *  second defer is imperceptible next to the share-sheet handoff itself. */
  const pushSettled = (route: { pathname: string; params: Record<string, string> }) => {
    if (Platform.OS === 'ios') {
      InteractionManager.runAfterInteractions(() => {
        setTimeout(() => router.push(route as any), 400);
      });
    } else {
      router.push(route as any);
    }
  };

  const navigateWithFiles = async (files: { path: string; mimeType: string }[]) => {
    try {
      // A shared PDF navigates IMMEDIATELY with its (cache-normalized) path —
      // the scan session converts it to pages as its first background stage,
      // so the loader shows right away instead of the app sitting frozen on
      // the share sheet. Only copy to cache here (share-intent URIs can
      // expire once the intent is handled).
      const pdf = files.find((f) => looksLikePdf(f.path, f.mimeType));
      if (pdf) {
        const localPdf = await normalizeToLocalUri(pdf.path, '.pdf');
        pushSettled({ pathname: '/receipt-process', params: { pdfUri: localPdf } });
        return;
      }
      const allUris: string[] = [];
      for (const file of files) {
        allUris.push(await normalizeToLocalUri(file.path, '.jpg'));
      }
      if (allUris.length === 0) return;
      const params: Record<string, string> = allUris.length === 1
        ? { uri: allUris[0] }
        : { uris: allUris.map(encodeURIComponent).join(',') };
      pushSettled({ pathname: '/receipt-process', params });
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

function RootLayout() {
  const colorScheme = useResolvedScheme();
  const colors = useTheme();
  const { t } = useTranslation();
  // Subscribe to NetInfo once, at the top of the tree. Downstream
  // consumers read via `useNetworkStatus(s => s.isOnline)`.
  useBindNetInfo();
  useReceiptQueueRunner();
  usePushNotifications();

  // One-shot "leave the recipe without a pop transition" flag — flips the
  // template/[id] declaration below to animation:'none' for the "Pridėti
  // prekes" leave only. See the comment on that <Stack.Screen> for why the
  // option must travel through the STATIC options rather than setOptions.
  const recipeInstantLeave = useTemplateAddState((s) => s.leaveInstant);

  // Hydrate the user-settings store once at app boot — pulls the
  // persisted language choice (or detects device locale on first launch)
  // and syncs it into i18next. Subsequent renders see the right
  // translations because i18next emits `languageChanged` and
  // useTranslation re-renders consumers.
  const hydrateSettings = useSettingsStore((s) => s.hydrate);
  useEffect(() => {
    hydrateSettings().catch((e) => console.warn('[settings] hydrate failed', e));
  }, [hydrateSettings]);

  // Hydrate the verified-user session from expo-secure-store on boot so
  // the publish wall + share sheet can read the JWT immediately.
  useEffect(() => {
    import('../state/authState').then(m => m.useAuthState.getState().hydrate())
      .catch(e => console.warn('[auth] hydrate failed', e));
  }, []);

  // Client version gate: ask the server on launch whether this build is too old for the
  // current backend. A 'hard' result blocks with a store gate; the per-request 426 catcher
  // (fetch interceptor) covers a floor flipped mid-session. Fail-open — never blocks offline.
  useEffect(() => {
    import('../state/versionGate').then(m => m.useVersionGate.getState().checkVersion())
      .catch(() => { /* fail open */ });
  }, []);

  // Prod OTA update-on-resume (Phase 3): download warm-published EAS updates and apply them
  // on a foreground return after a long background. Cold-start applies natively (splash).
  useAppUpdates();

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
        router.replace('/(admin)/catalog' as any);
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
    // RNGH gestures (results sheet, swipe queue, admin split) need this at the
    // APP root — a GestureDetector outside a GestureHandlerRootView throws.
    // (Some screens used to carry their own root view; one at the top covers all.)
    <GestureHandlerRootView style={{ flex: 1 }}>
    <KeyboardProvider>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister: queryPersister,
        maxAge: 24 * 60 * 60 * 1000,
        buster: 'v1',
        dehydrateOptions: {
          // Don't persist the discounts list — it's thousands of products and
          // a single AsyncStorage value that big overflows Android's ~2 MB
          // SQLite CursorWindow row, which makes the WHOLE persisted cache get
          // discarded on launch ("Row too big to fit into CursorWindow"). It's
          // refetched on open anyway; small queries (categories) still persist.
          shouldDehydrateQuery: (query) =>
            query.state.status === 'success' && query.queryKey[0] !== 'discounts',
        },
      }}
    >
    <ShareIntentProvider>
    <DisplayPreferenceProvider>
    <ThemeProvider value={navTheme}>
      <View style={{ flex: 1, backgroundColor: colors.pageBackground }}>
      <DevUpdateBanner />
      <ShareHandler />
      <OfflineBanner />
      <ReceiptProcessingBanner />
      <UsernameGate />
      <LevelUpModal />
      <UpdateGateModal />
      <Stack
        screenOptions={{
          // Freeze (react-freeze) each screen's React tree while it is fully
          // covered by a pushed screen — without this the results-map screen
          // kept its MapView + full-screen Skia canvas + overlay worklets live
          // under everything pushed above it. The (tabs) layout already sets
          // this on the tab navigator; this extends it to root-stack pushes.
          // NOTE the template/[id] leave keeps its static animation:'none'
          // workaround below — that pop stays immune to the interrupted-close
          // alpha-wash the freeze/unfreeze load once caused.
          freezeOnBlur: true,
          headerStyle: { backgroundColor: colors.pageBackground },
          // Pink tint colours the native back chevron consistently across the
          // app. Title colour is pinned to textPrimary via headerTitleStyle so
          // it stays dark (headerTintColor would otherwise turn it pink too).
          headerTintColor: colors.primary,
          headerTitleStyle: { color: colors.textPrimary },
          // Left-align titles everywhere (iOS defaults to centre; we want the
          // Android-style left alignment app-wide).
          headerTitleAlign: 'left',
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
        {/* gestureEnabled:false — the tab group is the app root (reached via the
            app/index.tsx <Redirect>). Without this, an edge-swipe-back pops to
            `index`, which re-fires the Redirect and mounts a SECOND (tabs) group
            → a duplicate Naršyti with a clipped/offset NativeTabs bar. */}
        <Stack.Screen name="(tabs)" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="(admin)" options={{ headerShown: false }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
        {/* The catalog tree (product/[id], discounts, browse/[categoryId], the
            catalog search) now lives INSIDE the Catalog tab's nested stack
            (app/(tabs)/catalog/*) so the tab bar stays visible while browsing.
            Only the root-level /search remains here (receipt-matching flow). */}
        <Stack.Screen name="admin/catalog/[categoryId]" options={{ headerShown: false }} />
        <Stack.Screen name="basket/[id]" options={{ title: t('screens.basket') }} />
        {/* basket/results/[id] is the map-only results screen → full-bleed,
            no native header (a floating circular back button sits over the
            map instead). Declaring headerShown:false HERE (not just inline in
            the screen) is what actually keeps the header from reserving a
            top strip — relying on the screen's inline override alone left an
            empty header bar pushing the map down (the "black bar at the top"). */}
        <Stack.Screen name="basket/results/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="shopping-list/[id]" options={{ title: t('screens.shoppingList'), headerLeft: () => <ScreenBackButton /> }} />
        {/* 2.0 re-homes: the former Sąrašas + Analizė tabs live on as pushed
            routes (reached from Profilis quick-links and receipt flows). The
            titleless glass bar comes from each screen's CollapsingHeader;
            registering the chevron here keeps it on the first frame. */}
        <Stack.Screen name="shopping-list/index" options={{ title: '', headerLeft: () => <ScreenBackButton /> }} />
        <Stack.Screen name="receipt/index" options={{ title: '', headerLeft: () => <ScreenBackButton /> }} />
        <Stack.Screen name="receipt-process" options={{ title: t('screens.receiptProcess'), headerLeft: () => <ScreenBackButton /> }} />
        {/* Vote history draws its OWN chrome (CollapsingHeader: back · small
            title on scroll · help), so the native bar must stay off — with both
            on, the screen wore two stacked top bars. */}
        <Stack.Screen name="profile/vote-history" options={{ headerShown: false }} />
        {/* Recipe-import review — its own CollapsingHeader (back · small title on
            scroll), so the native bar must stay off from the first frame. */}
        <Stack.Screen name="recipe-import" options={{ headerShown: false }} />
        {/* Recipe detail — its own CollapsingHeader (cover-coloured custom bar),
            native bar off from the first frame like the other dock hosts, so
            the bottom dock's full detent can cover the chrome to the top.
            ANIMATION: platform default for the ordinary push/pop — EXCEPT the
            "Pridėti prekes" leave (startAddingItems, app/template/[id].tsx).
            That leave is a root-stack POP of this screen running concurrently
            with a tab switch (Receptai → Katalogas), the catalog's
            freezeOnBlur unfreeze and the session dock mounting. Under that
            load the pop's native close transition is interrupted mid-flight
            and the REVEALED (tabs) screen — the container of the WHOLE tab
            navigator — is stranded at partial alpha (Android's default close
            tween fades the revealed screen 0→1; cancelled part-way it leaves
            the fragment's view semi-transparent). Because every tab scene and
            every screen pushed inside a tab's nested stack renders INSIDE
            that container, the root backdrop bleeds through them all — the
            persistent wash over everything opened from the catalog
            (device-probe confirmed: the wash sampled as the root backdrop
            colour). On Android the close animation is chosen from the
            DISMISSED screen's stackAnimation (rnscreens ScreenStack close
            branch), and a RUNTIME setOptions({animation:'none'}) demonstrably
            never survived into that native pop transaction — so the 'none'
            is declared HERE, in the static options, gated by the one-shot
            leaveInstant flag that startAddingItems commits one frame before
            the navigate. Native 'none' maps to a 1→1 alpha tween
            (rns_no_animation_20), so even an interrupted commit cannot
            strand a wash. The flag resets in the recipe screen's unmount
            cleanup, so the next push into a recipe keeps the platform
            animation. */}
        <Stack.Screen name="template/[id]" options={{ headerShown: false, animation: recipeInstantLeave ? 'none' : undefined }} />
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
            headerLeft: () => <ScreenBackButton />,
          }}
        />
        <Stack.Screen name="profile/restore-account" options={{ title: t('restore.title') }} />
        <Stack.Screen name="profile/creator-auth" options={{ title: t('creatorAuth.title') }} />
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
      {/* Top-layer overlay (last child = highest paint order) so it sits above
          the navigator without ever altering its frame. */}
      {/* 2.0 basket-session surface: floating bar + preview sheet + target
          chooser, self-gating to the browse-y routes. Above the navigator,
          below EnvBadge. */}
      <BasketSessionHost />
      <EnvBadge />
      {/* Always-mounted off-screen surface used to burn card-masking boxes
          into receipt images before upload (the headless receipt queue has
          no ViewShot of its own). Renders nothing until a redaction runs. */}
      <MaskRedactionHost />
      <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
      </View>
    </ThemeProvider>
    </DisplayPreferenceProvider>
    </ShareIntentProvider>
    </PersistQueryClientProvider>
    </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

// Sentry.wrap enables the React error boundary + touch/navigation context on
// captured events. No-op behaviour-wise when Sentry is disabled (dev).
export default Sentry.wrap(RootLayout);
