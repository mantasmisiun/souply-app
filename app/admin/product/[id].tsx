import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    View,
    Text,
    ScrollView,
    TouchableOpacity,
    StyleSheet,
    Alert,
    Modal,
    TextInput,
    Switch,
    Image,
    Pressable,
    Dimensions,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../../constants/theme';
import { ProductImage } from '../../../components/ProductImage';
import { SkeletonBox } from '../../../components/SkeletonBox';
import MiniPriceChart, { PriceChartSvg, preparePriceData, filterByRange, timeXPositions, type PricePoint, type RangeKey } from '../../../components/MiniPriceChart';
import { ChainLogoStrip } from '../../../components/ChainLogoStrip';
import { getChainMiniLogoUrl } from '../../../utils/chainBrandName';
import CategoryPickerModal from '../../../components/admin/CategoryPickerModal';
import { Toast, type ToastHandle } from '../../../components/Toast';
import { CardActionBar } from '../../../components/CardActionBar';
import { API_BASE_URL } from '../../../config/api';
import {
    getAdminProductDetail,
    deleteAdminStoreProduct,
    editAdminStoreProduct,
    moveAdminStoreProduct,
    type AdminSpDetail,
    type AdminProductDetail,
    type EditSpPayload,
    type MoveSpPayload,
    adoptImageCandidate,
    type AdminImageCandidate,
} from '../../../services/adminClient';
import { formatEuro, formatAmountStr } from '../../../utils/formatCurrency';

type Unit = 'g' | 'kg' | 'ml' | 'l' | 'vnt' | 'rit';
const UNITS: Unit[] = ['g', 'kg', 'ml', 'l', 'vnt', 'rit'];

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const MODAL_CHART_HEIGHT = 260;
const MODAL_CHART_MIN_WIDTH = SCREEN_WIDTH - 80;
const MODAL_CHART_PADDING = { top: 14, bottom: 18, left: 46, right: 10 };
const shortDate = (d: string) =>
    new Date(d).toLocaleDateString('lt-LT', { month: 'short', day: 'numeric' });

// ── Chart modal (same pattern as user product/[id].tsx) ───────────────────────

