import { useCallback, useMemo, useRef } from 'react';
import { BackHandler, Platform } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Toast, type ToastHandle } from '../components/Toast';
import { useSafeBottomTabBarHeight } from './useSafeBottomTabBarHeight';

/**
 * Android hardware/gesture back on a ROOT tab screen: press-back-again-to-exit.
 * Without this, back on a non-home tab pops the root stack to the initial tab
 * (visually "navigates to Catalog") instead of leaving the app.
 *
 * `intercept` runs FIRST on each back press — return true to consume the event
 * (e.g. the Shopping tab peels its dock sheet: sub-pane → main → collapse before
 * the exit toast ever shows). Render the returned `backToExitToast` node once.
 */
export function useBackToExit(intercept?: () => boolean) {
    const { t } = useTranslation();
    const tabBarHeight = useSafeBottomTabBarHeight();
    const toastRef = useRef<ToastHandle>(null);
    const lastBackPressAt = useRef(0);

    useFocusEffect(useCallback(() => {
        if (Platform.OS !== 'android') return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            if (intercept?.()) return true;
            const now = Date.now();
            if (now - lastBackPressAt.current < 2000) {
                BackHandler.exitApp();
                return true;
            }
            lastBackPressAt.current = now;
            toastRef.current?.show(t('catalog.backToExit'));
            return true;
        });
        return () => sub.remove();
    }, [t, intercept]));

    // Lift the toast clear of the floating pill tab bar (else it renders behind it).
    const backToExitToast = useMemo(() => <Toast ref={toastRef} bottomOffset={tabBarHeight + 16} />, [tabBarHeight]);
    return { backToExitToast };
}
