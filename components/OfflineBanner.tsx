import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../constants/theme';
import { useNetworkStatus } from '../state/networkStatus';

/**
 * Thin top banner shown whenever NetInfo reports we're offline. Sits
 * OUTSIDE the tab Stack so it covers every screen consistently — the
 * user never has to wonder whether the current failure is "app bug"
 * or "no network". Returns null when online so it costs nothing on
 * the hot path.
 */
export function OfflineBanner() {
    const isOnline = useNetworkStatus((s) => s.isOnline);
    const colors = useTheme();
    const { t } = useTranslation();
    if (isOnline) return null;
    return (
        <SafeAreaView
            edges={['top']}
            style={{ backgroundColor: colors.error }}
        >
            <View style={styles.bar}>
                <Text style={[styles.text, { color: colors.onPrimary ?? '#fff' }]}>
                    {t('banners.offline')}
                </Text>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    bar: {
        paddingVertical: 6,
        paddingHorizontal: 12,
        alignItems: 'center',
    },
    text: {
        fontSize: 13,
        fontWeight: '600',
    },
});