function ModalChart({
    prices,
    colors,
    styles,
}: {
    prices: PricePoint[];
    colors: AppTheme;
    styles: ReturnType<typeof makeStyles>;
}) {
    const { t } = useTranslation();
    const [rangeKey, setRangeKey] = useState<RangeKey>('all');
    const [crosshairIndex, setCrosshairIndex] = useState<number | null>(null);
    const crosshairTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const allData = useMemo(() => preparePriceData(prices), [prices]);
    const data = useMemo(() => filterByRange(allData, rangeKey), [allData, rangeKey]);

    const chartWidth = MODAL_CHART_MIN_WIDTH;
    const padding = MODAL_CHART_PADDING;
    const chartW = chartWidth - padding.left - padding.right;
    // Same TIME-scaled positions the SVG draws (domain [first point, now]) — the
    // crosshair must hit-test against where the points actually are.
    const pointXs = useMemo(() => timeXPositions(data, chartW, padding.left), [data, chartW]);

    const handleChartTouch = (x: number) => {
        if (!pointXs.length) return;
        let nearest = 0, minDist = Infinity;
        pointXs.forEach((px, i) => { const d = Math.abs(px - x); if (d < minDist) { minDist = d; nearest = i; } });
        setCrosshairIndex(nearest);
        if (crosshairTimer.current) clearTimeout(crosshairTimer.current);
        crosshairTimer.current = setTimeout(() => setCrosshairIndex(null), 3000);
    };

    const displayIndex = crosshairIndex ?? (data.length > 0 ? data.length - 1 : null);
    const displayPt = displayIndex !== null ? data[displayIndex] : null;

    const RANGE_LABELS: Record<RangeKey, string> = { '1M': '1M', '3M': '3M', '6M': '6M', 'all': t('product.rangeAll') };

    if (data.length === 0) {
        return (
            <View style={styles.chartModalEmpty}>
                <Text style={styles.chartModalEmptyText}>{t('product.noDataForPeriod')}</Text>
            </View>
        );
    }

    return (
        <>
            {displayPt && (
                <View style={styles.chartPriceDisplay}>
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                        {displayPt.promoPrice !== null && displayPt.promoPrice !== undefined ? (
                            <>
                                <Text style={styles.chartDisplayPromo}>{formatEuro(Number(displayPt.promoPrice))}</Text>
                                <Text style={styles.chartDisplayStrike}>{formatEuro(Number(displayPt.price))}</Text>
                            </>
                        ) : (
                            <Text style={styles.chartDisplayPrice}>{formatEuro(Number(displayPt.price))}</Text>
                        )}
                    </View>
                    <Text style={styles.chartDisplayDate}>{shortDate(displayPt.date)}</Text>
                </View>
            )}
            <View style={styles.rangePills}>
                {(['1M', '3M', '6M', 'all'] as RangeKey[]).map(key => (
                    <TouchableOpacity
                        key={key}
                        style={[styles.rangePill, rangeKey === key && styles.rangePillActive]}
                        onPress={() => { setRangeKey(key); setCrosshairIndex(null); }}
                    >
                        <Text style={[styles.rangePillText, rangeKey === key && styles.rangePillTextActive]}>
                            {RANGE_LABELS[key]}
                        </Text>
                    </TouchableOpacity>
                ))}
            </View>
            <View style={{ width: chartWidth, height: MODAL_CHART_HEIGHT }}>
                <PriceChartSvg
                    data={data}
                    width={chartWidth}
                    height={MODAL_CHART_HEIGHT}
                    colors={colors}
                    isModal
                    activePtIndex={crosshairIndex}
                    shortDate={shortDate}
                    formatEuro={formatEuro}
                />
                <View
                    style={{ position: 'absolute', top: 0, left: 0, width: chartWidth, height: MODAL_CHART_HEIGHT }}
                    onStartShouldSetResponder={() => true}
                    onMoveShouldSetResponder={() => true}
                    onResponderGrant={e => handleChartTouch(e.nativeEvent.locationX)}
                    onResponderMove={e => handleChartTouch(e.nativeEvent.locationX)}
                />
            </View>
            <View style={styles.chartModalFooter}>
                <View style={styles.chartModalLegend}>
                    <View style={styles.chartModalLegendItem}>
                        <View style={[styles.chartModalLegendDot, { backgroundColor: colors.textSecondary }]} />
                        <Text style={styles.chartModalLegendLabel}>{t('product.regularPrice')}</Text>
                    </View>
                    <View style={styles.chartModalLegendItem}>
                        <View style={[styles.chartModalLegendDot, { backgroundColor: colors.primary }]} />
                        <Text style={styles.chartModalLegendLabel}>{t('product.promoPrice')}</Text>
                    </View>
                </View>
            </View>
        </>
    );
}

// ── SP Edit modal ─────────────────────────────────────────────────────────────

