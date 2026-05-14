const IS_DEV = process.env.APP_VARIANT === 'dev';

export default {
  expo: {
    name: IS_DEV ? 'Souply (DEV)' : 'Souply',
    slug: 'souply',
    version: '1.0.0',
    orientation: 'portrait',
    icon: './assets/images/icon.png',
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
        backgroundColor: '#FBF3E6',
        foregroundImage: './assets/images/icon.png',
      },
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      package: 'com.souply.app',
      permissions: [
        'ACCESS_COARSE_LOCATION',
        'ACCESS_FINE_LOCATION',
      ],
    },
    web: {
      output: 'static',
      favicon: './assets/images/icon.png',
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
          image: './assets/images/icon.png',
          imageWidth: 220,
          resizeMode: 'contain',
          backgroundColor: '#FBF3E6',
          dark: {
            backgroundColor: '#FBF3E6',
          },
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
      router: {},
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
