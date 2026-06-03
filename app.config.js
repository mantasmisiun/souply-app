const IS_DEV = process.env.APP_VARIANT === 'dev';
const IS_STAGING = process.env.APP_VARIANT === 'staging';
const APP_ENV = IS_DEV ? 'dev' : IS_STAGING ? 'staging' : 'prod';
const ICON = IS_DEV ? './assets/images/DEV.png' : './assets/images/icon.png';
// Universal/App Link host per environment. The dev build (testers) deep-links
// against the test web stack; prod against souply.lt. localhost can't host
// universal links, so dev points at the reachable test domain. The matching
// apple-app-site-association / assetlinks.json must be served from each host.
const LINK_HOST = IS_DEV ? 'souply.manofoto.dpdns.org' : 'souply.lt';

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
      bundleIdentifier: IS_DEV ? 'lt.souply.app.dev' : 'lt.souply.app',
      buildNumber: '5',
      // Associated Domains — Universal Links for souply.lt/t/{slug} and
      // souply.lt/@{username}. The matching apple-app-site-association
      // file must be served from https://souply.lt/.well-known/
      // apple-app-site-association (see Documentation/roadmap/landing-page.md
      // Part 5). Validation only kicks in once the AASA file is live;
      // until then the entitlement is harmless.
      associatedDomains: [`applinks:${LINK_HOST}`],
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        // Descriptive purpose strings — Apple rejects generic ones. These
        // override whatever the package config plugins would inject.
        NSCameraUsageDescription:
          'Souply uses the camera to scan your receipts and product barcodes so it can compare prices for you.',
        NSPhotoLibraryUsageDescription:
          'Souply needs access to your photos so you can upload receipt images for price comparison.',
        NSPhotoLibraryAddUsageDescription:
          'Souply saves shared shopping-list QR codes to your photo library.',
        NSLocationWhenInUseUsageDescription:
          'Souply uses your approximate location to show the nearest stores with the best prices.',
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
      // App Links — autoVerify=true asks Android to fetch the
      // assetlinks.json from souply.lt/.well-known and skip the chooser
      // sheet on URL taps. assetlinks.json must list this app's SHA-256
      // signing cert fingerprint; see landing-page.md Part 5.
      intentFilters: [
        {
          action: 'VIEW',
          autoVerify: true,
          data: [
            { scheme: 'https', host: LINK_HOST, pathPrefix: '/t/' },
            { scheme: 'https', host: LINK_HOST, pathPrefix: '/@' },
          ],
          category: ['BROWSABLE', 'DEFAULT'],
        },
      ],
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      package: IS_DEV ? 'lt.souply.app.dev' : 'lt.souply.app',
      // Precise + approximate location for accurate nearest-store results and
      // map centering. FINE requires a Play Console "Location permissions"
      // declaration + prominent in-app disclosure (handled at submission).
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
          android: {
            // DEV variant only: allow plain-HTTP to the LAN dev API
            // (http://192.168.1.127:3000). Release-style builds block
            // cleartext by default. Production stays HTTPS-only (false) —
            // Play Store requires it and prod talks to https://api.souply.lt.
            usesCleartextTraffic: IS_DEV,
          },
        },
      ],
      [
        'expo-camera',
        {
          cameraPermission:
            'Souply uses the camera to scan your receipts and product barcodes so it can compare prices for you.',
          // The app never records audio/video — drop the Android RECORD_AUDIO
          // permission expo-camera adds by default (avoids Play Store scrutiny).
          recordAudioAndroid: false,
        },
      ],
      'expo-router',
      'expo-localization',
      'expo-secure-store',
      'expo-web-browser',
      [
        'expo-media-library',
        {
          // Save-only: writing shared-template QR PNGs to the gallery.
          photosPermission: 'Leisk Souply išsaugoti QR kodus į nuotraukas.',
          savePhotosPermission: 'Souply išsaugo dalijamus QR kodus į nuotraukas.',
          isAccessMediaLocationEnabled: false,
        },
      ],
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
          iosAppGroupIdentifier: IS_DEV ? 'group.lt.souply.app.dev' : 'group.lt.souply.app',
          iosShareExtensionBundleIdentifier: IS_DEV
            ? 'lt.souply.app.dev.ShareExtension'
            : 'lt.souply.app.ShareExtension',
          // Android — single and multi-file sharing
          androidIntentFilters: ['image/*', 'application/pdf', '*/*'],
          androidMultiIntentFilters: ['image/*', 'application/pdf'],
        },
      ],
      // Must come last: strips unused permissions (mic / media-audio /
      // draw-over) that the plugins above pull in. See the plugin file.
      './plugins/withBlockedPermissions',
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    extra: {
      appEnv: APP_ENV,
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