function SpEditModal({
    sp,
    onSave,
    onCancel,
    colors,
    styles,
}: {
    sp: AdminSpDetail;
    onSave: (payload: EditSpPayload & { imageUrl?: string | null }) => Promise<void>;
    onCancel: () => void;
    colors: AppTheme;
    styles: ReturnType<typeof makeStyles>;
}) {
    const { t } = useTranslation();
    const { top } = useSafeAreaInsets();
    const [name, setName] = useState(sp.storeProductName ?? '');
    const [amount, setAmount] = useState(() => {
        if (sp.amount == null) return '';
        const n = parseFloat(String(sp.amount));
        return isFinite(n) ? String(n) : '';
    });
    const [unit, setUnit] = useState<Unit>((sp.unit as Unit) ?? 'g');
    const [isWeighable, setIsWeighable] = useState(sp.isWeighable);
    const [imageUrl, setImageUrl] = useState<string | null | undefined>(sp.imageUrl);
    const [uploading, setUploading] = useState(false);
    const [saving, setSaving] = useState(false);

    const candidates = sp.imageCandidates;

    const handleUpload = async () => {
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
                body: JSON.stringify({ filename: `admin-${sp.id}-${Date.now()}.jpg`, mimeType: 'image/jpeg' }),
            });
            const { uploadUrl, filePath } = await uploadUrlRes.json();
            const blob = await (await fetch(compressed.uri)).blob();
            const putRes = await fetch(uploadUrl, {
                method: 'PUT', body: blob, headers: { 'Content-Type': 'image/jpeg' },
            });
            if (!putRes.ok) throw new Error('upload failed');
            setImageUrl(filePath);
        } catch { /* ignore */ } finally {
            setUploading(false);
        }
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            const payload: EditSpPayload & { imageUrl?: string | null } = {};
            if (name.trim() !== (sp.storeProductName ?? '')) payload.storeProductName = name.trim();
            const amtNum = amount ? parseFloat(amount) : null;
            if (amtNum !== (sp.amount != null ? parseFloat(String(sp.amount)) : null)) payload.amount = amtNum;
            if (unit !== sp.unit) payload.unit = unit;
            if (isWeighable !== sp.isWeighable) payload.isWeighable = isWeighable;
            if (imageUrl !== sp.imageUrl) payload.imageUrl = imageUrl ?? null;
            await onSave(payload);
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal visible animationType="slide" onRequestClose={onCancel}>
            <View style={{ flex: 1, backgroundColor: colors.pageBackground }}>
                {/* Header */}
                <View style={[styles.editHeader, { paddingTop: top + 8 }]}>
                    <TouchableOpacity onPress={onCancel} style={styles.editHeaderSide}>
                        <Text style={styles.editHeaderCancel}>{t('common.cancel')}</Text>
                    </TouchableOpacity>
                    <Text style={styles.editHeaderTitle}>{t('admin.sp.editTitle')}</Text>
                    <TouchableOpacity
                        onPress={handleSave}
                        style={[styles.editHeaderSide, { alignItems: 'flex-end' }]}
                        disabled={saving}
                    >
                        {saving
                            ? <MaterialProgress size="small" color={colors.primary} />
                            : <Text style={styles.editHeaderSave}>{t('common.save')}</Text>}
                    </TouchableOpacity>
                </View>

                <KeyboardAwareScrollView
                    contentContainerStyle={styles.editScroll}
                    keyboardShouldPersistTaps="handled"
                    bottomOffset={16}
                >
                    {/* Image section */}
                    <View style={styles.editSection}>
                        <Text style={styles.editSectionLabel}>{t('admin.sp.editSectionImage')}</Text>
                        {/* Current image */}
                        <View style={styles.editCurrentImageWrap}>
                            {imageUrl ? (
                                <Image source={{ uri: imageUrl }} style={styles.editCurrentImage} resizeMode="contain" />
                            ) : (
                                <ProductImage
                                    uris={null}
                                    imageStyle={styles.editCurrentImage}
                                    placeholderStyle={[styles.editCurrentImage, { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted }]}
                                    emojiStyle={{ fontSize: 40, opacity: 0.4 }}
                                />
                            )}
                        </View>
                        {/* Candidates strip */}
                        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 10 }}>
                            <View style={{ flexDirection: 'row', gap: 8 }}>
                                {/* Upload slot */}
                                <Pressable
                                    style={styles.editCandidateThumb}
                                    onPress={handleUpload}
                                    disabled={uploading}
                                >
                                    {uploading
                                        ? <MaterialProgress color={colors.primary} />
                                        : <Ionicons name="add" size={28} color={colors.primary} />}
                                </Pressable>
                                {/* Remove slot */}
                                {imageUrl && (
                                    <Pressable
                                        style={[styles.editCandidateThumb, { borderColor: '#e53e3e' }]}
                                        onPress={() => setImageUrl(null)}
                                    >
                                        <Ionicons name="trash-outline" size={22} color="#e53e3e" />
                                    </Pressable>
                                )}
                                {candidates.map(c => (
                                    <Pressable
                                        key={c.imageUrl}
                                        style={[
                                            styles.editCandidateThumb,
                                            imageUrl === c.imageUrl && styles.editCandidateSelected,
                                        ]}
                                        onPress={() => setImageUrl(c.imageUrl)}
                                    >
                                        <Image source={{ uri: c.imageUrl }} style={styles.editCandidateImg} resizeMode="cover" />
                                    </Pressable>
                                ))}
                            </View>
                        </ScrollView>
                    </View>

                    {/* Name */}
                    <View style={styles.editSection}>
                        <Text style={styles.editSectionLabel}>{t('admin.sp.editSectionName')}</Text>
                        <TextInput
                            style={styles.editInput}
                            value={name}
                            onChangeText={setName}
                            placeholder={t('admin.sp.editNamePlaceholder')}
                            placeholderTextColor={colors.textMuted}
                        />
                    </View>

                    {/* Amount + unit */}
                    <View style={styles.editSection}>
                        <Text style={styles.editSectionLabel}>{t('admin.sp.editSectionAmount')}</Text>
                        <View style={{ flexDirection: 'row', gap: 10 }}>
                            <TextInput
                                style={[styles.editInput, { flex: 1 }]}
                                value={amount}
                                onChangeText={setAmount}
                                keyboardType="decimal-pad"
                                placeholder="0"
                                placeholderTextColor={colors.textMuted}
                            />
                            {/* Unit picker */}
                            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexShrink: 1 }}>
                                <View style={{ flexDirection: 'row', gap: 6 }}>
                                    {UNITS.map(u => (
                                        <TouchableOpacity
                                            key={u}
                                            style={[styles.unitChip, unit === u && styles.unitChipActive]}
                                            onPress={() => setUnit(u)}
                                        >
                                            <Text style={[styles.unitChipText, unit === u && styles.unitChipTextActive]}>{u}</Text>
                                        </TouchableOpacity>
                                    ))}
                                </View>
                            </ScrollView>
                        </View>
                    </View>

                    {/* isWeighable toggle */}
                    <View style={[styles.editSection, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}>
                        <Text style={styles.editSectionLabel}>{t('admin.sp.editSectionWeighable')}</Text>
                        <Switch
                            value={isWeighable}
                            onValueChange={setIsWeighable}
                            trackColor={{ true: colors.primary }}
                        />
                    </View>
                </KeyboardAwareScrollView>
            </View>
        </Modal>
    );
}

