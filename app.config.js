const IS_DEV = process.env.APP_VARIANT === 'dev';
const IS_STAGING = process.env.APP_VARIANT === 'staging';
const APP_ENV = IS_DEV ? 'dev' : IS_STAGING ? 'staging' : 'prod';
// One source for the per-variant identity. Distinct package/bundle ids let
// dev + staging + prod coexist on one device; the name suffix + EnvBanner
// make non-prod builds unmistakable. (Icon badge is dev-only for now.)
const BUNDLE_ID = IS_DEV ? 'lt.souply.app.dev' : IS_STAGING ? 'lt.souply.app.staging' : 'lt.souply.app';
const APP_NAME = IS_DEV ? 'Souply (DEV)' : IS_STAGING ? 'Souply (staging)' : 'Souply';
const ICON = IS_DEV ? './assets/images/DEV.png' : IS_STAGING ? './assets/images/STAGING.png' : './assets/images/icon.png';
// Universal/App Link host per environment. The dev build (testers) deep-links
// against the test web stack; prod against souply.lt. localhost can't host
// universal links, so dev points at the reachable test domain. The matching
// apple-app-site-association / assetlinks.json must be served from each host.
const LINK_HOST = (IS_DEV || IS_STAGING) ? 'souply.manofoto.dpdns.org' : 'souply.lt';

// Google's native Android OAuth redirect comes back on the reversed-DNS scheme
// of the Android client ID (com.googleusercontent.apps.<id>:/oauth2redirect).
// Android only routes that deep link back into the app if the scheme is
// registered — without it the sign-in tab lands on a google.com page and never
// returns. Derived per-variant from the client-id env so dev/staging/prod each
// register their own client's scheme.
const GOOGLE_ANDROID_OAUTH = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? '';
const GOOGLE_REDIRECT_SCHEME = GOOGLE_ANDROID_OAUTH
  ? `com.googleusercontent.apps.${GOOGLE_ANDROID_OAUTH.replace(/\.apps\.googleusercontent\.com$/, '')}`
  : null;

export default {
  expo: {
    name: APP_NAME,
    slug: 'souply',
    version: '1.0.0',
    orientation: 'portrait',
    icon: ICON,
    scheme: ['souply', ...(GOOGLE_REDIRECT_SCHEME ? [GOOGLE_REDIRECT_SCHEME] : [])],
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,
    ios: {
      supportsTablet: true,
      bundleIdentifier: BUNDLE_ID,
      buildNumber: '5',
      // Sign in with Apple — adds the entitlement so AppleAuthentication
      // (utils/oauthFlow.ts) works. Required by App Store rule 4.8 because we
      // also offer Google sign-in. EAS auto-provisions the capability on the
      // App ID at build time.
      usesAppleSignIn: true,
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
        // Documents (receipts/QRs) are imported as a copy, not edited in their
        // original location — required alongside CFBundleDocumentTypes or Apple
        // flags ITMS-90737 on upload.
        LSSupportsOpeningDocumentsInPlace: false,
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
        foregroundImage: IS_DEV ? './assets/images/DEV-foreground.png' : IS_STAGING ? './assets/images/STAGING-foreground.png' : './assets/images/android-icon-foreground.png',
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
      package: BUNDLE_ID,
      // Precise + approximate location for accurate nearest-store results and
      // map centering. FINE requires a Play Console "Location permissions"
      // declaration + prominent in-app disclosure (handled at submission).
      permissions: [
        'ACCESS_COARSE_LOCATION',
        'ACCESS_FINE_LOCATION',
      ],
      // Strip permissions that bundled native modules (expo-media-library /
      // expo-camera) inject but we never use. READ_MEDIA_IMAGES/VIDEO trigger
      // Google Play's Photo & Video Permissions policy — we pick via the system
      // Photo Picker and only SAVE the QR, so we read no media. This is the
      // documented `tools:node="remove"` mechanism, applied by Expo core.
      blockedPermissions: [
        'android.permission.RECORD_AUDIO',
        'android.permission.READ_MEDIA_AUDIO',
        'android.permission.READ_MEDIA_IMAGES',
        'android.permission.READ_MEDIA_VIDEO',
        'android.permission.SYSTEM_ALERT_WINDOW',
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
          iosAppGroupIdentifier: `group.${BUNDLE_ID}`,
          iosShareExtensionBundleIdentifier: `${BUNDLE_ID}.ShareExtension`,
          // Android — single and multi-file sharing
          androidIntentFilters: ['image/*', 'application/pdf', '*/*'],
          androidMultiIntentFilters: ['image/*', 'application/pdf'],
        },
      ],
      [
        // Sentry crash reporting — wires the native crash handlers and the
        // source-map upload step. Org + auth token come from the EAS build
        // env (SENTRY_ORG, SENTRY_AUTH_TOKEN); until those are set, builds run
        // with SENTRY_DISABLE_AUTO_UPLOAD=true so the upload step is skipped
        // (JS + native crashes still report, stack traces just aren't
        // symbolicated). EU region → de.sentry.io.
        '@sentry/react-native',
        {
          project: 'souply-app',
          url: 'https://de.sentry.io/',
        },
      ],
      // Native Google Sign-In. Android needs no options (the Android OAuth
      // client is matched by package + SHA-1 in GCP; the ID token's audience is
      // the webClientId in GoogleSignin.configure()). iOS needs the reversed
      // iOS-client URL scheme so Google can redirect back into the app — set
      // GOOGLE_IOS_URL_SCHEME (the iOS profile env in eas.json) to it.
      [
        '@react-native-google-signin/google-signin',
        { iosUrlScheme: process.env.GOOGLE_IOS_URL_SCHEME || 'com.googleusercontent.apps.placeholder' },
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
        'expo-channel-name': IS_DEV ? 'dev' : IS_STAGING ? 'staging' : 'production',
      },
    },
  },
};
