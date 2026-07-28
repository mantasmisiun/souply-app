import { Redirect, useFocusEffect } from 'expo-router';
// SDK 57: `Tabs` moved to the js-tabs entry (the main-entry export is deprecated),
// and the type must come from the SAME entry — expo-router forked react-navigation,
// so `BottomTabBarProps` from the standalone @react-navigation/bottom-tabs package
// is a different (incompatible) type identity.
import { Tabs, type BottomTabBarProps } from 'expo-router/js-tabs';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { BlurView } from 'expo-blur';
import { Component, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState, Platform, View, Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import { useTheme, type AppTheme } from '../../constants/theme';
import { fetchProfileIfStale } from '../../state/profileStore';
import { useAdminModeStore } from '../../state/adminModeStore';
import { HapticTab } from '../../components/haptic-tab';
import { FloatingPillTabBar } from '../../components/FloatingPillTabBar';
import { BeetrootIcon, BasketGlyph, ChefToqueGlyph, PiggyBankGlyph } from '../../components/icons/tabGlyphs';
import { devLog } from '../../utils/devLog';

// SDK 57: Icon/Label/Badge are no longer standalone exports of
// expo-router/unstable-native-tabs — they live under NativeTabs.Trigger.
const { Icon, Label, Badge } = NativeTabs.Trigger;

class NativeTabsBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { hasError: boolean }> {
    state = { hasError: false };
    static getDerivedStateFromError() { return { hasError: true }; }
    componentDidCatch(error: Error, info: { componentStack?: string | null }) {
        devLog('tabs.iosBoundaryCaught', {
            name: error?.name,
            message: error?.message,
            stack: error?.stack?.split('\n').slice(0, 30).join('\n'),
            componentStack: info?.componentStack?.split('\n').slice(0, 30).join('\n'),
        });
    }
    render() { return this.state.hasError ? this.props.fallback : this.props.children; }
}

function TabBadge({ count, styles }: { count: number; styles: ReturnType<typeof makeStyles> }) {
    if (count === 0) return null;
    return (
        <View style={styles.badge}>
            <Text style={styles.badgeText}>{count > 9 ? '9+' : count}</Text>
        </View>
    );
}

// Declarative mode guard: while admin mode is active this group is
// unreachable — pressing BACK out of (admin) lands here and bounces straight
// back, so mode switching needs no app reload. Lives in a WRAPPER component
// so the guarded early-return never changes the inner layout's hook order
// ("Rendered more hooks than during the previous render").
export default function TabLayoutGuard() {
    const adminMode = useAdminModeStore(st => st.mode);
    const adminHydrated = useAdminModeStore(st => st.hydrated);
    if (adminHydrated && adminMode === 'admin') {
        return <Redirect href={'/(admin)/catalog' as any} />;
    }
    return <TabLayout />;
}

function TabLayout() {

    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const [tripCount, setTripCount] = useState(0);
    const [pendingSwipeCount, setPendingSwipeCount] = useState(0);

    // ONE badge endpoint (2.0): trips ≈ non-archived trips in stages 1-4
    // (server-side grouping of baskets + lists until Phase 4 goes Trip-native);
    // pendingSwipes moved to the Profilis tab badge.
    const fetchCounts = useCallback(async () => {
        try {
            const userId = await getUserId();
            const res = await fetch(`${API_BASE_URL}/api/users/${userId}/tab-badges`);
            const badges = await res.json();
            setTripCount(Number(badges?.trips) || 0);
            setPendingSwipeCount(Number(badges?.pendingSwipes) || 0);
        } catch (error) {
            console.error('Failed to fetch counts:', error);
        }
    }, []);

    // Refetch when the tab group (re)gains navigation focus — covers mount and
    // every return from a root-stack push (receipt flows, settings, ...).
    useFocusEffect(useCallback(() => { fetchCounts(); }, [fetchCounts]));

    // Poll gated on the app actually being in the FOREGROUND, at 60s. The old
    // 10s always-on interval kept firing while backgrounded (~360 req/h);
    // AppState pauses it entirely, and a foreground return refetches at once.
    useEffect(() => {
        let interval: ReturnType<typeof setInterval> | null = null;
        const start = () => { if (interval == null) interval = setInterval(fetchCounts, 60_000); };
        const stop = () => { if (interval != null) { clearInterval(interval); interval = null; } };
        if (AppState.currentState === 'active') start();
        const sub = AppState.addEventListener('change', (state) => {
            if (state === 'active') { fetchCounts(); start(); }
            else stop();
        });
        return () => { stop(); sub.remove(); };
    }, [fetchCounts]);

    // Stale-guarded (state/profileStore.ts) — the store already knows when its
    // data is fresh; the previous unconditional fetchProfile() bypassed that
    // and refetched profile+stats on every tab-layout mount.
    useEffect(() => {
        fetchProfileIfStale();
    }, []);

    const renderTabBar = useCallback((props: BottomTabBarProps) => <FloatingPillTabBar {...props} />, []);

    // Mount diagnostic, ONCE — this used to sit in the render body of the iOS
    // branch, POSTing to /api/dev-log on every re-render of the tab layout.
    useEffect(() => {
        if (Platform.OS === 'ios') devLog('tabs.iosLayoutMount', {});
    }, []);

    const jsTabs = (
        <Tabs
            tabBar={renderTabBar}
            screenOptions={{
                tabBarButton: HapticTab,
                freezeOnBlur: true,
                tabBarActiveTintColor: colors.primary,
                tabBarInactiveTintColor: colors.textSecondary,
                // The real bar visuals live in the DockedGlassSheet (glass pill).
                // React Navigation's own tab-bar container must be a transparent
                // ABSOLUTE overlay so it floats ABOVE the tab's content — incl.
                // screens pushed inside a tab's nested native stack. Without
                // position:absolute the container sits in normal flow and an
                // Android native-stack push paints over the pill (it vanishes on
                // catalog sub-screens). Screens already pad for a floating bar via
                // FLOATING_TAB_BAR_CLEARANCE, so reserving no space is correct.
                tabBarStyle: {
                    position: 'absolute',
                    backgroundColor: 'transparent',
                    borderTopWidth: 0,
                    elevation: 0,
                },
                // Each tab is a folder with its own nested Stack (see
                // tabStackOptions), which provides the native glass header.
                // Disable the JS Tabs header so Android doesn't stack two bars.
                headerShown: false,
            }}
        >
            <Tabs.Screen
                name="catalog"
                options={{
                    title: t('tabs.catalog'),
                    tabBarIcon: ({ focused, color, size }) => (
                        <BeetrootIcon size={size} color={color} filled={focused} />
                    ),
                }}
            />
            <Tabs.Screen
                name="basket"
                options={{
                    title: t('tabs.trips'),
                    tabBarIcon: ({ color, size }) => (
                        <View>
                            <BasketGlyph size={size} color={color} />
                            <TabBadge count={tripCount} styles={styles} />
                        </View>
                    ),
                }}
            />
            <Tabs.Screen
                name="templates"
                options={{
                    title: t('tabs.templates'),
                    tabBarIcon: ({ color, size }) => (
                        <ChefToqueGlyph size={size} color={color} />
                    ),
                }}
            />
            <Tabs.Screen
                name="menu"
                options={{
                    title: t('tabs.profilis'),
                    tabBarIcon: ({ color, size }) => (
                        <View>
                            <PiggyBankGlyph size={size} color={color} />
                            {pendingSwipeCount > 0 && <TabBadge count={pendingSwipeCount} styles={styles} />}
                        </View>
                    ),
                }}
            />
        </Tabs>
    );

    if (Platform.OS === 'ios') {
        const fmt = (n: number) => (n > 0 ? (n > 9 ? '9+' : String(n)) : undefined);
        const tripBadge = fmt(tripCount);
        const swipeBadge = fmt(pendingSwipeCount);
        return (
            <NativeTabsBoundary fallback={jsTabs}>
                <NativeTabs tintColor={colors.primary}>
                    <NativeTabs.Trigger name="catalog">
                        <Icon src={require('../../assets/icons/beet-filled.png')} />
                        <Label>{t('tabs.catalog')}</Label>
                    </NativeTabs.Trigger>
                    <NativeTabs.Trigger name="basket">
                        <Icon src={require('../../assets/icons/tab-basket.png')} />
                        <Label>{t('tabs.trips')}</Label>
                        {tripBadge ? <Badge>{tripBadge}</Badge> : null}
                    </NativeTabs.Trigger>
                    <NativeTabs.Trigger name="templates">
                        <Icon src={require('../../assets/icons/tab-chef.png')} />
                        <Label>{t('tabs.templates')}</Label>
                    </NativeTabs.Trigger>
                    <NativeTabs.Trigger name="menu">
                        <Icon src={require('../../assets/icons/tab-piggy.png')} />
                        <Label>{t('tabs.profilis')}</Label>
                        {swipeBadge ? <Badge>{swipeBadge}</Badge> : null}
                    </NativeTabs.Trigger>
                </NativeTabs>
            </NativeTabsBoundary>
        );
    }

    return jsTabs;
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    badge: {
        position: 'absolute',
        top: -4,
        right: -8,
        backgroundColor: c.primary,
        borderRadius: 10,
        minWidth: 16,
        height: 16,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 3,
    },
    badgeText: { color: c.onPrimary, fontSize: 9, fontWeight: '700' },
});
