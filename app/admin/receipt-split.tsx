import {
    View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
    TextInput, Alert, Image,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useTheme, type AppTheme } from '../../constants/theme';
import {
    fetchFlaggedReceiptCrop,
    applyAdminReceiptSplit,
    type SplitItem,
} from '../../services/adminClient';

const CROP_H = 120;

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

interface ItemDraft {
    name: string;
    price: string;
    promoPrice: string;
    amount: string;
    unit: string;
}

function parseDraft(d: ItemDraft): SplitItem | null {
    const price = parseFloat(d.price.replace(',', '.'));
    if (!d.name.trim() || !Number.isFinite(price)) return null;
    const promoPrice = d.promoPrice.trim() ? parseFloat(d.promoPrice.replace(',', '.')) : null;
    const amount = d.amount.trim() ? parseFloat(d.amount.replace(',', '.')) : null;
    if (d.promoPrice.trim() && !Number.isFinite(promoPrice!)) return null;
    if (d.amount.trim() && !Number.isFinite(amount!)) return null;
    return {
        name: d.name.trim(),
        price,
        promoPrice: Number.isFinite(promoPrice!) ? promoPrice : null,
        amount: Number.isFinite(amount!) ? amount : null,
        unit: d.unit.trim() || null,
    };
}

export default function ReceiptSplitScreen() {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const router = useRouter();

    const params = useLocalSearchParams<{
        productId: string;
        priceId: string;
        receiptId: string;
        lineIdx: string;
        productName: string;
        price: string;
        promoPrice: string;
        amount: string;
        unit: string;
    }>();

    const productId = Number(params.productId);
    const priceId = Number(params.priceId);
    const receiptId = Number(params.receiptId);
    const lineIdx = Number(params.lineIdx);

    const [cropUri, setCropUri] = useState<string | null>(null);
    const [cropLoading, setCropLoading] = useState(true);

    // Draggable split divider — purely visual, helps admin see where to draw the line.
    const dividerY = useSharedValue(CROP_H / 2);
    const dragStartY = useSharedValue(CROP_H / 2);
    const panGesture = useMemo(() =>
        Gesture.Pan()
            .minDistance(0)
            .onBegin(() => { dragStartY.value = dividerY.value; })
            .onUpdate((e) => {
                dividerY.value = Math.min(CROP_H * 0.85, Math.max(CROP_H * 0.15,
                    dragStartY.value + e.translationY));
            }),
        [], // eslint-disable-line react-hooks/exhaustive-deps
    );
    const topZoneStyle = useAnimatedStyle(() => ({ height: dividerY.value }));
    const bottomZoneStyle = useAnimatedStyle(() => ({
        top: dividerY.value,
        height: CROP_H - dividerY.value,
    }));
    const dividerHandleStyle = useAnimatedStyle(() => ({
        top: dividerY.value - 14, // center 28px handle on split point
    }));

    const [top, setTop] = useState<ItemDraft>({
        name: '',
        price: '',
        promoPrice: '',
        amount: params.amount ?? '',
        unit: params.unit ?? '',
    });
    const [bottom, setBottom] = useState<ItemDraft>({
        name: params.productName ?? '',
        price: params.price ?? '',
        promoPrice: params.promoPrice ?? '',
        amount: params.amount ?? '',
        unit: params.unit ?? '',
    });

    const [submitting, setSubmitting] = useState(false);

    // Load the receipt crop for context.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetchFlaggedReceiptCrop(receiptId, lineIdx);
                if (cancelled || !res) return;
                const uri = await blobToDataUri(res.blob);
                if (!cancelled) setCropUri(uri);
            } catch (e) {
                console.warn('[admin/receipt-split] crop fetch failed', e);
            } finally {
                if (!cancelled) setCropLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [receiptId, lineIdx]);

    const topItem = useMemo(() => parseDraft(top), [top]);
    const bottomItem = useMemo(() => parseDraft(bottom), [bottom]);
    const canSubmit = topItem !== null && bottomItem !== null && !submitting;

    const onSubmit = useCallback(async () => {
        if (!canSubmit || !topItem || !bottomItem) return;
        setSubmitting(true);
        try {
            const result = await applyAdminReceiptSplit(productId, {
                priceId,
                top: topItem,
                bottom: bottomItem,
            });
            Alert.alert(
                t('admin.split.successTitle'),
                result.newIsNew
                    ? t('admin.split.successBodyNew', { name: topItem.name })
                    : t('admin.split.successBodyMerged', { name: topItem.name }),
                [{ text: t('admin.split.ok'), onPress: () => router.back() }],
            );
        } catch (e: any) {
            const msg = String(e?.message ?? '');
            Alert.alert(msg.includes('429')
                ? t('admin.split.rateLimitToast')
                : t('admin.split.errorToast'));
            setSubmitting(false);
        }
    }, [canSubmit, topItem, bottomItem, productId, priceId, t, router]);

    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            <Stack.Screen
                options={{
                    title: t('admin.split.title'),
                    headerBackTitle: t('admin.split.back'),
                    headerStyle: { backgroundColor: colors.pageBackground },
                    headerTintColor: colors.textPrimary,
                    headerShadowVisible: false,
                }}
            />
            <KeyboardAwareScrollView
                style={styles.page}
                contentContainerStyle={styles.scroll}
                keyboardShouldPersistTaps="handled"
                bottomOffset={72}
            >
                {/* Receipt crop with draggable split divider */}
                <View style={styles.cropCard}>
                    <Text style={styles.cropLabel}>{t('admin.split.receiptLine')}</Text>
                    {cropLoading && !cropUri
                        ? <ActivityIndicator color={colors.primary} style={styles.cropLoader} />
                        : cropUri
                            ? <View style={styles.cropImageContainer}>
                                <Image source={{ uri: cropUri }} style={styles.cropImage} resizeMode="contain" />
                                {/* Zone tints — top = product 1, bottom = product 2 */}
                                <Animated.View
                                    style={[styles.cropZoneTop, topZoneStyle]}
                                    pointerEvents="none"
                                />
                                <Animated.View
                                    style={[styles.cropZoneBottom, bottomZoneStyle]}
                                    pointerEvents="none"
                                />
                                {/* Draggable handle */}
                                <GestureDetector gesture={panGesture}>
                                    <Animated.View style={[styles.cropDivider, dividerHandleStyle]}>
                                        <View style={styles.cropDividerLine} />
                                        <View style={styles.cropDividerPill}>
                                            <Ionicons name="reorder-three" size={15} color="#fff" />
                                        </View>
                                        <View style={styles.cropDividerLine} />
                                    </Animated.View>
                                </GestureDetector>
                              </View>
                            : <Text style={styles.cropMissing}>{t('admin.split.noCrop')}</Text>}
                </View>

                <View style={styles.dividerRow}>
                    <View style={styles.dividerLine} />
                    <View style={styles.dividerBadge}>
                        <Ionicons name="git-branch-outline" size={14} color={colors.primary} />
                        <Text style={styles.dividerText}>{t('admin.split.divider')}</Text>
                    </View>
                    <View style={styles.dividerLine} />
                </View>

                {/* Top card — becomes a NEW product */}
                <ItemCard
                    label={t('admin.split.topLabel')}
                    sublabel={t('admin.split.topSublabel')}
                    accentColor={colors.primary}
                    draft={top}
                    onChange={setTop}
                    colors={colors}
                    styles={styles}
                    t={t}
                />

                <View style={styles.arrowRow}>
                    <Ionicons name="arrow-down" size={18} color={colors.textMuted} />
                </View>

                {/* Bottom card — overwrites the EXISTING product */}
                <ItemCard
                    label={t('admin.split.bottomLabel')}
                    sublabel={t('admin.split.bottomSublabel')}
                    accentColor={colors.warning}
                    draft={bottom}
                    onChange={setBottom}
                    colors={colors}
                    styles={styles}
                    t={t}
                />

                <View style={styles.spacer} />
            </KeyboardAwareScrollView>

            <View style={styles.footer}>
                <TouchableOpacity
                    style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
                    onPress={onSubmit}
                    disabled={!canSubmit}
                >
                    {submitting
                        ? <ActivityIndicator color={colors.onPrimary} />
                        : <>
                            <Ionicons name="git-branch-outline" size={18} color={colors.onPrimary} />
                            <Text style={styles.submitBtnText}>{t('admin.split.submit')}</Text>
                          </>}
                </TouchableOpacity>
            </View>
        </GestureHandlerRootView>
    );
}

