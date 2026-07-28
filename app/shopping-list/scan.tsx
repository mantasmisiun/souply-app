import {
    Ionicons } from '@expo/vector-icons';
import { CameraView,
    useCameraPermissions } from 'expo-camera';
import { Stack,
    useRouter } from 'expo-router';
import { useMemo,
    useRef,
    useState } from 'react';
import { ActivityIndicator,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
    Alert,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { useTranslation } from 'react-i18next';
import { API_BASE_URL } from '../../config/api';
import { getUserId } from '../../config/user';
import { useTheme, type AppTheme } from '../../constants/theme';

export default function ScanShoppingListScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const [permission, requestPermission] = useCameraPermissions();
    const router = useRouter();
    // Guard against rapid re-fires: expo-camera invokes onBarcodeScanned
    // on every frame the QR is in view. Without this ref the claim POST
    // would fire dozens of times.
    const handledRef = useRef(false);
    const [claiming, setClaiming] = useState(false);

    const onScanned = async (data: string) => {
        if (handledRef.current || claiming) return;
        handledRef.current = true;
        setClaiming(true);
        try {
            const userId = await getUserId();
            const res = await fetch(`${API_BASE_URL}/api/shopping-lists/share/${encodeURIComponent(data)}/claim`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId }),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                const reason = body?.reason;
                const msg =
                    reason === 'expired' ? t('scan.errorExpired') :
                    reason === 'already_claimed' ? t('scan.errorClaimed') :
                    t('scan.errorJoin');
                Alert.alert(t('scan.errorTitle'), msg, [
                    { text: t('scan.ok'), onPress: () => router.back() },
                ]);
                return;
            }
            const body = await res.json();
            if (typeof body?.listId !== 'number') {
                throw new Error('Response missing listId');
            }
            // Replace the scan screen in the stack so Back doesn't land
            // users back on the camera.
            router.replace(`/shopping-list/${body.listId}` as any);
        } catch {
            Alert.alert(t('scan.errorTitle'), t('scan.errorScan'), [
                { text: t('scan.ok'), onPress: () => router.back() },
            ]);
        } finally {
            setClaiming(false);
        }
    };

    if (!permission) {
        return <View style={styles.container} />;
    }
    if (!permission.granted) {
        return (
            <View style={styles.permissionContainer}>
                <Stack.Screen options={{ title: t('scan.title') }} />
                <Ionicons name="qr-code-outline" size={64} color={colors.textMuted} />
                <Text style={styles.permissionText}>{t('capture.permission')}</Text>
                <TouchableOpacity style={styles.permissionButton} onPress={requestPermission}>
                    <Text style={styles.permissionButtonText}>{t('capture.permissionGrant')}</Text>
                </TouchableOpacity>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <Stack.Screen options={{ title: t('scan.title') }} />
            <CameraView
                style={styles.camera}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={(result) => onScanned(result.data)}
            >
                <View style={styles.overlay}>
                    <View style={styles.frame}>
                        <View style={styles.cornerTL} />
                        <View style={styles.cornerTR} />
                        <View style={styles.cornerBL} />
                        <View style={styles.cornerBR} />
                    </View>
                    <Text style={styles.hint}>{t('scan.hint')}</Text>
                </View>
            </CameraView>
            {claiming && (
                <View style={styles.claimingOverlay}>
                    <MaterialProgress size="large" color={colors.onPrimary} />
                </View>
            )}
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: '#000' },
    camera: { flex: 1 },
    overlay: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.35)',
    },
    frame: {
        width: 240,
        height: 240,
        position: 'relative',
    },
    cornerTL: { position: 'absolute', top: 0, left: 0, width: 32, height: 32, borderTopWidth: 4, borderLeftWidth: 4, borderColor: c.onPrimary, borderTopLeftRadius: 8 },
    cornerTR: { position: 'absolute', top: 0, right: 0, width: 32, height: 32, borderTopWidth: 4, borderRightWidth: 4, borderColor: c.onPrimary, borderTopRightRadius: 8 },
    cornerBL: { position: 'absolute', bottom: 0, left: 0, width: 32, height: 32, borderBottomWidth: 4, borderLeftWidth: 4, borderColor: c.onPrimary, borderBottomLeftRadius: 8 },
    cornerBR: { position: 'absolute', bottom: 0, right: 0, width: 32, height: 32, borderBottomWidth: 4, borderRightWidth: 4, borderColor: c.onPrimary, borderBottomRightRadius: 8 },
    hint: { marginTop: 20, color: c.onPrimary, fontSize: 14, fontWeight: '500' },
    claimingOverlay: {
        ...StyleSheet.absoluteFill,
        backgroundColor: 'rgba(0,0,0,0.5)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    permissionContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16, backgroundColor: c.pageBackground },
    permissionText: { fontSize: 15, color: c.textSecondary, textAlign: 'center' },
    permissionButton: { backgroundColor: c.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 },
    permissionButtonText: { color: c.onPrimary, fontSize: 14, fontWeight: '600' },
});
