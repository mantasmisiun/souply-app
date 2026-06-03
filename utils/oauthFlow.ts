/**
 * OAuth flow wrappers.
 *
 *   • `signInWithGoogle()` — NATIVE Google Sign-In via Google Play Services
 *     (@react-native-google-signin). No browser, no redirect scheme — returns
 *     the ID token directly. Replaced the old expo-auth-session browser flow,
 *     which couldn't reliably return from the Android Custom Tab (it landed on
 *     google.com instead of deep-linking back).
 *   • `signInWithApple()`  — expo-apple-authentication. iOS-only; the publish
 *     wall hides the Apple button on Android.
 *
 * Client IDs come from EXPO_PUBLIC_* env (eas.json profile env).
 */
import * as AppleAuthentication from 'expo-apple-authentication';
import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';
import { Platform } from 'react-native';

// webClientId = the audience of the ID token Google returns (must be in the
// server's accepted-audience list — GOOGLE_OAUTH_CLIENT_ID is comma-separated).
// On Android the sign-in itself authenticates via the app's package + SHA-1
// against the Android OAuth client in GCP — no google-services.json required.
const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '';
const GOOGLE_IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '';

GoogleSignin.configure({
    webClientId: GOOGLE_WEB_CLIENT_ID,
    ...(GOOGLE_IOS_CLIENT_ID ? { iosClientId: GOOGLE_IOS_CLIENT_ID } : {}),
});

export interface OauthTokenResult {
    provider: 'google' | 'apple';
    idToken: string;
}

/**
 * Native Google sign-in. Resolves to the ID token on success, or `null` when
 * the user cancels (callers treat null as a silent no-op). Throws on a real
 * error so the caller can surface it.
 */
export async function signInWithGoogle(): Promise<OauthTokenResult | null> {
    try {
        await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
        const res: any = await GoogleSignin.signIn();
        // v13+ returns { type: 'success' | 'cancelled', data }; older returns the
        // user directly and throws on cancel. Handle both shapes.
        if (res?.type === 'cancelled') return null;
        const idToken: string | null = res?.data?.idToken ?? res?.idToken ?? null;
        if (!idToken) throw new Error('Google sign-in returned no idToken');
        return { provider: 'google', idToken };
    } catch (e: any) {
        if (e?.code === statusCodes.SIGN_IN_CANCELLED) return null;
        throw e;
    }
}

/**
 * Apple sign-in. iOS only at v1; on Android the button is hidden by the caller.
 * Returns the identityToken (Apple's JWT) on success.
 */
export async function signInWithApple(): Promise<OauthTokenResult> {
    if (Platform.OS !== 'ios') throw new Error('Apple sign-in is iOS-only');
    const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
            AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
            AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
    });
    const idToken = credential.identityToken;
    if (!idToken) throw new Error('Apple did not return identityToken');
    return { provider: 'apple', idToken };
}

export const isAppleSignInAvailable = Platform.OS === 'ios';
