import {
    Tabs,
    useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useEffect,
    useMemo,
    useRef,
    useState } from 'react';
import { View,
    Text,
    StyleSheet,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../constants/theme';
import { HapticTab } from '../../components/haptic-tab';
import { useProfileStore } from '../../state/profileStore';
import { useAdminModeStore } from '../../state/adminModeStore';

/**
 * Tab bar shown when the user is in admin mode (toggled from Profilis).
 *
 * Layout: Images / placeholder / placeholder / placeholder / Profile.
 * The placeholders are intentionally inert — they'll be wired up as
 * additional admin tabs ship (amounts, names, dead-end orphans, audit).
 * Until then they show a "Tuoj bus" hint when tapped so users don't
 * think the app is broken.
 *
 * Mode switching lives in `state/adminModeStore`. Profilis on the user
 * side has a "Pereiti į admin panelį"; this side's Profilis has
 * "Sugrįžti į vartotojo panelį" — both flip the persisted store flag
 * and `router.replace` to the appropriate root.
 */

export default function AdminTabLayout() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    const initialNavDone = useRef(false);

    // ── Cosmetic hardening ──────────────────────────────────────────
    // If a user spoofs the AsyncStorage `admin_mode` flag they can
    // make the boot effect mount this layout. Every server endpoint
    // is already gated by `requireAdmin` so they can't DO anything,
    // but they'd still see the admin tab shell. Verify against the
    // server-trusted `profile.isAdmin` and bounce back to user mode
    // if the local flag is lying.
    //
    // Verification states:
    //   verifying      — profile not loaded yet; render spinner
    //   verifyFailed   — profile arrived, isAdmin=false; reload to /(tabs)
    //   verified       — profile arrived, isAdmin=true; render the tab bar
    const profile = useProfileStore(s => s.profile);
    const fetchProfile = useProfileStore(s => s.fetchProfile);
    const [bouncing, setBouncing] = useState(false);
    // profileFetched gates tab rendering — we need the fresh server value of
    // `role` before deciding which tabs to show. Using the persisted cache
    // would read a stale role and render the wrong tab bar permanently.
    const [profileFetched, setProfileFetched] = useState(false);

    useEffect(() => {
        fetchProfile().finally(() => setProfileFetched(true));
    }, []);

    const isSuperAdmin = profile?.role === 'superadmin';

    useEffect(() => {
        if (profile && profile.isAdmin === false && !bouncing) {
            setBouncing(true);
            (async () => {
                try {
                    await useAdminModeStore.getState().setMode('user');
                    const Updates = await import('expo-updates');
                    await Updates.reloadAsync();
                } catch (e) {
                    console.warn('[admin/_layout] verify-failed bounce failed', e);
                }
            })();
        }
    }, [profile, bouncing]);

    // Block render until fresh profile arrives. profile===null or
    // !profileFetched both show the spinner so the tab bar is never
    // drawn with a stale role.
    const verified = profileFetched && profile?.isAdmin === true;

    useEffect(() => {
        if (verified && !initialNavDone.current) {
            initialNavDone.current = true;
            if (!isSuperAdmin) {
                router.replace('/(admin)/queue');
            }
        }
    }, [verified]);

    if (!verified) {
        return (
            <View style={styles.verifying}>
                <MaterialProgress size="large" color={colors.primary} />
            </View>
        );
    }

    return (
        <Tabs
            initialRouteName={isSuperAdmin ? 'catalog' : 'queue'}
            screenOptions={{
                tabBarButton: HapticTab,
                tabBarActiveTintColor: colors.primary,
                tabBarInactiveTintColor: colors.textSecondary,
                tabBarStyle: {
                    backgroundColor: colors.cardBackground,
                    borderTopColor: colors.borderSubtle,
                },
                headerShown: false,
            }}
        >
            <Tabs.Screen
                name="catalog"
                options={{
                    title: t('admin.tabCatalog'),
                    headerShown: false,
                    ...(isSuperAdmin ? {} : { tabBarItemStyle: { display: 'none' } }),
                    tabBarIcon: ({ focused, color, size }) => (
                        <Ionicons name={focused ? 'layers' : 'layers-outline'} size={size} color={color} />
                    ),
                }}
            />
            <Tabs.Screen
                name="queue"
                options={{
                    title: t('admin.tabQueue'),
                    headerShown: false,
                    tabBarIcon: ({ focused, color, size }) => (
                        <Ionicons name={focused ? 'list' : 'list-outline'} size={size} color={color} />
                    ),
                }}
            />
            <Tabs.Screen
                name="receipts"
                options={{
                    title: t('admin.tabReceipts'),
                    headerShown: false,
                    ...(isSuperAdmin ? {} : { tabBarItemStyle: { display: 'none' } }),
                    tabBarIcon: ({ focused, color, size }) => (
                        <Ionicons name={focused ? 'receipt' : 'receipt-outline'} size={size} color={color} />
                    ),
                }}
            />
            {/* Keep old screens registered so deep-links and existing code don't 404. */}
            <Tabs.Screen name="flags" options={{ href: null }} />
            <Tabs.Screen name="uncategorised" options={{ href: null }} />
            <Tabs.Screen name="images" options={{ href: null }} />
            <Tabs.Screen name="amounts" options={{ href: null }} />
            <Tabs.Screen
                name="menu"
                options={{
                    title: t('tabs.profilis'),
                    headerShown: false,
                    tabBarIcon: ({ focused, color, size }) => (
                        <Ionicons name={focused ? 'person' : 'person-outline'} size={size} color={color} />
                    ),
                }}
            />
        </Tabs>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    verifying: {
        flex: 1,
        backgroundColor: c.pageBackground,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
