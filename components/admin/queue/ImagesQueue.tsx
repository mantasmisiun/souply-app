import {
    View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView,
    Image, Modal, Pressable, Alert,
} from 'react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../../constants/theme';
import { API_BASE_URL } from '../../../config/api';
import { ProductImage } from '../../ProductImage';
import {
    claimAdminImageBatch,
    getAdminImageQueue,
    adoptImageCandidate,
    removeImage,
    skipImageCard,
    rejectPendingImageUpload,
    revertImageChange,
    type AdminImageQueueRow,
    type AdminImageCandidate,
} from '../../../services/adminClient';

const BATCH_SIZE = 10;

interface Props {
    onEmpty?: () => void;
}

export function ImagesQueue({ onEmpty }: Props) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const [rows, setRows] = useState<AdminImageQueueRow[]>([]);
    const [outstanding, setOutstanding] = useState(0);
    const [loading, setLoading] = useState(true);
    const [actioning, setActioning] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [selectedImageUrl, setSelectedImageUrl] = useState<string | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);

    const currentCard = rows[0] ?? null;
    const currentSelectedCandidate = useMemo(() => {
        if (!currentCard || !selectedImageUrl) return null;
        return currentCard.candidates.find(c => c.imageUrl === selectedImageUrl) ?? null;
    }, [currentCard, selectedImageUrl]);

    useEffect(() => { setSelectedImageUrl(null); }, [currentCard?.spId]);

    const loadQueue = useCallback(async (claimIfEmpty = true) => {
        setLoading(true);
        try {
            let res = await getAdminImageQueue();
            if (res.rows.length === 0 && claimIfEmpty) {
                res = await claimAdminImageBatch(BATCH_SIZE);
            }
            setRows(res.rows);
            setOutstanding(res.outstanding);
        } catch (e) {
            console.warn('[admin/images] queue load failed', e);
        } finally {
            setLoading(false);
        }
    }, []);

    useFocusEffect(useCallback(() => {
        loadQueue();
    }, [loadQueue]));

    useEffect(() => {
        if (!loading && rows.length === 0 && onEmpty) {
            onEmpty();
        }
    }, [loading, rows.length, onEmpty]);

    const advance = useCallback(async () => {
        setRows(prev => prev.slice(1));
    }, []);

    const wrapAction = useCallback(async (op: () => Promise<void>) => {
        if (actioning || !currentCard) return;
        setActioning(true);
        try {
            await op();
            advance();
        } catch (e: any) {
            const msg = String(e?.message ?? '');
            if (msg.includes('429')) {
                Alert.alert(t('admin.images.rateLimitToast'));
            } else {
                Alert.alert(t('admin.images.errorToast'));
            }
        } finally {
            setActioning(false);
        }
    }, [actioning, currentCard, advance, t]);

    const onConfirmAdopt = useCallback(() => {
        if (!currentCard || !currentSelectedCandidate) return;
        const isAdminUpload = (currentSelectedCandidate as any).__adminUpload === true;
        const sourceType = isAdminUpload ? 'admin_upload' : currentSelectedCandidate.sourceType;
        wrapAction(async () => {
            await adoptImageCandidate(currentCard.spId, {
                imageUrl: currentSelectedCandidate.imageUrl,
                sourceType,
                sourceSpId: currentSelectedCandidate.sourceSpId ?? undefined,
                pendingUploadId: isAdminUpload ? undefined : currentSelectedCandidate.pendingUploadId,
            });
        });
    }, [currentCard, currentSelectedCandidate, wrapAction]);

    const onRemove = useCallback(() => {
        if (!currentCard) return;
        wrapAction(() => removeImage(currentCard.spId));
    }, [currentCard, wrapAction]);

    const onSkip = useCallback(() => {
        if (!currentCard) return;
        wrapAction(() => skipImageCard(currentCard.spId));
    }, [currentCard, wrapAction]);

    const onRejectPending = useCallback((cand: AdminImageCandidate) => {
        if (!currentCard || cand.sourceType !== 'pending_upload' || !cand.pendingUploadId) return;
        (async () => {
            if (actioning) return;
            setActioning(true);
            try {
                await rejectPendingImageUpload(currentCard.spId, cand.pendingUploadId!);
                setRows(prev => prev.map((r, i) =>
                    i === 0 ? { ...r, candidates: r.candidates.filter(c => c.imageUrl !== cand.imageUrl) } : r
                ));
                if (selectedImageUrl === cand.imageUrl) setSelectedImageUrl(null);
            } catch (e) {
                Alert.alert(t('admin.images.errorToast'));
            } finally {
                setActioning(false);
            }
        })();
    }, [currentCard, actioning, selectedImageUrl, t]);

    const onUploadOwn = useCallback(async () => {
        if (!currentCard || actioning || uploading) return;
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (perm.status !== 'granted') return;
        const picked = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'] as any,
            quality: 0.9,
        });
        if (picked.canceled || !picked.assets?.length) return;

        setUploading(true);
        try {
            let compressed = await ImageManipulator.manipulateAsync(
                picked.assets[0].uri,
                [{ resize: { width: 900 } }],
                { compress: 0.35, format: ImageManipulator.SaveFormat.JPEG },
            );
            const firstBlob = await (await fetch(compressed.uri)).blob();
            if (firstBlob.size > 350_000) {
                compressed = await ImageManipulator.manipulateAsync(
                    compressed.uri,
                    [{ resize: { width: 640 } }],
                    { compress: 0.25, format: ImageManipulator.SaveFormat.JPEG },
                );
            }

            const uploadUrlRes = await fetch(`${API_BASE_URL}/api/store-products/upload-url`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filename: `admin-${currentCard.spId}-${Date.now()}.jpg`,
                    mimeType: 'image/jpeg',
                }),
            });
            const { uploadUrl, filePath } = await uploadUrlRes.json();
            if (!uploadUrl || !filePath) throw new Error('upload-url bad payload');

            const blob = await (await fetch(compressed.uri)).blob();
            const putRes = await fetch(uploadUrl, {
                method: 'PUT',
                body: blob,
                headers: { 'Content-Type': 'image/jpeg' },
            });
            if (!putRes.ok) throw new Error(`upload ${putRes.status}`);

            setRows(prev => prev.map((r, i) => {
                if (i !== 0) return r;
                const adminCand = {
                    imageUrl: filePath,
                    sourceType: 'pending_upload' as const,
                    sourceSpId: null,
                };
                (adminCand as any).__adminUpload = true;
                return { ...r, candidates: [adminCand, ...r.candidates] };
            }));
            setSelectedImageUrl(filePath);
        } catch (e) {
            console.warn('[admin/images] upload failed', e);
            Alert.alert(t('admin.images.errorToast'));
        } finally {
            setUploading(false);
        }
    }, [currentCard, actioning, uploading, t]);

    const onRevert = useCallback(() => {
        if (!currentCard?.lastPropagation) return;
        const auditId = currentCard.lastPropagation.id;
        Alert.alert(t('admin.audit.revertButton'), `Audit ID: ${auditId}\n${t('admin.auditLogTitle')}`);
    }, [currentCard, t]);

    if (loading) {
        return (
            <View style={styles.centered}>
                <ActivityIndicator size="large" color={colors.primary} />
            </View>
        );
    }
    if (!currentCard) {
        if (onEmpty) return null;
        return (
            <View style={styles.centered}>
                <Ionicons name="checkmark-done-circle-outline" size={56} color={colors.success} />
                <Text style={styles.emptyTitle}>{t('admin.images.emptyTitle')}</Text>
                <Text style={styles.emptyBody}>{t('admin.images.emptyBody')}</Text>
                <TouchableOpacity style={styles.claimBtn} onPress={() => loadQueue()}>
                    <Text style={styles.claimBtnText}>{t('admin.images.claimBatch')}</Text>
                </TouchableOpacity>
            </View>
        );
    }

    const done = BATCH_SIZE - rows.length;

    return (
        <View style={styles.page}>
            <View style={styles.header}>
                <View style={styles.headerLeft}>
                    <Text style={styles.progressText}>
                        {t('admin.images.leaseProgress', { done, total: BATCH_SIZE })}
                    </Text>
                    <Text style={styles.outstandingText}>
                        {t('admin.images.outstanding', { n: outstanding })}
                    </Text>
                </View>
                <TouchableOpacity
                    style={styles.headerSkip}
                    onPress={onSkip}
                    disabled={actioning}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                >
                    <Ionicons name="play-skip-forward" size={18} color={colors.textSecondary} />
                    <Text style={styles.headerSkipText}>{t('admin.images.skipCard')}</Text>
                </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={styles.cardScroll}>
                <View style={styles.card}>
                    <View style={styles.cardHeader}>
                        {currentCard.chainLogoUrl
                            ? <Image source={{ uri: currentCard.chainLogoUrl }} style={styles.chainLogo} resizeMode="contain" />
                            : <View style={[styles.chainLogo, { backgroundColor: colors.surfaceMuted }]} />}
                        <View style={styles.cardHeaderText}>
                            <Text style={styles.cardName} numberOfLines={2}>{currentCard.name}</Text>
                            <Text style={styles.cardMeta}>
                                {currentCard.categoryName} · {currentCard.recentPurchaseCount}
                            </Text>
                        </View>
                    </View>

                    {currentCard.flaggedByUser && (
                        <View style={styles.flagBanner}>
                            <Ionicons name="warning" size={16} color={colors.error} />
                            <Text style={styles.flagBannerText}>
                                {t('admin.images.flagBanner')}
                            </Text>
                        </View>
                    )}

                    <Text style={styles.sectionLabel}>
                        {selectedImageUrl ? t('admin.images.selectedLabel') : t('admin.images.currentLabel')}
                    </Text>
                    <View style={[
                        styles.currentImageWrap,
                        selectedImageUrl && styles.currentImageWrapSelected,
                    ]}>
                        {selectedImageUrl ? (
                            <Image
                                source={{ uri: selectedImageUrl }}
                                style={styles.currentImage}
                                resizeMode="cover"
                            />
                        ) : (
                            <ProductImage
                                uris={currentCard.currentImageUrl}
                                imageStyle={styles.currentImage}
                                placeholderStyle={styles.currentImagePlaceholder}
                                emojiStyle={{ fontSize: 56, opacity: 0.4 }}
                            />
                        )}
                    </View>

                    {currentCard.lastPropagation && (
                        <TouchableOpacity style={styles.propagationBanner} onPress={onRevert}>
                            <Ionicons name="time-outline" size={14} color={colors.textSecondary} />
                            <Text style={styles.propagationText} numberOfLines={2}>
                                {currentCard.lastPropagation.actor === 'auto'
                                    ? t('admin.images.lastPropagationAuto', {
                                          source: currentCard.lastPropagation.sourceType,
                                          ago: timeAgo(currentCard.lastPropagation.createdAt),
                                      })
                                    : t('admin.images.lastPropagationAdmin', {
                                          ago: timeAgo(currentCard.lastPropagation.createdAt),
                                      })}
                            </Text>
                            <Text style={styles.propagationLink}>{t('admin.images.revert')}</Text>
                        </TouchableOpacity>
                    )}

                    <Text style={styles.sectionLabel}>{t('admin.images.candidatesLabel')}</Text>
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.candidatesRow}
                    >
                        <View style={styles.candidateWrap}>
                            <Pressable
                                style={[
                                    styles.candidateImage,
                                    styles.uploadCandidate,
                                    uploading && styles.uploadCandidateBusy,
                                ]}
                                onPress={onUploadOwn}
                                disabled={uploading || actioning}
                            >
                                {uploading ? (
                                    <ActivityIndicator color={colors.primary} />
                                ) : (
                                    <Ionicons name="add" size={36} color={colors.primary} />
                                )}
                            </Pressable>
                            <Text style={styles.candidateLabel} numberOfLines={2}>
                                {uploading ? t('admin.images.uploading') : t('admin.images.uploadOwn')}
                            </Text>
                        </View>

                        {currentCard.candidates.map((cand) => {
                            const isSelected = selectedImageUrl === cand.imageUrl;
                            return (
                                <View key={cand.imageUrl} style={styles.candidateWrap}>
                                    <Pressable
                                        onPress={() => setSelectedImageUrl(cand.imageUrl)}
                                        onLongPress={() => setPreviewUrl(cand.imageUrl)}
                                    >
                                        <Image
                                            source={{ uri: cand.imageUrl }}
                                            style={[
                                                styles.candidateImage,
                                                isSelected && styles.candidateImageSelected,
                                            ]}
                                            resizeMode="cover"
                                        />
                                    </Pressable>
                                    <Text style={styles.candidateLabel} numberOfLines={2}>
                                        {labelFor(cand, t)}
                                    </Text>
                                    {cand.sourceType === 'pending_upload' && (
                                        <TouchableOpacity
                                            style={styles.rejectMini}
                                            onPress={() => onRejectPending(cand)}
                                            disabled={actioning}
                                        >
                                            <Text style={styles.rejectMiniText}>
                                                {t('admin.images.rejectPending')}
                                            </Text>
                                        </TouchableOpacity>
                                    )}
                                </View>
                            );
                        })}
                    </ScrollView>
                </View>
            </ScrollView>

            <View style={styles.footer}>
                <TouchableOpacity
                    style={[
                        styles.primaryBtn,
                        !currentSelectedCandidate && styles.primaryBtnDisabled,
                    ]}
                    onPress={onConfirmAdopt}
                    disabled={!currentSelectedCandidate || actioning}
                >
                    <Text style={styles.primaryBtnText}>{t('admin.images.confirmAdopt')}</Text>
                </TouchableOpacity>
            </View>

            <Modal visible={!!previewUrl} transparent animationType="fade" onRequestClose={() => setPreviewUrl(null)}>
                <Pressable style={styles.previewBackdrop} onPress={() => setPreviewUrl(null)}>
                    {previewUrl && <Image source={{ uri: previewUrl }} style={styles.fullscreenPreviewImage} resizeMode="contain" />}
                </Pressable>
            </Modal>
        </View>
    );
}

