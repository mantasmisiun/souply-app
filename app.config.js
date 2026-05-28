const IS_DEV = process.env.APP_VARIANT === 'dev';
const ICON = IS_DEV ? './assets/images/DEV.png' : './assets/images/icon.png';

export default {
  expo: {
    name: IS_DEV ? 'Souply (DEV)' : 'Souply',
    slug: 'souply',
    version: '1.0.0',
    orientation: 'portrait',
    icon: ICON,
    scheme: 'souply',
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,
    ios: {
      supportsTablet: true,
      bundleIdentifier: IS_DEV ? 'com.souply.app.dev' : 'com.souply.app',
      buildNumber: '5',
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        // "Open In Souply" — appears when user taps a PDF/image in Files or Mail
        CFBundleDocumentTypes: [
          {
            CFBundleTypeName: 'PDF Document',
            CFBundleTypeRole: 'Viewer',
            LSHandlerRank: 'Alternate',
            LSItemContentTypes: ['com.adobe.pdf'],
          },
          {
            CFBundleTypeName: 'Image',
            CFBundleTypeRole: 'Viewer',
            LSHandlerRank: 'Alternate',
            LSItemContentTypes: ['public.image'],
          },
        ],
      },
    },
    android: {
      adaptiveIcon: {
        // Android masks the outer ~33% of the foreground, so the artwork must
        // sit inside the centred 66% safe zone. The *-foreground.png assets
        // already include the padded canvas; the background colour fills
        // whatever launcher mask shape clips the corners. Pink matches the
        // baked-in tile for the DEV variant; cream matches the production icon.
        backgroundColor: '#F16F8B',
        foregroundImage: IS_DEV ? './assets/images/DEV-foreground.png' : './assets/images/android-icon-foreground.png',
      },
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      package: IS_DEV ? 'com.souply.app.dev' : 'com.souply.app',
      permissions: [
        'ACCESS_COARSE_LOCATION',
        'ACCESS_FINE_LOCATION',
      ],
    },
    web: {
      output: 'static',
      favicon: ICON,
    },
    plugins: [
      [
        'expo-build-properties',
        {
          ios: {
            deploymentTarget: '16.0',
          },
        },
      ],
      'expo-router',
      'expo-localization',
      [
        'expo-splash-screen',
        {
          image: ICON,
          imageWidth: 220,
          resizeMode: 'contain',
          backgroundColor: '#FBF3E6',
          dark: {
            backgroundColor: '#FBF3E6',
          },
        },
      ],
      [
        'react-native-maps',
        {
          // Android requires a Maps SDK API key (free, Google Cloud Console →
          // enable "Maps SDK for Android" → create key → set GOOGLE_MAPS_API_KEY_ANDROID).
          // iOS uses Apple Maps by default — no key needed.
          androidGoogleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY_ANDROID || '',
        },
      ],
      [
        'expo-share-intent',
        {
          // Share Extension — appears in the standard iOS/Android share sheet
          iosActivationRules: {
            NSExtensionActivationSupportsImageWithMaxCount: 10,
            NSExtensionActivationSupportsFileWithMaxCount: 10,
          },
          iosAppGroupIdentifier: IS_DEV ? 'group.com.souply.app.dev' : 'group.com.souply.app',
          iosShareExtensionBundleIdentifier: IS_DEV
            ? 'com.souply.app.dev.ShareExtension'
            : 'com.souply.app.ShareExtension',
          // Android — single and multi-file sharing
          androidIntentFilters: ['image/*', 'application/pdf', '*/*'],
          androidMultiIntentFilters: ['image/*', 'application/pdf'],
        },
      ],
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    extra: {
      router: { notFound: false },
      eas: {
        projectId: 'd3053a04-a3bb-4dd2-81e5-d10ceddd06db',
      },
    },
    owner: 'souply-solutions',
    runtimeVersion: {
      policy: 'appVersion',
    },
    updates: {
      url: 'https://u.expo.dev/d3053a04-a3bb-4dd2-81e5-d10ceddd06db',
      requestHeaders: {
        'expo-channel-name': IS_DEV ? 'dev' : 'production',
      },
    },
  },
};
