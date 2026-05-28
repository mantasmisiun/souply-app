import {
    View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView,
    Image, Pressable, TextInput, Alert,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { useTheme, type AppTheme } from '../../../constants/theme';
import { API_BASE_URL } from '../../../config/api';
import {
    claimAdminFlagBatch,
    getAdminFlagQueue,
    confirmAdminFlag,
    dismissAdminFlag,
    skipAdminFlag,
    adoptImageCandidate,
    fetchFlaggedReceiptCrop,
    searchAdminProducts,
    searchAdminCategories,
    type AdminFlagQueueRow,
    type AdminImageCandidate,
    type AdminProductSearchRow,
    type AdminCategorySearchRow,
    type CanonicalUnit,
    type ConfirmFlagPayload,
} from '../../../services/adminClient';

const BATCH_SIZE = 10;
const UNITS: CanonicalUnit[] = ['g', 'kg', 'ml', 'l', 'vnt', 'rit'];

type CropState =
    | { status: 'loading' }
    | { status: 'ready'; uri: string }
    | { status: 'missing' }
    | { status: 'error'; message: string };

function blobToDataUri(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const r = reader.result;
            if (typeof r === 'string') resolve(r);
            else reject(new Error('FileReader returned non-string'));
        };
        reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
        reader.readAsDataURL(blob);
    });
}

interface Props {
    onEmpty?: () => void;
}

