import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    View, Text, Modal, TouchableOpacity, StyleSheet, ActivityIndicator,
    Share, Alert, Image, PanResponder, Animated, Platform, ToastAndroid,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../constants/theme';
import {
    generateShareLink, revokeShareLink,
    type ShareLinkResult,
} from '../utils/basketTemplatesApi';

interface Props {
    visible: boolean;
    templateId: number | null;
    templateName: string;
    itemCount: number;
    onClose: () => void;
}

/**
 * Bottom-sheet style share modal triggered from the template editor.
 * On open it asks the server for a slug + snapshot; the result is
 * cached in component state so toggling visibility doesn't re-hit the
 * API. Per spec the snapshot is computed once at share-time and
 * persisted on the row — the modal doesn't re-trigger it.
 */
export function TemplateShareSheet({
    visible, templateId, templateName, itemCount, onClose,
}: Props) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const [loading, setLoading] = useState(false);
    const [data, setData] = useState<ShareLinkResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    // When the server-rendered QR URL fails to load (e.g. MinIO not
    // reachable from the phone in dev), fall back to client-side
    // rendering so something always shows.
    const [qrUrlFailed, setQrUrlFailed] = useState(false);
    // iOS doesn't have a native toast — show a short-lived inline pill
    // below the URL instead. Android uses the platform ToastAndroid API.
    const [copiedFlash, setCopiedFlash] = useState(false);

    // ── Drag-to-dismiss via the top pill ──────────────────────────────────
    // Animated translateY tracked here. PanResponder only attaches to the
    // pill area (separate Animated.View below) so taps on the sheet body
    // never start a drag.
    const translateY = useRef(new Animated.Value(0)).current;
    const panResponder = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: () => true,
            onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 4,
            onPanResponderMove: (_, g) => {
                // Only allow downward drag — upward drag has nowhere to go.
                if (g.dy > 0) translateY.setValue(g.dy);
            },
            onPanResponderRelease: (_, g) => {
                // Past ~120 pt of drag OR with a strong downward velocity →
                // dismiss; otherwise spring back to fully open.
                if (g.dy > 120 || g.vy > 1.2) {
                    // Slide the sheet off-screen, THEN call onClose. We
                    // leave translateY at its dragged-out value — the
                    // visible-prop effect resets it to 0 when the modal
                    // is shown again, so there's no snap-back flash
                    // during the modal's own slide-out.
                    Animated.timing(translateY, {
                        toValue: 600, duration: 180, useNativeDriver: true,
                    }).start(() => onClose());
                } else {
                    Animated.spring(translateY, {
                        toValue: 0, useNativeDriver: true,
                        bounciness: 4,
                    }).start();
                }
            },
        }),
    ).current;

    useEffect(() => {
        if (!visible || templateId == null) return;
        if (itemCount === 0) {
            setError(t('basketTab.templates.shareNoItems'));
            return;
        }
        setLoading(true);
        setError(null);
        generateShareLink(templateId)
            .then(setData)
            .catch(() => setError(t('basketTab.templates.errorSave')))
            .finally(() => setLoading(false));
    }, [visible, templateId, itemCount, t]);

    // Reset when closed so the next open re-fetches (cheap; server has
    // the slug cached and just re-runs the snapshot).
    useEffect(() => {
        if (!visible) {
            setData(null);
            setError(null);
            setQrUrlFailed(false);
        } else {
            // Modal just (re-)opened — snap the drag-translateY back to 0
            // BEFORE the slide-in animation runs. Doing this on close
            // instead caused the dragged-out sheet to flash back to full
            // height for one frame as the Modal dismissed.
            translateY.setValue(0);
        }
    }, [visible, translateY]);

    const handleNativeShare = useCallback(async () => {
        if (!data) return;
        try {
            await Share.share({
                message: `${templateName} — Souply\n${data.url}`,
                url: data.url,
                title: templateName,
            });
        } catch {}
    }, [data, templateName]);

    const handleRevoke = useCallback(() => {
        if (!templateId) return;
        Alert.alert(
            t('basketTab.templates.shareRevoke'),
            t('basketTab.templates.shareRevokeConfirm'),
            [
                { text: t('basketTab.templates.deleteCancel'), style: 'cancel' },
                {
                    text: t('basketTab.templates.shareRevokeBtn'),
                    style: 'destructive',
                    onPress: async () => {
                        try {
                            await revokeShareLink(templateId);
                            onClose();
                        } catch {
                            Alert.alert(t('basketTab.errorGeneric'), t('basketTab.templates.errorSave'));
                        }
                    },
                },
            ],
        );
    }, [templateId, t, onClose]);

    // "Sutaupyk iki €X" — the maximum potential savings (most expensive
    // chain minus cheapest). Falls back to the runner-up gap when the
    // snapshot doesn't carry a max value yet (older shares pre-migration).
    const cheapest = data?.snapshot.cheapestTotalEur;
    const mostExpensive = data?.snapshot.mostExpensiveTotalEur;
    const runnerUp = data?.snapshot.runnerUpTotalEur;
    const savings = (() => {
        if (cheapest == null) return null;
        if (mostExpensive != null && mostExpensive > cheapest) {
            return (mostExpensive - cheapest).toFixed(2);
        }
        if (runnerUp != null && runnerUp > cheapest) {
            return (runnerUp - cheapest).toFixed(2);
        }
        return null;
    })();

    return (
        <Modal
            visible={visible}
            transparent
            animationType="slide"
            onRequestClose={onClose}
        >
            <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
                <Animated.View
                    style={[styles.sheet, { transform: [{ translateY }] }]}
                    onStartShouldSetResponder={() => true}
                >
                    {/* Grab handle — PanResponder is bound here only, so
                        scrolling/tapping inside the body doesn't start a
                        drag. iOS-style: pull the pill down to dismiss. */}
                    <View {...panResponder.panHandlers} style={styles.handleArea}>
                        <View style={styles.handle} />
                    </View>
                    <Text style={styles.title}>{t('basketTab.templates.shareTitle')}</Text>
                    <Text style={styles.templateName} numberOfLines={1}>{templateName}</Text>

                    {loading && (
                        <View style={styles.center}>
                            <ActivityIndicator color={colors.primary} />
                        </View>
                    )}

                    {error && (
                        <View style={styles.errorBox}>
                            <Ionicons name="alert-circle" size={18} color={colors.error} />
                            <Text style={styles.errorText}>{error}</Text>
                        </View>
                    )}

                    {data && (
                        <>
                            <View style={styles.qrWrap}>
                                <View style={styles.qrInner}>
                                    {(() => {
                                        // Source preference for the QR image:
                                        //   1. qrDataUrl — inline branded PNG bytes.
                                        //      Always reachable; guarantees the Souply
                                        //      brand mark is visible.
                                        //   2. qrUrl     — hosted branded PNG. Used
                                        //      only as a secondary path on the off
                                        //      chance the server returned a URL but
                                        //      not a data URI.
                                        //   3. Client-side `react-native-qrcode-svg` —
                                        //      last-resort unbranded fallback for the
                                        //      pre-migration / pre-asset case.
                                        const branded = data.qrDataUrl ?? (data.qrUrl && !qrUrlFailed ? data.qrUrl : null);
                                        if (branded) {
                                            return (
                                                <Image
                                                    source={{ uri: branded }}
                                                    style={{ width: 180, height: 180 }}
                                                    resizeMode="contain"
                                                    onError={() => setQrUrlFailed(true)}
                                                />
                                            );
                                        }
                                        return (
                                            <QRCode
                                                value={data.url}
                                                size={180}
                                                color={colors.textPrimary}
                                                backgroundColor={colors.cardBackground}
                                            />
                                        );
                                    })()}
                                </View>
                            </View>

                            {savings && (
                                <View style={styles.savingsRow}>
                                    <Ionicons name="trending-down" size={16} color={colors.success} />
                                    <Text style={styles.savingsText}>
                                        {t('basketTab.templates.shareSavings', { amount: savings })}
                                    </Text>
                                </View>
                            )}

                            <TouchableOpacity
                                onPress={async () => {
                                    await Clipboard.setStringAsync(data.url);
                                    // Platform-native toast on Android,
                                    // muted inline pill on iOS (no native
                                    // toast). Identical UX intent.
                                    if (Platform.OS === 'android') {
                                        ToastAndroid.show(
                                            t('basketTab.templates.linkCopiedToast'),
                                            ToastAndroid.SHORT,
                                        );
                                    } else {
                                        setCopiedFlash(true);
                                        setTimeout(() => setCopiedFlash(false), 1400);
                                    }
                                }}
                                activeOpacity={0.7}
                            >
                                <Text style={styles.url} numberOfLines={2}>{data.url}</Text>
                            </TouchableOpacity>
                            {Platform.OS !== 'android' && copiedFlash && (
                                <Text style={styles.copiedToast}>
                                    {t('basketTab.templates.linkCopiedToast')}
                                </Text>
                            )}

                            <TouchableOpacity style={styles.primaryBtn} onPress={handleNativeShare}>
                                <Ionicons name="share-social-outline" size={18} color={colors.onPrimary} />
                                <Text style={styles.primaryBtnText}>{t('basketTab.templates.shareNative')}</Text>
                            </TouchableOpacity>

                            <TouchableOpacity style={styles.dangerBtn} onPress={handleRevoke}>
                                <Text style={styles.dangerBtnText}>{t('basketTab.templates.shareRevoke')}</Text>
                            </TouchableOpacity>
                        </>
                    )}
                </Animated.View>
            </TouchableOpacity>
        </Modal>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    sheet: {
        backgroundColor: c.cardBackground,
        borderTopLeftRadius: 24, borderTopRightRadius: 24,
        padding: 20, paddingBottom: 32, gap: 12,
    },
    // Drag area covers a bit of padding above + below the pill so the
    // touch target is generous without changing the visual position.
    handleArea: {
        alignSelf: 'stretch', alignItems: 'center',
        paddingVertical: 8, marginBottom: 4,
    },
    handle: {
        width: 40, height: 4, borderRadius: 2,
        backgroundColor: c.border,
    },
    copiedToast: {
        alignSelf: 'center', backgroundColor: c.textPrimary,
        color: c.cardBackground, fontSize: 12, fontWeight: '600',
        paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6,
        overflow: 'hidden',
    },
    title: { fontSize: 18, fontWeight: '700', color: c.textPrimary, textAlign: 'center' },
    templateName: { fontSize: 14, color: c.textSecondary, textAlign: 'center' },
    center: { alignItems: 'center', padding: 32 },
    errorBox: {
        flexDirection: 'row', gap: 8, alignItems: 'center',
        backgroundColor: c.surfaceMuted, borderRadius: 10, padding: 12,
    },
    errorText: { flex: 1, fontSize: 13, color: c.textPrimary },
    qrWrap: {
        alignItems: 'center', justifyContent: 'center',
        marginTop: 8,
    },
    qrInner: {
        padding: 16, borderRadius: 16,
        backgroundColor: c.cardBackground,
        borderWidth: 1, borderColor: c.border,
    },
    savingsRow: {
        flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center',
    },
    savingsText: { fontSize: 13, fontWeight: '700', color: c.success },
    url: {
        fontSize: 13, color: c.textSecondary, textAlign: 'center',
        backgroundColor: c.surfaceMuted, padding: 10, borderRadius: 10,
    },
    primaryBtn: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
        backgroundColor: c.primary, borderRadius: 10, paddingVertical: 14,
    },
    primaryBtnText: { fontSize: 15, fontWeight: '700', color: c.onPrimary },
    dangerBtn: { alignItems: 'center', paddingVertical: 10 },
    dangerBtnText: { fontSize: 13, fontWeight: '600', color: c.error },
});