interface ItemCardProps {
    label: string;
    sublabel: string;
    accentColor: string;
    draft: ItemDraft;
    onChange: (d: ItemDraft) => void;
    colors: AppTheme;
    styles: ReturnType<typeof makeStyles>;
    t: (key: string) => string;
}

function ItemCard({ label, sublabel, accentColor, draft, onChange, colors, styles, t }: ItemCardProps) {
    const set = (key: keyof ItemDraft) => (val: string) =>
        onChange({ ...draft, [key]: val });

    return (
        <View style={[styles.itemCard, { borderLeftColor: accentColor }]}>
            <View style={styles.itemCardHeader}>
                <Text style={[styles.itemCardLabel, { color: accentColor }]}>{label}</Text>
                <Text style={styles.itemCardSublabel}>{sublabel}</Text>
            </View>

            <Field label={t('admin.split.fieldName')} required colors={colors} styles={styles}>
                <TextInput
                    style={styles.textInput}
                    value={draft.name}
                    onChangeText={set('name')}
                    placeholder={t('admin.split.fieldNamePlaceholder')}
                    placeholderTextColor={colors.textMuted}
                    autoCorrect={false}
                />
            </Field>

            <View style={styles.rowFields}>
                <View style={styles.rowFieldHalf}>
                    <Field label={t('admin.split.fieldPrice')} required colors={colors} styles={styles}>
                        <TextInput
                            style={styles.textInput}
                            value={draft.price}
                            onChangeText={set('price')}
                            keyboardType="decimal-pad"
                            placeholder="0.00"
                            placeholderTextColor={colors.textMuted}
                        />
                    </Field>
                </View>
                <View style={styles.rowFieldHalf}>
                    <Field label={t('admin.split.fieldPromoPrice')} colors={colors} styles={styles}>
                        <TextInput
                            style={styles.textInput}
                            value={draft.promoPrice}
                            onChangeText={set('promoPrice')}
                            keyboardType="decimal-pad"
                            placeholder={t('admin.split.fieldPromoPricePlaceholder')}
                            placeholderTextColor={colors.textMuted}
                        />
                    </Field>
                </View>
            </View>

            <View style={styles.rowFields}>
                <View style={styles.rowFieldHalf}>
                    <Field label={t('admin.split.fieldAmount')} colors={colors} styles={styles}>
                        <TextInput
                            style={styles.textInput}
                            value={draft.amount}
                            onChangeText={set('amount')}
                            keyboardType="decimal-pad"
                            placeholder={t('admin.split.fieldAmountPlaceholder')}
                            placeholderTextColor={colors.textMuted}
                        />
                    </Field>
                </View>
                <View style={styles.rowFieldHalf}>
                    <Field label={t('admin.split.fieldUnit')} colors={colors} styles={styles}>
                        <TextInput
                            style={styles.textInput}
                            value={draft.unit}
                            onChangeText={set('unit')}
                            placeholder="g / ml / vnt"
                            placeholderTextColor={colors.textMuted}
                            autoCapitalize="none"
                        />
                    </Field>
                </View>
            </View>
        </View>
    );
}