export function FlagsQueue({ onEmpty }: Props) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);

    const [rows, setRows] = useState<AdminFlagQueueRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [actioning, setActioning] = useState(false);

    const [ocrInput, setOcrInput] = useState('');
    const [productInput, setProductInput] = useState('');
    const [productPickedId, setProductPickedId] = useState<number | null>(null);
    const [productSuggestions, setProductSuggestions] = useState<AdminProductSearchRow[]>([]);
    const [productSearchOpen, setProductSearchOpen] = useState(false);
    const [categoryInput, setCategoryInput] = useState('');
    const [categoryPickedId, setCategoryPickedId] = useState<number | null>(null);
    const [categorySuggestions, setCategorySuggestions] = useState<AdminCategorySearchRow[]>([]);
    const [categorySearchOpen, setCategorySearchOpen] = useState(false);
    const [amountInput, setAmountInput] = useState('');
    const [unitInput, setUnitInput] = useState<CanonicalUnit>('g');
    const [isWeighable, setIsWeighable] = useState(false);
    const [priceEditing, setPriceEditing] = useState(false);
    const [priceInput, setPriceInput] = useState('');
    type DiscountMode = 'keep' | 'editing' | 'removing';
    const [discountMode, setDiscountMode] = useState<DiscountMode>('keep');
    const [discountInput, setDiscountInput] = useState('');

    const [selectedImageUrl, setSelectedImageUrl] = useState<string | null>(null);
    const [extraCandidates, setExtraCandidates] = useState<AdminImageCandidate[]>([]);
    const [uploading, setUploading] = useState(false);

    const [crop, setCrop] = useState<CropState>({ status: 'loading' });
    const [cropAspect, setCropAspect] = useState<number | null>(null);

    const currentCard = rows[0] ?? null;

    useEffect(() => {
        if (!currentCard) {
            setCrop({ status: 'loading' });
            return;
        }
        setOcrInput(currentCard.sp.storeProductName ?? '');
        setProductInput(currentCard.productName);
        setProductPickedId(currentCard.productId);
        setProductSuggestions([]);
        setProductSearchOpen(false);
        setCategoryInput(currentCard.categoryName ?? '');
        setCategoryPickedId(currentCard.categoryId);
        setCategorySuggestions([]);
        setCategorySearchOpen(false);
        setAmountInput(currentCard.sp.amount !== null ? String(currentCard.sp.amount) : '');
        setUnitInput((currentCard.sp.unit as CanonicalUnit) ?? 'g');
        setIsWeighable(currentCard.sp.isWeighable);
        setPriceEditing(false);
        setPriceInput(currentCard.receiptPrice.price !== null ? String(currentCard.receiptPrice.price) : '');
        setDiscountMode('keep');
        setDiscountInput(currentCard.receiptPrice.promoPrice !== null ? String(currentCard.receiptPrice.promoPrice) : '');
        setSelectedImageUrl(currentCard.sp.imageUrl ?? null);
        setExtraCandidates([]);
        setUploading(false);
        setCropAspect(null);

        setCrop({ status: 'loading' });
        let cancelled = false;
        (async () => {
            try {
                const res = await fetchFlaggedReceiptCrop(currentCard.receiptId, currentCard.lineIdx);
                if (cancelled) return;
                if (!res) { setCrop({ status: 'missing' }); return; }
                const uri = await blobToDataUri(res.blob);
                if (cancelled) return;
                setCrop({ status: 'ready', uri });
            } catch (e: any) {
                console.warn('[admin/flags] receipt crop fetch failed', e);
                if (cancelled) return;
                setCrop({ status: 'error', message: String(e?.message ?? 'fetch failed') });
            }
        })();
        return () => { cancelled = true; };
    }, [currentCard?.flagKey]);

    useEffect(() => {
        if (!productSearchOpen) return;
        const picked = productSuggestions.find(s => s.id === productPickedId)
            ?? (currentCard && productPickedId === currentCard.productId ? { name: currentCard.productName } : null);
        if (picked && productInput.trim() === picked.name.trim()) { setProductSuggestions([]); return; }
        const q = productInput.trim();
        if (q.length === 0) { setProductSuggestions([]); return; }
        const timer = setTimeout(async () => {
            try {
                const r = await searchAdminProducts(q, 8);
                setProductSuggestions(r);
            } catch (e) {
                console.warn('[admin/flags] product search failed', e);
            }
        }, 220);
        return () => clearTimeout(timer);
    }, [productInput, productSearchOpen, productPickedId, currentCard]);

    useEffect(() => {
        if (!categorySearchOpen) return;
        const picked = categorySuggestions.find(s => s.id === categoryPickedId)
            ?? (currentCard && categoryPickedId === currentCard.categoryId ? { name: currentCard.categoryName } : null);
        if (picked && categoryInput.trim() === picked.name.trim()) { setCategorySuggestions([]); return; }
        const q = categoryInput.trim();
        if (q.length === 0) { setCategorySuggestions([]); return; }
        const timer = setTimeout(async () => {
            try {
                const r = await searchAdminCategories(q);
                setCategorySuggestions(r);
            } catch (e) {
                console.warn('[admin/flags] category search failed', e);
            }
        }, 220);
        return () => clearTimeout(timer);
    }, [categoryInput, categorySearchOpen, categoryPickedId, currentCard]);

    const loadQueue = useCallback(async (claimIfEmpty = true) => {
        setLoading(true);
        try {
            let res = await getAdminFlagQueue();
            if (res.rows.length === 0 && claimIfEmpty) {
                res = await claimAdminFlagBatch(BATCH_SIZE);
            }
            setRows(res.rows);
        } catch (e) {
            console.warn('[admin/flags] queue load failed', e);
        } finally {
            setLoading(false);
        }
    }, []);

    useFocusEffect(useCallback(() => { loadQueue(); }, [loadQueue]));

    useEffect(() => {
        if (!loading && rows.length === 0 && onEmpty) {
            onEmpty();
        }
    }, [loading, rows.length, onEmpty]);

    const advance = useCallback(() => {
        setRows(prev => prev.slice(1));
    }, []);

    const onUploadOwn = useCallback(async () => {
        if (!currentCard || actioning || uploading) return;
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (perm.status !== 'granted') return;
        const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'] as any, quality: 0.9 });
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
                body: JSON.stringify({ filename: `admin-flag-${currentCard.spId}-${Date.now()}.jpg`, mimeType: 'image/jpeg' }),
            });
            const { uploadUrl, filePath } = await uploadUrlRes.json();
            if (!uploadUrl || !filePath) throw new Error('upload-url bad payload');
            const blob = await (await fetch(compressed.uri)).blob();
            const putRes = await fetch(uploadUrl, { method: 'PUT', body: blob, headers: { 'Content-Type': 'image/jpeg' } });
            if (!putRes.ok) throw new Error(`upload ${putRes.status}`);
            const adminCand: AdminImageCandidate = { imageUrl: filePath, sourceType: 'pending_upload', sourceSpId: null };
            (adminCand as any).__adminUpload = true;
            setExtraCandidates(prev => [adminCand, ...prev]);
            setSelectedImageUrl(filePath);
        } catch (e) {
            console.warn('[admin/flags] upload failed', e);
            Alert.alert(t('admin.flags.errorToast'));
        } finally {
            setUploading(false);
        }
    }, [currentCard, actioning, uploading, t]);

    const buildConfirmPayload = (card: AdminFlagQueueRow): ConfirmFlagPayload => {
        const sp: ConfirmFlagPayload['sp'] = {};
        const trimmedOcr = ocrInput.trim();
        const currentOcr = (card.sp.storeProductName ?? '').trim();
        if (trimmedOcr.length > 0 && trimmedOcr !== currentOcr) sp.storeProductName = trimmedOcr;
        const amountNum = parseFloat(amountInput.replace(',', '.'));
        if (Number.isFinite(amountNum) && amountNum > 0 && amountNum !== card.sp.amount) sp.amount = amountNum;
        if (unitInput !== card.sp.unit) sp.unit = unitInput;
        const canToggleWeighable = unitInput === 'kg' && amountInput.replace(',', '.').trim() === '1';
        if (canToggleWeighable && isWeighable !== card.sp.isWeighable) sp.isWeighable = isWeighable;

        const payload: ConfirmFlagPayload = {};
        if (Object.keys(sp).length > 0) payload.sp = sp;

        const trimmedProduct = productInput.trim();
        if (trimmedProduct.length > 0 && trimmedProduct !== card.productName.trim()) {
            if (productPickedId !== null && productPickedId !== card.productId) {
                payload.productLink = { mode: 'pick', productId: productPickedId };
            } else if (productPickedId === null) {
                payload.productLink = { mode: 'create', name: trimmedProduct };
            }
        } else if (productPickedId !== null && productPickedId !== card.productId) {
            payload.productLink = { mode: 'pick', productId: productPickedId };
        }
        if (categoryPickedId !== null && categoryPickedId !== card.categoryId) payload.categoryId = categoryPickedId;

        const receiptPrice: ConfirmFlagPayload['receiptPrice'] = {};
        if (priceEditing) {
            const n = parseFloat(priceInput.replace(',', '.'));
            if (Number.isFinite(n) && n >= 0 && n !== card.receiptPrice.price) receiptPrice.price = n;
        }
        if (discountMode === 'removing') {
            receiptPrice.promoPrice = null;
        } else if (discountMode === 'editing') {
            const n = parseFloat(discountInput.replace(',', '.'));
            if (Number.isFinite(n) && n >= 0 && n !== card.receiptPrice.promoPrice) receiptPrice.promoPrice = n;
        }
        if (Object.keys(receiptPrice).length > 0) payload.receiptPrice = receiptPrice;
        return payload;
    };

    const onConfirm = useCallback(async () => {
        if (!currentCard || actioning) return;
        const payload = buildConfirmPayload(currentCard);
        const allCandidates: AdminImageCandidate[] = [...extraCandidates, ...currentCard.imageCandidates];
        const currentImg = currentCard.sp.imageUrl ?? null;
        const imageChanged = selectedImageUrl !== currentImg;
        const chosen = imageChanged ? allCandidates.find(c => c.imageUrl === selectedImageUrl) ?? null : null;

        setActioning(true);
        try {
            if (chosen) {
                const isAdminUpload = (chosen as any).__adminUpload === true;
                await adoptImageCandidate(currentCard.spId, {
                    imageUrl: chosen.imageUrl,
                    sourceType: isAdminUpload ? 'admin_upload' : chosen.sourceType,
                    sourceSpId: chosen.sourceSpId ?? undefined,
                    pendingUploadId: isAdminUpload ? undefined : chosen.pendingUploadId,
                });
            }
            const outcome = await confirmAdminFlag(currentCard.flagKey, payload);
            if (outcome === 'duplicate_size') {
                Alert.alert(t('admin.flags.duplicateSizeToast'));
                return;
            }
            advance();
        } catch (e: any) {
            const msg = String(e?.message ?? '');
            Alert.alert(msg.includes('429') ? t('admin.flags.rateLimitToast') : t('admin.flags.errorToast'));
        } finally {
            setActioning(false);
        }
    }, [currentCard, actioning, ocrInput, productInput, productPickedId, categoryPickedId, amountInput, unitInput, isWeighable, priceEditing, priceInput, discountMode, discountInput, selectedImageUrl, extraCandidates, advance, t]);

    const onDismiss = useCallback(async () => {
        if (!currentCard || actioning) return;
        setActioning(true);
        try {
            await dismissAdminFlag(currentCard.flagKey);
            advance();
        } catch {
            Alert.alert(t('admin.flags.errorToast'));
        } finally {
            setActioning(false);
        }
    }, [currentCard, actioning, advance, t]);

    const onSkip = useCallback(async () => {
        if (!currentCard || actioning) return;
        setActioning(true);
        try {
            await skipAdminFlag(currentCard.flagKey);
            advance();
        } catch {
            Alert.alert(t('admin.flags.errorToast'));
        } finally {
            setActioning(false);
        }
    }, [currentCard, actioning, advance, t]);

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
                <Text style={styles.emptyTitle}>{t('admin.flags.emptyTitle')}</Text>
                <Text style={styles.emptyBody}>{t('admin.flags.emptyBody')}</Text>
                <TouchableOpacity style={styles.claimBtn} onPress={() => loadQueue()}>
                    <Text style={styles.claimBtnText}>{t('admin.flags.claimBatch')}</Text>
                </TouchableOpacity>
            </View>
        );
    }

    const done = BATCH_SIZE - rows.length;
    const flagged = currentCard.flagged;
    const canToggleWeighable = unitInput === 'kg' && amountInput.replace(',', '.').trim() === '1';

    return (
        <View style={styles.page}>
            <View style={styles.header}>
                <Text style={styles.progressText}>
                    {t('admin.flags.leaseProgress', { done, total: BATCH_SIZE })}
                </Text>
                <TouchableOpacity
                    style={styles.headerSkip}
                    onPress={onSkip}
                    disabled={actioning}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                >
                    <Ionicons name="play-skip-forward" size={18} color={colors.textSecondary} />
                    <Text style={styles.headerSkipText}>{t('admin.flags.skip')}</Text>
                </TouchableOpacity>
            </View>

            <KeyboardAwareScrollView contentContainerStyle={styles.cardScroll} keyboardShouldPersistTaps="handled" bottomOffset={72}>
                <View style={styles.card}>
                    <View style={styles.cardHeader}>
                        {currentCard.chainLogoUrl
                            ? <Image source={{ uri: currentCard.chainLogoUrl }} style={styles.chainLogo} resizeMode="contain" />
                            : <View style={[styles.chainLogo, { backgroundColor: colors.surfaceMuted }]} />}
                        <View style={styles.cardHeaderText}>
                            <Text style={styles.cardName} numberOfLines={2}>{currentCard.sp.name}</Text>
                            <Text style={styles.cardMeta}>
                                {currentCard.categoryName} · {t('admin.flags.userCount', { count: currentCard.userCount })}
                            </Text>
                        </View>
                    </View>

                    <Text style={styles.sectionLabel}>{t('admin.flags.receiptCropTitle')}</Text>
                    {crop.status === 'ready' ? (
                        <Image
                            source={{ uri: crop.uri }}
                            style={[styles.cropImage, { aspectRatio: cropAspect ?? undefined }]}
                            resizeMode="contain"
                            onLoad={(e) => {
                                const { width, height } = e.nativeEvent.source;
                                if (width > 0 && height > 0) setCropAspect(width / height);
                            }}
                        />
                    ) : crop.status === 'loading' ? (
                        <View style={[styles.cropFallback, styles.cropFallbackPlaceholder]}>
                            <ActivityIndicator size="small" color={colors.primary} />
                        </View>
                    ) : (
                        <View style={[styles.cropFallback, styles.cropFallbackPlaceholder]}>
                            <Text style={styles.cropFallbackText}>
                                {crop.status === 'missing' ? t('admin.flags.receiptCropMissing') : crop.message}
                            </Text>
                        </View>
                    )}

                    <Section styles={styles} title={t('admin.flags.sectionOcr')} flagged={false} flaggedLabel="">
                        <TextInput
                            style={styles.textInput}
                            value={ocrInput}
                            onChangeText={setOcrInput}
                            placeholder="—"
                            placeholderTextColor={colors.textMuted}
                        />
                    </Section>

                    <Section styles={styles} title={t('admin.flags.sectionName')} flagged={flagged.name} flaggedLabel={t('admin.flags.flaggedPill')}>
                        <View style={styles.typeaheadRow}>
                            <TextInput
                                style={[styles.textInput, styles.typeaheadInput]}
                                value={productInput}
                                onChangeText={(text) => {
                                    setProductInput(text);
                                    setProductSearchOpen(true);
                                    if (currentCard.productName.trim() === text.trim()) {
                                        setProductPickedId(currentCard.productId);
                                    } else {
                                        setProductPickedId(null);
                                    }
                                }}
                                onFocus={() => setProductSearchOpen(true)}
                            />
                            {productSearchOpen && (
                                <TouchableOpacity
                                    style={styles.typeaheadLockBtn}
                                    onPress={() => { setProductSearchOpen(false); setProductSuggestions([]); }}
                                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                >
                                    <Ionicons name="checkmark" size={18} color={colors.primary} />
                                </TouchableOpacity>
                            )}
                        </View>
                        {productSearchOpen && productSuggestions.length > 0 && (
                            <View style={styles.suggestionList}>
                                {productSuggestions.map((s) => (
                                    <TouchableOpacity
                                        key={s.id}
                                        style={styles.suggestionRow}
                                        onPress={() => {
                                            setProductInput(s.name);
                                            setProductPickedId(s.id);
                                            setProductSearchOpen(false);
                                            setProductSuggestions([]);
                                            if (s.categoryId !== null) {
                                                setCategoryPickedId(s.categoryId);
                                                setCategoryInput(s.categoryName ?? '');
                                            }
                                        }}
                                    >
                                        <Text style={styles.suggestionText} numberOfLines={1}>{s.name}</Text>
                                        {s.categoryName && <Text style={styles.suggestionMeta} numberOfLines={1}>{s.categoryName}</Text>}
                                    </TouchableOpacity>
                                ))}
                            </View>
                        )}
                        {(() => {
                            const trimmed = productInput.trim();
                            const unchanged = trimmed === currentCard.productName.trim() && productPickedId === currentCard.productId;
                            if (unchanged) return null;
                            if (productPickedId !== null) return <Text style={styles.actionHint}>{t('admin.flags.willRelink')}</Text>;
                            if (trimmed.length > 0) return <Text style={styles.actionHint}>{t('admin.flags.willCreate', { name: trimmed })}</Text>;
                            return null;
                        })()}
                    </Section>

                    <Section styles={styles} title={t('admin.flags.sectionCategory')} flagged={false} flaggedLabel="">
                        <View style={styles.typeaheadRow}>
                            <TextInput
                                style={[styles.textInput, styles.typeaheadInput]}
                                value={categoryInput}
                                onChangeText={(text) => {
                                    setCategoryInput(text);
                                    setCategorySearchOpen(true);
                                    if ((currentCard.categoryName ?? '').trim() === text.trim()) {
                                        setCategoryPickedId(currentCard.categoryId);
                                    } else {
                                        setCategoryPickedId(null);
                                    }
                                }}
                                onFocus={() => setCategorySearchOpen(true)}
                                placeholder={t('admin.flags.categoryPlaceholder')}
                                placeholderTextColor={colors.textMuted}
                            />
                            {categorySearchOpen && (
                                <TouchableOpacity
                                    style={styles.typeaheadLockBtn}
                                    onPress={() => { setCategorySearchOpen(false); setCategorySuggestions([]); }}
                                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                >
                                    <Ionicons name="checkmark" size={18} color={colors.primary} />
                                </TouchableOpacity>
                            )}
                        </View>
                        {categorySearchOpen && categorySuggestions.length > 0 && (
                            <View style={styles.suggestionList}>
                                {categorySuggestions.map((s) => (
                                    <TouchableOpacity
                                        key={s.id}
                                        style={styles.suggestionRow}
                                        onPress={() => {
                                            setCategoryInput(s.name);
                                            setCategoryPickedId(s.id);
                                            setCategorySearchOpen(false);
                                            setCategorySuggestions([]);
                                        }}
                                    >
                                        <Text style={styles.suggestionText} numberOfLines={1}>{s.name}</Text>
                                        <Text style={styles.suggestionMeta} numberOfLines={1}>{s.path}</Text>
                                    </TouchableOpacity>
                                ))}
                            </View>
                        )}
                    </Section>

                    <Section styles={styles} title={t('admin.flags.sectionAmount')} flagged={flagged.amount} flaggedLabel={t('admin.flags.flaggedPill')}>
                        <View style={styles.amountUnitRow}>
                            <View style={styles.amountWrap}>
                                <Text style={styles.fieldLabel}>{t('admin.flags.amountField')}</Text>
                                <TextInput
                                    style={styles.amountInput}
                                    value={amountInput}
                                    onChangeText={setAmountInput}
                                    keyboardType="decimal-pad"
                                    placeholder="0"
                                    placeholderTextColor={colors.textMuted}
                                />
                            </View>
                            <View style={styles.unitWrap}>
                                <Text style={styles.fieldLabel}>{t('admin.flags.unitField')}</Text>
                                <View style={styles.unitChipsRow}>
                                    {UNITS.map(u => {
                                        const selected = u === unitInput;
                                        return (
                                            <TouchableOpacity
                                                key={u}
                                                style={[styles.unitChip, selected && styles.unitChipSelected]}
                                                onPress={() => setUnitInput(u)}
                                            >
                                                <Text style={[styles.unitChipText, selected && styles.unitChipTextSelected]}>{u}</Text>
                                            </TouchableOpacity>
                                        );
                                    })}
                                </View>
                            </View>
                        </View>
                        {canToggleWeighable && (
                            <Checkbox
                                styles={styles}
                                colors={colors}
                                checked={isWeighable}
                                onToggle={() => setIsWeighable(v => !v)}
                                label={t('admin.flags.weighable')}
                            />
                        )}
                    </Section>

                    <Section styles={styles} title={t('admin.flags.sectionImage')} flagged={flagged.image} flaggedLabel={t('admin.flags.flaggedPill')}>
                        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.candidatesRow}>
                            <View style={styles.candidateWrap}>
                                <Pressable
                                    style={[styles.candidateImage, styles.uploadCandidate, uploading && styles.uploadCandidateBusy]}
                                    onPress={onUploadOwn}
                                    disabled={uploading || actioning}
                                >
                                    {uploading ? <ActivityIndicator color={colors.primary} /> : <Ionicons name="add" size={32} color={colors.primary} />}
                                </Pressable>
                                <Text style={styles.candidateLabel} numberOfLines={2}>
                                    {uploading ? t('admin.flags.imageUploading') : t('admin.flags.imageUpload')}
                                </Text>
                            </View>

                            <View style={styles.candidateWrap}>
                                <Pressable onPress={() => setSelectedImageUrl(currentCard.sp.imageUrl ?? null)}>
                                    {currentCard.sp.imageUrl ? (
                                        <Image
                                            source={{ uri: currentCard.sp.imageUrl }}
                                            style={[styles.candidateImage, selectedImageUrl === currentCard.sp.imageUrl && styles.candidateImageSelected]}
                                            resizeMode="cover"
                                        />
                                    ) : (
                                        <View style={[styles.candidateImage, styles.candidateImagePlaceholder, selectedImageUrl === null && styles.candidateImageSelected]}>
                                            <Ionicons name="image-outline" size={28} color={colors.textMuted} />
                                        </View>
                                    )}
                                </Pressable>
                                <Text style={styles.candidateLabel} numberOfLines={2}>{t('admin.flags.imageCurrent')}</Text>
                            </View>

                            {[...extraCandidates, ...currentCard.imageCandidates].map((cand) => (
                                <View key={cand.imageUrl} style={styles.candidateWrap}>
                                    <Pressable onPress={() => setSelectedImageUrl(cand.imageUrl)}>
                                        <Image
                                            source={{ uri: cand.imageUrl }}
                                            style={[styles.candidateImage, selectedImageUrl === cand.imageUrl && styles.candidateImageSelected]}
                                            resizeMode="cover"
                                        />
                                    </Pressable>
                                    <Text style={styles.candidateLabel} numberOfLines={2}>{labelForCandidate(cand, t)}</Text>
                                </View>
                            ))}
                        </ScrollView>
                    </Section>

                    <Section styles={styles} title={t('admin.flags.sectionPrice')} flagged={flagged.price} flaggedLabel={t('admin.flags.flaggedPill')}>
                        {priceEditing ? (
                            <View style={styles.priceRow}>
                                <Text style={styles.priceLabel}>{t('admin.flags.priceLabel')}</Text>
                                <View style={styles.priceEditWrap}>
                                    <TextInput style={styles.priceInput} value={priceInput} onChangeText={setPriceInput} keyboardType="decimal-pad" placeholder="0,00" placeholderTextColor={colors.textMuted} autoFocus />
                                    <TouchableOpacity style={styles.priceIconBtn} onPress={() => setPriceEditing(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                        <Ionicons name="checkmark" size={18} color={colors.primary} />
                                    </TouchableOpacity>
                                </View>
                            </View>
                        ) : (
                            <View style={styles.priceRow}>
                                <Text style={styles.priceLabel}>{t('admin.flags.priceLabel')}</Text>
                                <View style={styles.priceEditWrap}>
                                    <Text style={styles.priceValue}>
                                        {currentCard.receiptPrice.price !== null ? `€${currentCard.receiptPrice.price.toFixed(2)}` : '—'}
                                    </Text>
                                    <TouchableOpacity style={styles.priceIconBtn} onPress={() => setPriceEditing(true)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                        <Ionicons name="pencil" size={16} color={colors.textSecondary} />
                                    </TouchableOpacity>
                                </View>
                            </View>
                        )}
                    </Section>

                    <Section styles={styles} title={t('admin.flags.sectionDiscount')} flagged={flagged.discount} flaggedLabel={t('admin.flags.flaggedPill')}>
                        {(() => {
                            const original = currentCard.receiptPrice.promoPrice;
                            if (discountMode === 'removing') {
                                return (
                                    <View style={styles.priceRow}>
                                        <Text style={styles.priceLabel}>{t('admin.flags.promoLabel')}</Text>
                                        <View style={styles.priceEditWrap}>
                                            <Text style={[styles.priceValue, styles.priceValueRemoved]}>
                                                {original !== null ? `€${original.toFixed(2)}` : '—'}
                                            </Text>
                                            <TouchableOpacity style={styles.priceIconBtn} onPress={() => setDiscountMode('keep')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                                <Ionicons name="refresh" size={16} color={colors.textSecondary} />
                                            </TouchableOpacity>
                                        </View>
                                    </View>
                                );
                            }
                            if (discountMode === 'editing') {
                                return (
                                    <View style={styles.priceRow}>
                                        <Text style={styles.priceLabel}>{t('admin.flags.promoLabel')}</Text>
                                        <View style={styles.priceEditWrap}>
                                            <TextInput style={styles.priceInput} value={discountInput} onChangeText={setDiscountInput} keyboardType="decimal-pad" placeholder="0,00" placeholderTextColor={colors.textMuted} autoFocus />
                                            <TouchableOpacity style={styles.priceIconBtn} onPress={() => setDiscountMode('keep')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                                <Ionicons name="checkmark" size={18} color={colors.primary} />
                                            </TouchableOpacity>
                                            {original !== null && (
                                                <TouchableOpacity style={styles.priceIconBtn} onPress={() => setDiscountMode('removing')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                                    <Ionicons name="trash-outline" size={16} color={colors.error} />
                                                </TouchableOpacity>
                                            )}
                                        </View>
                                    </View>
                                );
                            }
                            if (original !== null) {
                                return (
                                    <View style={styles.priceRow}>
                                        <Text style={styles.priceLabel}>{t('admin.flags.promoLabel')}</Text>
                                        <View style={styles.priceEditWrap}>
                                            <Text style={styles.priceValue}>{`€${original.toFixed(2)}`}</Text>
                                            <TouchableOpacity style={styles.priceIconBtn} onPress={() => setDiscountMode('editing')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                                <Ionicons name="pencil" size={16} color={colors.textSecondary} />
                                            </TouchableOpacity>
                                            <TouchableOpacity style={styles.priceIconBtn} onPress={() => setDiscountMode('removing')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                                <Ionicons name="trash-outline" size={16} color={colors.error} />
                                            </TouchableOpacity>
                                        </View>
                                    </View>
                                );
                            }
                            return (
                                <TouchableOpacity style={styles.addDiscountBtn} onPress={() => { setDiscountInput(''); setDiscountMode('editing'); }}>
                                    <Ionicons name="add" size={16} color={colors.primary} />
                                    <Text style={styles.addDiscountText}>{t('admin.flags.addDiscount')}</Text>
                                </TouchableOpacity>
                            );
                        })()}
                    </Section>
                </View>
            </KeyboardAwareScrollView>

            <View style={styles.footer}>
                <TouchableOpacity
                    style={[styles.primaryBtn, actioning && styles.primaryBtnDisabled]}
                    onPress={onConfirm}
                    disabled={actioning}
                >
                    {actioning ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.primaryBtnText}>{t('admin.flags.confirm')}</Text>}
                </TouchableOpacity>
                <TouchableOpacity style={styles.dismissBtn} onPress={onDismiss} disabled={actioning}>
                    <Text style={styles.dismissBtnText}>{t('admin.flags.dismiss')}</Text>
                </TouchableOpacity>
            </View>
        </View>
    );
}

interface SectionProps {
    title: string;
    flagged: boolean;
    flaggedLabel: string;
    children: React.ReactNode;
    styles: ReturnType<typeof makeStyles>;
}

function Section({ title, flagged, flaggedLabel, children, styles }: SectionProps) {
    return (
        <View style={[styles.section, flagged && styles.sectionFlagged]}>
            <View style={styles.sectionHeader}>
                <Text style={[styles.sectionTitle, flagged && styles.sectionTitleFlagged]}>{title}</Text>
                {flagged && <View style={styles.flaggedPill}><Text style={styles.flaggedPillText}>{flaggedLabel}</Text></View>}
            </View>
            {children}
        </View>
    );
}

interface CheckboxProps {
    checked: boolean;
    onToggle: () => void;
    label: string;
    styles: ReturnType<typeof makeStyles>;
    colors: AppTheme;
}

function Checkbox({ checked, onToggle, label, styles, colors }: CheckboxProps) {
    return (
        <TouchableOpacity style={styles.checkboxRow} onPress={onToggle} activeOpacity={0.7}>
            <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                {checked && <Ionicons name="checkmark" size={14} color={colors.onPrimary} />}
            </View>
            <Text style={styles.checkboxLabel}>{label}</Text>
        </TouchableOpacity>
    );
}

function labelForCandidate(c: AdminImageCandidate, t: (k: string, opts?: any) => string): string {
    if ((c as any).__adminUpload === true) return t('admin.flags.imageAdminUpload');
    if (c.sourceType === 'pending_upload') return t('admin.flags.imagePendingUpload');
    return c.sourceChainName
        ? t('admin.flags.imageSourceChain', { chain: c.sourceChainName })
        : t('admin.flags.imageSourceOther');
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    page: { flex: 1, backgroundColor: c.pageBackground },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12, backgroundColor: c.pageBackground },
    emptyTitle: { fontSize: 18, fontWeight: '700', color: c.textPrimary, marginTop: 8 },
    emptyBody: { fontSize: 14, color: c.textSecondary, textAlign: 'center' },
    claimBtn: { backgroundColor: c.primary, paddingVertical: 12, paddingHorizontal: 32, borderRadius: 12, marginTop: 12 },
    claimBtnText: { color: c.onPrimary, fontSize: 15, fontWeight: '700' },

    header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, paddingBottom: 8 },
    progressText: { fontSize: 14, fontWeight: '700', color: c.textPrimary },
    headerSkip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, backgroundColor: c.surfaceMuted },
    headerSkipText: { fontSize: 13, color: c.textSecondary, fontWeight: '600' },

    cardScroll: { padding: 12, paddingBottom: 24 },
    card: { backgroundColor: c.cardBackground, borderRadius: 16, padding: 16, gap: 12 },
    cardHeader: { flexDirection: 'row', gap: 12, alignItems: 'center' },
    chainLogo: { width: 32, height: 32, borderRadius: 16 },
    cardHeaderText: { flex: 1 },
    cardName: { fontSize: 16, fontWeight: '700', color: c.textPrimary },
    cardMeta: { fontSize: 12, color: c.textSecondary, marginTop: 2 },

    sectionLabel: { fontSize: 11, fontWeight: '600', color: c.textMuted, textTransform: 'uppercase', marginTop: 4 },
    cropImage: { width: '100%', borderRadius: 10, backgroundColor: c.surfaceMuted },
    cropFallback: { alignItems: 'center', justifyContent: 'center' },
    cropFallbackPlaceholder: { width: '100%', height: 60, borderRadius: 10, backgroundColor: c.surfaceMuted },
    cropFallbackText: { color: c.textMuted, fontSize: 12 },

    section: { marginTop: 4, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: c.borderSubtle, backgroundColor: c.pageBackground, gap: 8 },
    sectionFlagged: { borderColor: c.primary, borderLeftWidth: 4, backgroundColor: c.primary + '12' },
    sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    sectionTitle: { fontSize: 12, fontWeight: '700', color: c.textSecondary, textTransform: 'uppercase' },
    sectionTitleFlagged: { color: c.primary },
    flaggedPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: c.primary },
    flaggedPillText: { color: c.onPrimary, fontSize: 10, fontWeight: '700' },

    fieldLabel: { fontSize: 12, color: c.textSecondary, marginBottom: 4 },
    textInput: { backgroundColor: c.cardBackground, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: c.textPrimary, borderWidth: 1, borderColor: c.borderSubtle },
    typeaheadRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
    typeaheadInput: { flex: 1 },
    typeaheadLockBtn: { width: 38, height: 38, borderRadius: 8, borderWidth: 1, borderColor: c.primary, backgroundColor: c.primary + '12', alignItems: 'center', justifyContent: 'center' },
    suggestionList: { marginTop: 4, backgroundColor: c.cardBackground, borderRadius: 8, borderWidth: 1, borderColor: c.borderSubtle },
    suggestionRow: { paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.borderSubtle },
    suggestionText: { fontSize: 14, color: c.textPrimary },
    suggestionMeta: { fontSize: 11, color: c.textMuted, marginTop: 2 },
    actionHint: { fontSize: 11, color: c.primary, marginTop: 6, fontStyle: 'italic' },

    amountUnitRow: { gap: 10 },
    amountWrap: {},
    unitWrap: {},
    amountInput: { backgroundColor: c.cardBackground, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, fontWeight: '600', color: c.textPrimary, borderWidth: 1, borderColor: c.borderSubtle },
    unitChipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    unitChip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.cardBackground, minWidth: 48, alignItems: 'center' },
    unitChipSelected: { backgroundColor: c.primary, borderColor: c.primary },
    unitChipText: { fontSize: 13, fontWeight: '600', color: c.textPrimary },
    unitChipTextSelected: { color: c.onPrimary },

    candidatesRow: { gap: 10, paddingVertical: 4 },
    candidateWrap: { width: 84, alignItems: 'center', gap: 4 },
    candidateImage: { width: 84, height: 84, borderRadius: 10, borderWidth: 2, borderColor: 'transparent', backgroundColor: c.surfaceMuted },
    candidateImageSelected: { borderColor: c.primary },
    candidateImagePlaceholder: { alignItems: 'center', justifyContent: 'center' },
    uploadCandidate: { backgroundColor: c.primary + '12', borderColor: c.primary, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center' },
    uploadCandidateBusy: { opacity: 0.6 },
    candidateLabel: { fontSize: 10, color: c.textSecondary, textAlign: 'center' },

    priceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    priceLabel: { fontSize: 13, color: c.textSecondary },
    priceValue: { fontSize: 16, fontWeight: '700', color: c.textPrimary },
    priceValueRemoved: { color: c.textMuted, textDecorationLine: 'line-through' },
    priceEditWrap: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    priceInput: { minWidth: 80, backgroundColor: c.cardBackground, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, fontSize: 16, fontWeight: '600', color: c.textPrimary, borderWidth: 1, borderColor: c.borderSubtle, textAlign: 'right' },
    priceIconBtn: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
    addDiscountBtn: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 4, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: c.primary, borderStyle: 'dashed' },
    addDiscountText: { fontSize: 13, color: c.primary, fontWeight: '600' },

    checkboxRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
    checkbox: { width: 20, height: 20, borderRadius: 6, borderWidth: 1.5, borderColor: c.border, alignItems: 'center', justifyContent: 'center', backgroundColor: c.cardBackground },
    checkboxChecked: { backgroundColor: c.primary, borderColor: c.primary },
    checkboxLabel: { fontSize: 13, color: c.textPrimary, flex: 1 },

    footer: { padding: 12, backgroundColor: c.cardBackground, borderTopWidth: 1, borderTopColor: c.borderSubtle, gap: 8 },
    primaryBtn: { backgroundColor: c.primary, paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
    primaryBtnDisabled: { backgroundColor: c.surfaceMuted },
    primaryBtnText: { color: c.onPrimary, fontSize: 16, fontWeight: '700' },
    dismissBtn: { paddingVertical: 8, alignItems: 'center' },
    dismissBtnText: { color: c.textSecondary, fontSize: 13, textDecorationLine: 'underline' },
});
