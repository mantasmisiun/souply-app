import { Text, View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { APP_ENV } from '../config/env';

/**
 * Thin top strip that marks non-production builds, so a dev/staging build can
 * never be mistaken for production. Renders nothing in prod (zero footprint).
 *   DEV → blue · STAGING → amber (red is reserved for danger).
 */
const BADGE: Record<string, { label: string; bg: string } | null> = {
    dev: { label: 'DEV', bg: '#2563EB' },
    staging: { label: 'STAGING', bg: '#D97706' },
    prod: null,
};

export function EnvBanner() {
    const cfg = BADGE[APP_ENV];
    if (!cfg) return null;
    return (
        <SafeAreaView edges={['top']} style={{ backgroundColor: cfg.bg }}>
            <View style={styles.bar}>
                <Text style={styles.text}>{cfg.label}</Text>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    bar: { alignItems: 'center', justifyContent: 'center', paddingVertical: 2 },
    text: { color: '#FFFFFF', fontSize: 11, fontWeight: '800', letterSpacing: 1.5 },
});