interface FieldProps {
    label: string;
    required?: boolean;
    children: React.ReactNode;
    colors: AppTheme;
    styles: ReturnType<typeof makeStyles>;
}

function Field({ label, required, children, colors, styles }: FieldProps) {
    return (
        <View style={styles.field}>
            <Text style={[styles.fieldLabel, required && { color: colors.primary }]}>
                {label}{required ? ' *' : ''}
            </Text>
            {children}
        </View>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    page: { flex: 1, backgroundColor: c.pageBackground },
    scroll: { padding: 16, gap: 12, paddingBottom: 32 },

    cropCard: {
        backgroundColor: c.cardBackground,
        borderRadius: 14,
        padding: 14,
        gap: 8,
    },
    cropLabel: { fontSize: 11, fontWeight: '700', color: c.textMuted, textTransform: 'uppercase' },
    cropLoader: { alignSelf: 'center', marginVertical: 12 },
    cropImageContainer: {
        width: '100%', height: CROP_H, borderRadius: 8, overflow: 'hidden',
    },
    cropImage: { width: '100%', height: '100%' },
    cropZoneTop: {
        position: 'absolute', top: 0, left: 0, right: 0,
        backgroundColor: c.primary + '30',
    },
    cropZoneBottom: {
        position: 'absolute', left: 0, right: 0,
        backgroundColor: c.warning + '30',
    },
    cropDivider: {
        position: 'absolute', left: 0, right: 0, height: 28,
        flexDirection: 'row', alignItems: 'center',
        zIndex: 10,
    },
    cropDividerLine: { flex: 1, height: 2, backgroundColor: '#fff', opacity: 0.9 },
    cropDividerPill: {
        backgroundColor: c.primary,
        borderRadius: 10, width: 38, height: 24,
        alignItems: 'center', justifyContent: 'center',
        borderWidth: 2, borderColor: '#fff',
    },
    cropMissing: { fontSize: 13, color: c.textMuted, textAlign: 'center', paddingVertical: 12 },

    dividerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginVertical: 4,
    },
    dividerLine: { flex: 1, height: 1, backgroundColor: c.borderSubtle },
    dividerBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 20,
        backgroundColor: c.primary + '18',
        borderWidth: 1,
        borderColor: c.primary + '40',
    },
    dividerText: { fontSize: 12, fontWeight: '700', color: c.primary },

    itemCard: {
        backgroundColor: c.cardBackground,
        borderRadius: 14,
        padding: 14,
        gap: 10,
        borderWidth: 4, borderColor: 'transparent',
    },
    itemCardHeader: { gap: 2 },
    itemCardLabel: { fontSize: 13, fontWeight: '800', textTransform: 'uppercase' },
    itemCardSublabel: { fontSize: 12, color: c.textSecondary },

    arrowRow: { alignItems: 'center', marginVertical: -4 },

    rowFields: { flexDirection: 'row', gap: 8 },
    rowFieldHalf: { flex: 1 },

    field: { gap: 4 },
    fieldLabel: { fontSize: 11, fontWeight: '700', color: c.textSecondary, textTransform: 'uppercase' },

    textInput: {
        backgroundColor: c.pageBackground,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 14,
        color: c.textPrimary,
        borderWidth: 1,
        borderColor: c.borderSubtle,
    },

    spacer: { height: 8 },

    footer: {
        padding: 12,
        backgroundColor: c.cardBackground,
        borderTopWidth: 1,
        borderTopColor: c.borderSubtle,
    },
    submitBtn: {
        backgroundColor: c.primary,
        paddingVertical: 14,
        borderRadius: 12,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 8,
    },
    submitBtnDisabled: { backgroundColor: c.surfaceMuted },
    submitBtnText: { color: c.onPrimary, fontSize: 16, fontWeight: '700' },
});
