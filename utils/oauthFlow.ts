/**
 * OAuth flow wrappers — Pass B.4.
 *
 *   • `signInWithGoogle()` — uses Expo's AuthSession Google provider.
 *     Returns the ID token to be exchanged with our server.
 *   • `signInWithApple()`  — uses expo-apple-authentication. iOS-only;
 *     the publish wall hides the Apple button on Android.
 *
 * Client IDs come from env (loaded via expo-constants). For dev the
 * "iosClientId" / "androidClientId" / "expoClientId" values can be
 * overridden through .env.local — same as every other Expo OAuth
 * tutorial.
 */
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { useEffect } from 'react';
import { Platform } from 'react-native';

// Required for the Google in-app browser to dismiss correctly after the
// callback redirect. Safe to call multiple times.
WebBrowser.maybeCompleteAuthSession();

// Client IDs come from app.config.js → extra. We're pulling from
// process.env so EAS Secrets can inject without code changes.
const GOOGLE_IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '';
const GOOGLE_ANDROID_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? '';
const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '';

export interface OauthTokenResult {
    provider: 'google' | 'apple';
    idToken: string;
}

/**
 * Hook wrapping `useAuthRequest`. The publish wall calls
 * `promptAsync()` from the returned tuple. On success the resolved
 * promise carries `.id_token`.
 */
export function useGoogleOauth(onIdToken: (token: string) => void) {
    const [request, response, promptAsync] = Google.useAuthRequest({
        iosClientId: GOOGLE_IOS_CLIENT_ID,
        androidClientId: GOOGLE_ANDROID_CLIENT_ID,
        webClientId: GOOGLE_WEB_CLIENT_ID,
        // Scope `openid` so we get a JWT id_token in the response. The
        // rest are standard.
        scopes: ['openid', 'profile', 'email'],
    });

    useEffect(() => {
        if (response?.type !== 'success') return;
        const idToken = response.authentication?.idToken ?? (response.params as any)?.id_token;
        if (typeof idToken === 'string' && idToken.length > 0) {
            onIdToken(idToken);
        }
    }, [response, onIdToken]);

    return { request, promptAsync, response };
}

/**
 * Apple sign-in. iOS only at v1; on Android the button is hidden by
 * the caller. Returns the identityToken (Apple's JWT) on success.
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
