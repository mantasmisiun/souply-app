import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { API_BASE_URL } from '../config/api';
import { getUserId } from '../config/user';

/**
 * Souply 2.0 Phase 6 — push doorbell lifecycle: ask permission (Android 13
 * runtime prompt included), register the Expo push token with the API, and
 * route notification taps to their payload route. The INBOX works without
 * any of this (polling), so every failure here is silent-best-effort.
 */

// Foreground presentation: banner without the system alert sound spam.
Notifications.setNotificationHandler({
    handleNotification: async () => ({
        shouldPlaySound: false,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
    }),
});

export function usePushNotifications(): void {
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const perm = await Notifications.getPermissionsAsync();
                let granted = perm.granted;
                if (!granted && perm.canAskAgain) {
                    granted = (await Notifications.requestPermissionsAsync()).granted;
                }
                if (!granted || cancelled) return;
                if (Platform.OS === 'android') {
                    await Notifications.setNotificationChannelAsync('default', {
                        name: 'default',
                        importance: Notifications.AndroidImportance.DEFAULT,
                    });
                }
                const token = (await Notifications.getExpoPushTokenAsync()).data;
                if (cancelled || !token) return;
                await getUserId(); // ensure identity exists before the authed call
                await fetch(`${API_BASE_URL}/api/push-tokens`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token, platform: Platform.OS === 'ios' ? 'ios' : 'android' }),
                });
            } catch {}
        })();

        // Tap → deep-link route from the payload.
        const sub = Notifications.addNotificationResponseReceivedListener(resp => {
            const route = (resp.notification.request.content.data as any)?.route;
            if (typeof route === 'string' && route.startsWith('/')) {
                try { router.push(route as any); } catch {}
            }
        });
        return () => { cancelled = true; sub.remove(); };
    }, []);
}