function labelFor(cand: AdminImageCandidate, t: ReturnType<typeof useTranslation>['t']): string {
    if (cand.sourceType === 'cross_chain_sibling') {
        return t('admin.images.sourceCrossChain', { chain: cand.sourceChainName ?? '' });
    }
    if (cand.sourceType === 'base_product_link') {
        return t('admin.images.sourceLink', { chain: cand.sourceChainName ?? '' });
    }
    return t('admin.images.sourcePending');
}

function timeAgo(iso: string): string {
    const d = new Date(iso);
    const diffMin = Math.max(1, Math.round((Date.now() - d.getTime()) / 60000));
    if (diffMin < 60) return `${diffMin}m`;
    const diffH = Math.round(diffMin / 60);
    if (diffH < 24) return `${diffH}h`;
    return `${Math.round(diffH / 24)}d`;
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    page: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12, backgroundColor: c.pageBackground },
    emptyTitle: { fontSize: 18, fontWeight: '700', color: c.textPrimary, marginTop: 8 },
    emptyBody: { fontSize: 14, color: c.textSecondary, textAlign: 'center' },
    claimBtn: { backgroundColor: c.primary, paddingVertical: 12, paddingHorizontal: 32, borderRadius: 12, marginTop: 12 },
    claimBtnText: { color: c.onPrimary, fontSize: 15, fontWeight: '700' },

    header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, paddingBottom: 8 },
    headerLeft: { flex: 1 },
    progressText: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
    outstandingText: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    headerSkip: {
        flexDirection: 'row', alignItems: 'center', gap: 4,
        paddingVertical: 6, paddingHorizontal: 10,
        borderRadius: 8, backgroundColor: c.surfaceMuted,
    },
    headerSkipText: { fontSize: 13, color: c.textSecondary, fontWeight: '600' },

    cardScroll: { padding: 12, paddingBottom: 24 },
    card: { backgroundColor: c.cardBackground, borderRadius: 16, padding: 16, gap: 12 },
    cardHeader: { flexDirection: 'row', gap: 12, alignItems: 'center' },
    chainLogo: { width: 32, height: 32, borderRadius: 16 },
    cardHeaderText: { flex: 1 },
    cardName: { fontSize: 16, fontWeight: '700', color: c.textPrimary },
    cardMeta: { fontSize: 12, color: c.textSecondary, marginTop: 2 },

    flagBanner: {
        flexDirection: 'row', alignItems: 'center', gap: 8,
        backgroundColor: c.error + '15',
        borderColor: c.error, borderWidth: 1, borderRadius: 10, padding: 10,
    },
    flagBannerText: { color: c.error, fontSize: 13, flex: 1 },

    sectionLabel: { fontSize: 12, fontWeight: '600', color: c.textMuted, textTransform: 'uppercase' },

    currentImageWrap: {
        alignSelf: 'center', width: 160, height: 160,
        backgroundColor: c.surfaceMuted, borderRadius: 12, overflow: 'hidden',
        alignItems: 'center', justifyContent: 'center',
        borderWidth: 2, borderColor: 'transparent',
    },
    currentImageWrapSelected: { borderColor: c.primary },
    currentImage: { width: '100%', height: '100%' },
    currentImagePlaceholder: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },

    propagationBanner: {
        flexDirection: 'row', alignItems: 'center', gap: 6,
        backgroundColor: c.surfaceMuted, borderRadius: 8, padding: 8,
    },
    propagationText: { flex: 1, fontSize: 11, color: c.textSecondary },
    propagationLink: { fontSize: 11, color: c.primary, fontWeight: '600' },

    candidatesRow: { gap: 12, paddingVertical: 4 },
    candidateWrap: { width: 100, alignItems: 'center', gap: 4 },
    candidateImage: { width: 100, height: 100, borderRadius: 10, borderWidth: 2, borderColor: 'transparent' },
    candidateImageSelected: { borderColor: c.primary },
    uploadCandidate: {
        backgroundColor: c.surfaceMuted, borderColor: c.primary, borderStyle: 'dashed',
        alignItems: 'center', justifyContent: 'center',
    },
    uploadCandidateBusy: { opacity: 0.6 },
    candidateLabel: { fontSize: 10, color: c.textSecondary, textAlign: 'center' },
    rejectMini: { paddingVertical: 2, paddingHorizontal: 8, borderRadius: 6, borderWidth: 1, borderColor: c.border },
    rejectMiniText: { fontSize: 10, color: c.textSecondary },

    footer: { padding: 12, backgroundColor: c.cardBackground, borderTopWidth: 1, borderTopColor: c.borderSubtle, gap: 8 },
    primaryBtn: { backgroundColor: c.primary, paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
    primaryBtnDisabled: { backgroundColor: c.surfaceMuted },
    primaryBtnText: { color: c.onPrimary, fontSize: 16, fontWeight: '700' },

    previewBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', alignItems: 'center', justifyContent: 'center' },
    fullscreenPreviewImage: { width: '90%', height: '70%' },
});