// ── SP card ───────────────────────────────────────────────────────────────────

function SpCard({
    sp,
    active,
    onLongPress,
    onTapChart,
    colors,
    styles,
}: {
    sp: AdminSpDetail;
    active: boolean;
    onLongPress: () => void;
    onTapChart: () => void;
    colors: AppTheme;
    styles: ReturnType<typeof makeStyles>;
}) {
    const amtStr = formatAmountStr(sp.amount, sp.unit, sp.isWeighable);

    return (
        <TouchableOpacity
            style={[styles.spCard, active && styles.spCardActive]}
            onLongPress={onLongPress}
            activeOpacity={0.8}
            delayLongPress={300}
        >
            <View style={styles.spLeft}>
                <ProductImage
                    uris={[sp.imageUrl]}
                    imageStyle={styles.spImage}
                    placeholderStyle={styles.spImagePlaceholder}
                    emojiStyle={{ fontSize: 28, opacity: 0.4 }}
                />
                <View style={styles.spInfo}>
                    <Text style={styles.spName} numberOfLines={2}>{sp.storeProductName}</Text>
                    {amtStr ? <Text style={styles.spAmt}>{amtStr}</Text> : null}
                    {sp.latestPrice && (
                        <View style={styles.spPriceRow}>
                            <Text style={[styles.spPrice, sp.latestPrice.promoPrice != null && styles.spPriceStrike]}>
                                {formatEuro(sp.latestPrice.price)}
                            </Text>
                            {sp.latestPrice.promoPrice != null && (
                                <Text style={styles.spPromo}>{formatEuro(sp.latestPrice.promoPrice)}</Text>
                            )}
                        </View>
                    )}
                </View>
            </View>
            <View style={styles.spRight}>
                <MiniPriceChart
                    prices={sp.priceHistory as PricePoint[]}
                    onTap={onTapChart}
                />
            </View>
            <ChainLogoStrip
                chainLogos={[{ chainId: sp.chainId, logoUrl: getChainMiniLogoUrl(sp.chainId, sp.logoUrl ?? '') }]}
                style={{ position: 'absolute', top: 12, left: 12, transform: [{ scale: 0.7 }], transformOrigin: 'top left', backgroundColor: 'transparent', paddingHorizontal: 0, paddingVertical: 0, shadowOpacity: 0, elevation: 0 }}
            />
            <View style={styles.spIdBadge}>
                <Text style={styles.spIdText}>{sp.id}</Text>
            </View>
        </TouchableOpacity>
    );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function AdminProductDetailScreen() {
    const { t } = useTranslation();
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();
    const { id } = useLocalSearchParams<{ id: string }>();
    const productId = Number(id);
    const { top } = useSafeAreaInsets();
    const toastRef = useRef<ToastHandle>(null);

    const [detail, setDetail] = useState<AdminProductDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [activeSp, setActiveSp] = useState<AdminSpDetail | null>(null);
    const [editingSp, setEditingSp] = useState<AdminSpDetail | null>(null);
    const [movingSp, setMovingSp] = useState<AdminSpDetail | null>(null);
    const [deletingSpId, setDeletingSpId] = useState<number | null>(null);
    const [chartSp, setChartSp] = useState<AdminSpDetail | null>(null);

    const load = useCallback(async () => {
        try {
            const data = await getAdminProductDetail(productId);
            setDetail(data);
        } catch {
            toastRef.current?.show(t('admin.sp.loadError'));
        } finally {
            setLoading(false);
        }
    }, [productId]);

    useEffect(() => { load(); }, [load]);

    const handleDelete = useCallback((sp: AdminSpDetail) => {
        Alert.alert(
            t('admin.sp.deleteTitle'),
            t('admin.sp.deleteBody', { name: sp.storeProductName }),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('common.delete'), style: 'destructive',
                    onPress: async () => {
                        setActiveSp(null);
                        setDeletingSpId(sp.id);
                        try {
                            const result = await deleteAdminStoreProduct(sp.id);
                            if (result.productDeleted) {
                                toastRef.current?.show(t('admin.sp.deleteProductSuccess'));
                                router.back();
                            } else {
                                setDetail(prev => prev ? {
                                    ...prev,
                                    storeProducts: prev.storeProducts.filter(s => s.id !== sp.id),
                                } : prev);
                                toastRef.current?.show(t('admin.sp.deleteSuccess'));
                            }
                        } catch (e: any) {
                            toastRef.current?.show(e?.message ?? t('admin.sp.deleteError'));
                        } finally {
                            setDeletingSpId(null);
                        }
                    },
                },
            ],
        );
    }, [router, t]);

    const handleEditSave = useCallback(async (payload: EditSpPayload & { imageUrl?: string | null }) => {
        if (!editingSp) return;
        // If imageUrl changed, adopt via image endpoint too
        if ('imageUrl' in payload && payload.imageUrl !== editingSp.imageUrl) {
            try {
                if (payload.imageUrl) {
                    await adoptImageCandidate(editingSp.id, {
                        imageUrl: payload.imageUrl,
                        sourceType: 'admin_upload',
                        sourceSpId: null,
                    });
                }
            } catch { /* non-fatal */ }
        }
        const editPayload: EditSpPayload = {};
        if ('storeProductName' in payload) editPayload.storeProductName = payload.storeProductName;
        if ('amount' in payload) editPayload.amount = payload.amount;
        if ('unit' in payload) editPayload.unit = payload.unit as string;
        if ('isWeighable' in payload) editPayload.isWeighable = payload.isWeighable;
        if ('imageUrl' in payload) editPayload.imageUrl = payload.imageUrl;

        if (Object.keys(editPayload).length > 0) {
            await editAdminStoreProduct(editingSp.id, editPayload);
        }
        // Refresh
        setEditingSp(null);
        setActiveSp(null);
        setLoading(true);
        await load();
    }, [editingSp, load]);

    const handleMoveConfirm = useCallback(async (categoryId: number, categoryName: string) => {
        if (!movingSp) return;
        setMovingSp(null);
        try {
            const result = await moveAdminStoreProduct(movingSp.id, { mode: 'existing', productId: categoryId });
            if (result.oldProductDeleted) {
                toastRef.current?.show(t('admin.sp.moveSuccessOldDeleted'));
                router.back();
            } else {
                setDetail(prev => prev ? {
                    ...prev,
                    storeProducts: prev.storeProducts.filter(s => s.id !== movingSp.id),
                } : prev);
                toastRef.current?.show(t('admin.sp.moveSuccess', { name: categoryName }));
            }
        } catch (e: any) {
            toastRef.current?.show(e?.message ?? t('admin.sp.moveError'));
        }
    }, [movingSp, router, t]);

    const handleSpMoveConfirm = useCallback(async (payload: MoveSpPayload) => {
        if (!movingSp) return;
        setMovingSp(null);
        try {
            const result = await moveAdminStoreProduct(movingSp.id, payload);
            if (result.oldProductDeleted) {
                toastRef.current?.show(t('admin.sp.moveSuccessOldDeleted'));
                router.back();
            } else {
                setDetail(prev => prev ? {
                    ...prev,
                    storeProducts: prev.storeProducts.filter(s => s.id !== movingSp.id),
                } : prev);
                toastRef.current?.show(t('admin.sp.moveSuccess', { name: result.targetProductName }));
            }
        } catch (e: any) {
            toastRef.current?.show(e?.message ?? t('admin.sp.moveError'));
        }
    }, [movingSp, router, t]);

    if (loading) {
        return (
            <View style={[styles.container, { paddingTop: top + 48 }]}>
                <View style={{ padding: 16, gap: 12 }}>
                    {[0, 1, 2].map(i => (
                        <View key={i} style={styles.spCard}>
                            <SkeletonBox width={64} height={64} borderRadius={8} />
                            <View style={{ flex: 1, gap: 6 }}>
                                <SkeletonBox height={13} borderRadius={4} />
                                <SkeletonBox width={80} height={11} borderRadius={4} />
                            </View>
                        </View>
                    ))}
                </View>
            </View>
        );
    }

    if (!detail) {
        return (
            <View style={[styles.container, { alignItems: 'center', justifyContent: 'center' }]}>
                <Text style={{ color: colors.textMuted }}>{t('admin.sp.notFound')}</Text>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <Stack.Screen options={{ headerShown: false }} />
            {/* Header */}
            <View style={[styles.header, { paddingTop: top + 4 }]}>
                <TouchableOpacity onPress={() => router.back()} style={styles.headerBack}>
                    <Ionicons name="chevron-back" size={20} color={colors.primary} />
                </TouchableOpacity>
                <View style={{ flex: 1 }}>
                    <Text style={styles.headerTitle} numberOfLines={1}>{detail.product.name}</Text>
                    {detail.product.categoryPath && (
                        <Text style={styles.headerSub} numberOfLines={1}>{detail.product.categoryPath}</Text>
                    )}
                </View>
                <View style={styles.headerIdBadge}>
                    <Text style={styles.headerIdText}>{detail.product.id}</Text>
                </View>
            </View>

            {/* SP list */}
            <ScrollView contentContainerStyle={{ padding: 12, gap: 8 }}>
                {detail.storeProducts.length === 0 ? (
                    <Text style={styles.emptyText}>{t('admin.sp.noStoreProducts')}</Text>
                ) : (
                    detail.storeProducts.map(sp => (
                        <View key={sp.id}>
                            <SpCard
                                sp={sp}
                                active={activeSp?.id === sp.id}
                                onLongPress={() => setActiveSp(sp)}
                                onTapChart={() => setChartSp(sp)}
                                colors={colors}
                                styles={styles}
                            />
                            {deletingSpId === sp.id && (
                                <View style={styles.deletingOverlay}>
                                    <MaterialProgress color={colors.primary} />
                                </View>
                            )}
                        </View>
                    ))
                )}
            </ScrollView>

            {/* SP action bar */}
            {activeSp && (
                <CardActionBar
                    title={activeSp.storeProductName ?? activeSp.chainName}
                    onDismiss={() => setActiveSp(null)}
                    actions={[
                        { icon: 'pencil-outline', label: t('admin.sp.actionEdit'),
                          onPress: () => { setEditingSp(activeSp); setActiveSp(null); } },
                        { icon: 'git-branch-outline', label: t('admin.sp.actionMove'),
                          onPress: () => { setMovingSp(activeSp); setActiveSp(null); } },
                        { icon: 'trash-outline', label: t('admin.sp.actionDelete'),
                          destructive: true, onPress: () => handleDelete(activeSp) },
                    ]}
                />
            )}

            {/* SP Edit modal */}
            {editingSp && (
                <SpEditModal
                    sp={editingSp}
                    onSave={handleEditSave}
                    onCancel={() => setEditingSp(null)}
                    colors={colors}
                    styles={styles}
                />
            )}

            {/* SP Move modal */}
            <CategoryPickerModal
                visible={movingSp !== null}
                selectionCount={1}
                sourceL3Ids={[]}
                spMoveMode
                prefilledName={movingSp?.storeProductName ?? undefined}
                onConfirm={handleMoveConfirm}
                onSpMoveConfirm={handleSpMoveConfirm}
                onCancel={() => setMovingSp(null)}
            />

            {/* Chart modal */}
            <Modal
                visible={chartSp !== null}
                transparent
                animationType="fade"
                onRequestClose={() => setChartSp(null)}
            >
                <TouchableOpacity
                    style={styles.chartModalBackdrop}
                    activeOpacity={1}
                    onPress={() => setChartSp(null)}
                >
                    <TouchableOpacity style={styles.chartModalCard} activeOpacity={1} onPress={() => {}}>
                        <Text style={styles.chartModalTitle} numberOfLines={2}>
                            {chartSp?.storeProductName}
                        </Text>
                        <Text style={styles.chartModalSub}>{t('product.priceHistory')}</Text>
                        {chartSp && (() => {
                            const allData = preparePriceData(chartSp.priceHistory as PricePoint[]);
                            if (!allData.length) {
                                return (
                                    <View style={styles.chartModalEmpty}>
                                        <Ionicons name="analytics-outline" size={28} color={colors.border} />
                                        <Text style={styles.chartModalEmptyText}>{t('admin.sp.chartEmpty')}</Text>
                                    </View>
                                );
                            }
                            return <ModalChart prices={chartSp.priceHistory as PricePoint[]} colors={colors} styles={styles} />;
                        })()}
                    </TouchableOpacity>
                </TouchableOpacity>
            </Modal>

            <Toast ref={toastRef} />
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    container: { flex: 1, backgroundColor: c.pageBackground },

    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingBottom: 10,
        backgroundColor: c.cardBackground,
        borderBottomWidth: 0.5,
        borderBottomColor: c.border,
        gap: 8,
    },
    headerBack: { padding: 4, marginRight: 2 },
    headerTitle: { fontSize: 15, fontWeight: '700', color: c.textPrimary },
    headerSub: { fontSize: 11, color: c.textMuted, marginTop: 1 },
    headerIdBadge: { backgroundColor: c.surfaceMuted, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3 },
    headerIdText: { fontSize: 10, fontWeight: '700', color: c.textMuted },

    // SP card — same layout as user-side product/[id].tsx spCard
    spCard: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: c.cardBackground,
        borderRadius: 12,
        padding: 12,
        gap: 12,
        borderWidth: 1.5,
        borderColor: 'transparent',
        overflow: 'hidden',
    },
    spCardActive: { borderColor: c.primary },
    spLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
    spRight: { width: 140 },
    spImage: { width: 64, height: 64, borderRadius: 8 },
    spImagePlaceholder: { width: 64, height: 64, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surfaceMuted },
    spInfo: { flex: 1 },
    spName: { fontSize: 13, color: c.textPrimary, fontWeight: '500', lineHeight: 18 },
    spAmt: { fontSize: 11, color: c.textMuted, marginTop: 2 },
    spPriceRow: { flexDirection: 'row', gap: 6, marginTop: 2 },
    spPrice: { fontSize: 13, fontWeight: '700', color: c.textPrimary },
    spPriceStrike: { textDecorationLine: 'line-through', color: c.textMuted, fontWeight: '400', fontSize: 12 },
    spPromo: { fontSize: 13, fontWeight: '700', color: c.primary },
    spIdBadge: { position: 'absolute', bottom: 8, right: 8, backgroundColor: c.surfaceMuted, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 2 },
    spIdText: { fontSize: 9, fontWeight: '700', color: c.textMuted },

    emptyText: { textAlign: 'center', padding: 32, color: c.textMuted, fontSize: 14 },

    // Delete overlay
    deletingOverlay: {
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'rgba(255,255,255,0.75)',
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },

    // Chart modal
    chartModalBackdrop: {
        flex: 1,
        backgroundColor: c.overlayBackdrop,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    chartModalCard: {
        backgroundColor: c.cardBackground,
        borderRadius: 16,
        padding: 20,
        width: '100%',
        maxWidth: 480,
    },
    chartModalTitle: { fontSize: 16, fontWeight: '700', color: c.textPrimary },
    chartModalSub: { fontSize: 12, color: c.textSecondary, marginTop: 2, marginBottom: 12 },
    chartModalEmpty: { height: MODAL_CHART_HEIGHT, alignItems: 'center', justifyContent: 'center', gap: 10 },
    chartModalEmptyText: { fontSize: 13, color: c.textMuted },
    chartModalFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
    chartModalLegend: { flexDirection: 'row', gap: 14 },
    chartModalLegendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    chartModalLegendDot: { width: 8, height: 8, borderRadius: 4 },
    chartModalLegendLabel: { fontSize: 12, color: c.textSecondary, fontWeight: '500' },
    chartPriceDisplay: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 },
    chartDisplayPrice: { fontSize: 22, fontWeight: '700', color: c.textPrimary },
    chartDisplayPromo: { fontSize: 22, fontWeight: '700', color: c.primary },
    chartDisplayStrike: { fontSize: 14, color: c.textMuted, textDecorationLine: 'line-through' },
    chartDisplayDate: { fontSize: 12, color: c.textMuted },
    rangePills: { flexDirection: 'row', gap: 6, marginBottom: 10 },
    rangePill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, backgroundColor: c.softAccent },
    rangePillActive: { backgroundColor: c.primary },
    rangePillText: { fontSize: 12, fontWeight: '500', color: c.textSecondary },
    rangePillTextActive: { color: c.onPrimary },

    // SP Edit modal
    editHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: c.cardBackground,
        borderBottomWidth: 0.5,
        borderBottomColor: c.border,
    },
    editHeaderSide: { width: 80, justifyContent: 'center' },
    editHeaderTitle: { flex: 1, fontSize: 16, fontWeight: '700', color: c.textPrimary, textAlign: 'center' },
    editHeaderCancel: { fontSize: 15, color: c.primary },
    editHeaderSave: { fontSize: 15, color: c.primary, fontWeight: '700' },

    editScroll: { padding: 16, gap: 16 },
    editSection: { backgroundColor: c.cardBackground, borderRadius: 12, padding: 14, gap: 8 },
    editSectionLabel: { fontSize: 12, fontWeight: '600', color: c.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },

    editCurrentImageWrap: { width: '100%', height: 180, borderRadius: 10, overflow: 'hidden', backgroundColor: c.surfaceMuted },
    editCurrentImage: { width: '100%', height: '100%', borderRadius: 10 },

    editCandidateThumb: {
        width: 72, height: 72, borderRadius: 8,
        borderWidth: 1.5, borderColor: c.border,
        alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden',
        backgroundColor: c.surfaceMuted,
    },
    editCandidateSelected: { borderColor: c.primary, borderWidth: 2 },
    editCandidateImg: { width: '100%', height: '100%' },

    editInput: {
        borderWidth: 1, borderColor: c.border, borderRadius: 10,
        paddingHorizontal: 12, paddingVertical: 10,
        fontSize: 14, color: c.textPrimary, backgroundColor: c.pageBackground,
    },

    unitChip: {
        paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16,
        borderWidth: 1, borderColor: c.border, backgroundColor: c.pageBackground,
        alignItems: 'center', justifyContent: 'center',
    },
    unitChipActive: { backgroundColor: c.primary, borderColor: c.primary },
    unitChipText: { fontSize: 13, color: c.textSecondary },
    unitChipTextActive: { color: c.onPrimary, fontWeight: '600' },
});
