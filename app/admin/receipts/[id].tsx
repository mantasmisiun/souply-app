import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
    Alert,
    Modal,
    TextInput,
    Image,
} from "react-native";
import { MaterialProgress } from '@/components/MaterialProgress';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme, type AppTheme } from '../../../constants/theme';
import {
    getAdminReceiptDetail,
    patchAdminReceiptDate,
    patchAdminProductName,
    postAdminConfirmMatch,
    patchAdminProductUnit,
    patchAdminProductAmount,
    patchAdminProductQuantity,
    postAdminDenyMatch,
    fetchFlaggedReceiptCrop,
    type AdminReceiptDetail,
    type MatchCandidate,
} from '../../../services/adminClient';

// ── Per-line OCR crop ────────────────────────────────────────────────

function ProductCrop({ receiptId, lineIdx }: { receiptId: string; lineIdx: number }) {
    const [uri, setUri] = useState<string | null>(null);
    const [aspect, setAspect] = useState<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetchFlaggedReceiptCrop(Number(receiptId), lineIdx)
            .then(async res => {
                if (!res || cancelled) return;
                const reader = new FileReader();
                reader.onloadend = () => {
                    if (!cancelled) setUri(reader.result as string);
                };
                reader.readAsDataURL(res.blob);
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [receiptId, lineIdx]);

    if (!uri) return null;

    return (
        <Image
            source={{ uri }}
            style={[cropStyles.img, aspect ? { aspectRatio: aspect } : { height: 60 }]}
            resizeMode="contain"
            onLoad={({ nativeEvent: { source: { width, height } } }) => {
                if (width > 0 && height > 0) setAspect(width / height);
            }}
        />
    );
}

const cropStyles = StyleSheet.create({
    img: { width: '100%', borderRadius: 6 },
});

// ────────────────────────────────────────────────────────────────────

type Mode = 'review' | 'inspect';

const UNITS = ['g', 'kg', 'ml', 'l', 'vnt', 'rit'];

// ── Inline edit modal ────────────────────────────────────────────────

interface EditModalProps {
    visible: boolean;
    title: string;
    initialValue: string;
    keyboardType?: 'default' | 'decimal-pad' | 'number-pad';
    onSave: (val: string) => void;
    onClose: () => void;
}

function EditModal({ visible, title, initialValue, keyboardType = 'default', onSave, onClose }: EditModalProps) {
    const colors = useTheme();
    const [value, setValue] = useState(initialValue);

    useEffect(() => {
        if (visible) setValue(initialValue);
    }, [visible, initialValue]);

    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
            <KeyboardAvoidingView style={editStyles.backdrop}>
                <View style={[editStyles.sheet, { backgroundColor: colors.cardBackground }]}>
                    <Text style={[editStyles.title, { color: colors.textPrimary }]}>{title}</Text>
                    <TextInput
                        style={[editStyles.input, { backgroundColor: colors.surfaceMuted, color: colors.textPrimary }]}
                        value={value}
                        onChangeText={setValue}
                        keyboardType={keyboardType}
                        autoFocus
                    />
                    <View style={editStyles.row}>
                        <TouchableOpacity style={[editStyles.btn, { backgroundColor: colors.surfaceMuted }]} onPress={onClose}>
                            <Text style={[editStyles.btnText, { color: colors.textPrimary }]}>Atšaukti</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[editStyles.btn, { backgroundColor: colors.primary }]}
                            onPress={() => { onSave(value); onClose(); }}
                        >
                            <Text style={[editStyles.btnText, { color: colors.onPrimary }]}>Išsaugoti</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </KeyboardAvoidingView>
        </Modal>
    );
}

const editStyles = StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
    sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, gap: 16 },
    title: { fontSize: 16, fontWeight: '700' },
    input: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
    row: { flexDirection: 'row', gap: 12 },
    btn: { flex: 1, paddingVertical: 13, borderRadius: 12, alignItems: 'center' },
    btnText: { fontSize: 15, fontWeight: '700' },
});

// ── Unit picker modal ────────────────────────────────────────────────

interface UnitModalProps {
    visible: boolean;
    current: string;
    onSave: (unit: string) => void;
    onClose: () => void;
}

function UnitModal({ visible, current, onSave, onClose }: UnitModalProps) {
    const colors = useTheme();
    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
            <View style={editStyles.backdrop}>
                <View style={[editStyles.sheet, { backgroundColor: colors.cardBackground, gap: 12 }]}>
                    <Text style={[editStyles.title, { color: colors.textPrimary }]}>Pasirinkti vienetą</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                        {UNITS.map(u => (
                            <TouchableOpacity
                                key={u}
                                style={{
                                    paddingVertical: 10, paddingHorizontal: 20, borderRadius: 10,
                                    backgroundColor: u === current ? colors.primary : colors.surfaceMuted,
                                }}
                                onPress={() => { onSave(u); onClose(); }}
                            >
                                <Text style={{ fontWeight: '600', color: u === current ? colors.onPrimary : colors.textPrimary }}>
                                    {u}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                    <TouchableOpacity
                        style={[editStyles.btn, { backgroundColor: colors.surfaceMuted }]}
                        onPress={onClose}
                    >
                        <Text style={[editStyles.btnText, { color: colors.textPrimary }]}>Atšaukti</Text>
                    </TouchableOpacity>
                </View>
            </View>
        </Modal>
    );
}

// ── Confirm-match sheet ──────────────────────────────────────────────

interface MatchSheetProps {
    visible: boolean;
    candidates: MatchCandidate[];
    onConfirm: (c: MatchCandidate) => void;
    onClose: () => void;
}

function MatchSheet({ visible, candidates, onConfirm, onClose }: MatchSheetProps) {
    const colors = useTheme();
    const { t } = useTranslation();
    const [selected, setSelected] = useState<MatchCandidate | null>(candidates[0] ?? null);

    useEffect(() => {
        if (visible) setSelected(candidates[0] ?? null);
    }, [visible, candidates]);

    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
            <View style={editStyles.backdrop}>
                <View style={[editStyles.sheet, { backgroundColor: colors.cardBackground, maxHeight: '80%' }]}>
                    <Text style={[editStyles.title, { color: colors.textPrimary }]}>{t('admin.receipts.matchFound')}</Text>
                    <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator={false}>
                        {candidates.map((c, i) => {
                            const isSel = selected?.storeProductId === c.storeProductId;
                            return (
                                <TouchableOpacity
                                    key={c.storeProductId}
                                    onPress={() => setSelected(c)}
                                    style={{
                                        flexDirection: 'row', alignItems: 'center', gap: 10,
                                        padding: 12, borderRadius: 10, marginBottom: 8,
                                        borderWidth: 1.5,
                                        borderColor: isSel ? colors.primary : colors.border,
                                        backgroundColor: isSel ? colors.primary + '12' : colors.surfaceMuted,
                                    }}
                                >
                                    <View style={{
                                        width: 20, height: 20, borderRadius: 10, borderWidth: 1.5,
                                        borderColor: isSel ? colors.primary : colors.border,
                                        backgroundColor: isSel ? colors.primary : 'transparent',
                                        alignItems: 'center', justifyContent: 'center',
                                    }}>
                                        {isSel && <Ionicons name="checkmark" size={12} color={colors.onPrimary} />}
                                    </View>
                                    <View style={{ flex: 1 }}>
                                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                            <Text style={{ flex: 1, fontSize: 14, fontWeight: '600', color: colors.textPrimary }}>
                                                {c.productName}
                                            </Text>
                                            <Text style={{
                                                fontSize: 11, fontWeight: '700',
                                                color: c.confidence >= 1 ? colors.success : c.confidence >= 0.8 ? colors.primary : colors.textMuted,
                                            }}>
                                                {Math.round(c.confidence * 100)}%
                                            </Text>
                                        </View>
                                        <Text style={{ fontSize: 11, color: colors.textMuted, marginTop: 2 }}>
                                            {c.storeProductName} · SP #{c.storeProductId}
                                        </Text>
                                        {i === 0 && (
                                            <Text style={{ fontSize: 10, fontWeight: '700', color: colors.primary, marginTop: 2 }}>
                                                {t('admin.receipts.bestMatch')}
                                            </Text>
                                        )}
                                    </View>
                                </TouchableOpacity>
                            );
                        })}
                    </ScrollView>
                    <View style={editStyles.row}>
                        <TouchableOpacity
                            style={[editStyles.btn, { backgroundColor: colors.surfaceMuted }]}
                            onPress={onClose}
                        >
                            <Text style={[editStyles.btnText, { color: colors.textPrimary }]}>{t('admin.receipts.denyMatch')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[editStyles.btn, { backgroundColor: selected ? colors.primary : colors.surfaceMuted }]}
                            disabled={!selected}
                            onPress={() => { if (selected) { onConfirm(selected); onClose(); } }}
                        >
                            <Text style={[editStyles.btnText, { color: selected ? colors.onPrimary : colors.textMuted }]}>
                                {t('admin.receipts.confirmMatch')}
                            </Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </View>
        </Modal>
    );
}

// ── Main screen ──────────────────────────────────────────────────────

export default function AdminReceiptDetail() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const navigation = useNavigation();

    const [receipt, setReceipt] = useState<AdminReceiptDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [mode, setMode] = useState<Mode>('review');
    const [actioning, setActioning] = useState(false);

    // Edit modal state
    const [editModal, setEditModal] = useState<{
        type: 'date' | 'name' | 'amount' | 'quantity';
        lineIndex?: number;
        initial: string;
    } | null>(null);
    const [unitModal, setUnitModal] = useState<{ lineIndex: number; current: string } | null>(null);
    const [matchSheet, setMatchSheet] = useState<{ lineIndex: number; candidates: MatchCandidate[] } | null>(null);

    const loadReceipt = useCallback(async () => {
        if (!id) return;
        try {
            const r = await getAdminReceiptDetail(id);
            setReceipt(r);
        } catch {
            Alert.alert('Klaida', 'Nepavyko įkelti kvito.');
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        loadReceipt();
    }, [loadReceipt]);

    useEffect(() => {
        navigation.setOptions({
            title: t('admin.tabReceipts'),
            headerRight: () => (
                <View style={{ flexDirection: 'row', gap: 4, marginRight: 8 }}>
                    {(['review', 'inspect'] as Mode[]).map(m => (
                        <TouchableOpacity
                            key={m}
                            style={{
                                paddingVertical: 5, paddingHorizontal: 12, borderRadius: 8,
                                backgroundColor: mode === m ? colors.primary : colors.surfaceMuted,
                            }}
                            onPress={() => setMode(m)}
                        >
                            <Text style={{ fontSize: 12, fontWeight: '700', color: mode === m ? colors.onPrimary : colors.textSecondary }}>
                                {m === 'review' ? t('admin.receipts.modeReview') : t('admin.receipts.modeInspect')}
                            </Text>
                        </TouchableOpacity>
                    ))}
                </View>
            ),
        });
    }, [mode, colors, t, navigation]);

    const withAction = useCallback(async (fn: () => Promise<void>) => {
        if (actioning) return;
        setActioning(true);
        try {
            await fn();
            await loadReceipt();
        } catch (e: any) {
            Alert.alert('Klaida', String(e?.message ?? 'Nepavyko išsaugoti'));
        } finally {
            setActioning(false);
        }
    }, [actioning, loadReceipt]);

    if (loading || !receipt) {
        return (
            <View style={styles.centered}>
                <MaterialProgress size="large" color={colors.primary} />
            </View>
        );
    }

    const parsedData = receipt.parsedData ?? {};
    const products: any[] = parsedData.products ?? [];
    const footer = parsedData.footer ?? {};
    const header = parsedData.header ?? {};

    const isInspect = mode === 'inspect';

    return (
        <>
            <ScrollView style={styles.root} contentContainerStyle={styles.content}>
                {/* Header card */}
                <View style={styles.card}>
                    <View style={styles.cardRow}>
                        {receipt.chainLogoUrl
                            ? <Image source={{ uri: receipt.chainLogoUrl }} style={styles.chainLogo} resizeMode="contain" />
                            : <View style={[styles.chainLogo, { backgroundColor: colors.surfaceMuted }]} />}
                        <View style={{ flex: 1 }}>
                            <Text style={styles.chainName}>{header.chainName ?? '—'}</Text>
                            <View style={styles.dateRow}>
                                <Text style={styles.dateText}>{receipt.date ?? '—'}</Text>
                                {isInspect && (
                                    <TouchableOpacity
                                        onPress={() => setEditModal({ type: 'date', initial: receipt.date ?? '' })}
                                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                    >
                                        <Ionicons name="create-outline" size={16} color={colors.primary} />
                                    </TouchableOpacity>
                                )}
                            </View>
                        </View>
                        <View style={styles.totalWrap}>
                            <Text style={styles.totalLabel}>Iš viso</Text>
                            <Text style={styles.totalValue}>{footer.total != null ? `${Number(footer.total).toFixed(2)} €` : '—'}</Text>
                        </View>
                    </View>
                </View>

                {/* Product lines */}
                <View style={styles.card}>
                    {products.map((product, idx) => (
                        <View key={idx} style={[styles.line, idx > 0 && styles.lineSeparator]}>
                            <ProductCrop receiptId={id} lineIdx={idx} />
                            {/* Name row */}
                            <View style={styles.lineRow}>
                                <Text style={styles.lineName} numberOfLines={isInspect ? undefined : 2}>
                                    {product.name ?? '—'}
                                </Text>
                                {isInspect && (
                                    <TouchableOpacity
                                        onPress={() => setEditModal({ type: 'name', lineIndex: idx, initial: product.name ?? '' })}
                                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                    >
                                        <Ionicons name="create-outline" size={15} color={colors.primary} />
                                    </TouchableOpacity>
                                )}
                            </View>

                            {/* Match info */}
                            {product.matchedName && (
                                <View style={styles.matchRow}>
                                    <Ionicons name="link" size={11} color={colors.textMuted} />
                                    <Text style={styles.matchText} numberOfLines={1}>{product.matchedName}</Text>
                                    {isInspect && (
                                        <TouchableOpacity
                                            onPress={() => Alert.alert(
                                                t('admin.receipts.unlinkMatch'),
                                                t('admin.receipts.unlinkMatchConfirm'),
                                                [
                                                    { text: 'Atšaukti', style: 'cancel' },
                                                    { text: t('admin.receipts.unlinkMatch'), style: 'destructive', onPress: () => withAction(() => postAdminDenyMatch(id!, idx)) },
                                                ],
                                            )}
                                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                        >
                                            <Text style={styles.unlinkText}>{t('admin.receipts.unlinkMatch')}</Text>
                                        </TouchableOpacity>
                                    )}
                                </View>
                            )}
                            {!product.matchedName && (
                                <Text style={styles.noMatch}>{t('admin.receipts.noMatch')}</Text>
                            )}

                            {/* Fields row */}
                            <View style={styles.fieldsRow}>
                                {/* Unit */}
                                <TouchableOpacity
                                    style={styles.field}
                                    disabled={!isInspect}
                                    onPress={() => isInspect && setUnitModal({ lineIndex: idx, current: product.unit ?? 'vnt' })}
                                >
                                    <Text style={styles.fieldLabel}>Vnt.</Text>
                                    <View style={styles.fieldValueRow}>
                                        <Text style={styles.fieldValue}>{product.unit ?? '—'}</Text>
                                        {isInspect && <Ionicons name="chevron-down" size={12} color={colors.primary} />}
                                    </View>
                                </TouchableOpacity>

                                {/* Quantity */}
                                <TouchableOpacity
                                    style={styles.field}
                                    disabled={!isInspect}
                                    onPress={() => isInspect && setEditModal({ type: 'quantity', lineIndex: idx, initial: String(product.quantity ?? 1) })}
                                >
                                    <Text style={styles.fieldLabel}>Kiekis</Text>
                                    <View style={styles.fieldValueRow}>
                                        <Text style={styles.fieldValue}>×{product.quantity ?? 1}</Text>
                                        {isInspect && <Ionicons name="create-outline" size={12} color={colors.primary} />}
                                    </View>
                                </TouchableOpacity>

                                {/* Amount (SP-level, only if matched) */}
                                {product.storeProductId && (
                                    <TouchableOpacity
                                        style={styles.field}
                                        disabled={!isInspect}
                                        onPress={() => isInspect && setEditModal({ type: 'amount', lineIndex: idx, initial: '' })}
                                    >
                                        <Text style={styles.fieldLabel}>Kiekis/pak.</Text>
                                        <View style={styles.fieldValueRow}>
                                            <Text style={styles.fieldValue}>{t('admin.receipts.editAmount')}</Text>
                                            {isInspect && <Ionicons name="create-outline" size={12} color={colors.primary} />}
                                        </View>
                                    </TouchableOpacity>
                                )}

                                {/* Price */}
                                <View style={styles.field}>
                                    <Text style={styles.fieldLabel}>Kaina</Text>
                                    <Text style={styles.fieldValue}>
                                        {product.price != null ? `${Number(product.price).toFixed(2)} €` : '—'}
                                    </Text>
                                </View>
                            </View>
                        </View>
                    ))}
                </View>
            </ScrollView>

            {actioning && (
                <View style={styles.actioningOverlay}>
                    <MaterialProgress color={colors.onPrimary} />
                </View>
            )}

            {/* Date edit modal */}
            {editModal?.type === 'date' && (
                <EditModal
                    visible
                    title={t('admin.receipts.editDate')}
                    initialValue={editModal.initial}
                    onSave={val => withAction(() => patchAdminReceiptDate(id!, val))}
                    onClose={() => setEditModal(null)}
                />
            )}

            {/* Name edit modal */}
            {editModal?.type === 'name' && editModal.lineIndex !== undefined && (
                <EditModal
                    visible
                    title={t('admin.receipts.editName')}
                    initialValue={editModal.initial}
                    onSave={async val => {
                        const idx = editModal.lineIndex!;
                        await withAction(async () => {
                            const { candidates } = await patchAdminProductName(id!, idx, val);
                            if (candidates.length > 0) {
                                setMatchSheet({ lineIndex: idx, candidates });
                            }
                        });
                    }}
                    onClose={() => setEditModal(null)}
                />
            )}

            {/* Quantity edit modal */}
            {editModal?.type === 'quantity' && editModal.lineIndex !== undefined && (
                <EditModal
                    visible
                    title={t('admin.receipts.editQuantity')}
                    initialValue={editModal.initial}
                    keyboardType="number-pad"
                    onSave={val => {
                        const qty = parseInt(val, 10);
                        if (!Number.isInteger(qty) || qty < 1) return;
                        withAction(async () => { await patchAdminProductQuantity(id!, editModal.lineIndex!, qty); });
                    }}
                    onClose={() => setEditModal(null)}
                />
            )}

            {/* Amount edit modal */}
            {editModal?.type === 'amount' && editModal.lineIndex !== undefined && (
                <EditModal
                    visible
                    title={t('admin.receipts.editAmount')}
                    initialValue={editModal.initial}
                    keyboardType="decimal-pad"
                    onSave={val => {
                        const amt = parseFloat(val.replace(',', '.'));
                        if (!Number.isFinite(amt) || amt <= 0) return;
                        withAction(() => patchAdminProductAmount(id!, editModal.lineIndex!, amt));
                    }}
                    onClose={() => setEditModal(null)}
                />
            )}

            {/* Unit modal */}
            {unitModal && (
                <UnitModal
                    visible
                    current={unitModal.current}
                    onSave={unit => withAction(() => patchAdminProductUnit(id!, unitModal.lineIndex, unit))}
                    onClose={() => setUnitModal(null)}
                />
            )}

            {/* Confirm-match sheet */}
            {matchSheet && (
                <MatchSheet
                    visible
                    candidates={matchSheet.candidates}
                    onConfirm={c => withAction(() => postAdminConfirmMatch(id!, matchSheet.lineIndex, c.storeProductId))}
                    onClose={() => setMatchSheet(null)}
                />
            )}
        </>
    );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
    root: { flex: 1, backgroundColor: c.pageBackground },
    content: { padding: 12, gap: 12, paddingBottom: 40 },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    card: { backgroundColor: c.cardBackground, borderRadius: 16, overflow: 'hidden' },

    cardRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 },
    chainLogo: { width: 36, height: 36, borderRadius: 18 },
    chainName: { fontSize: 15, fontWeight: '700', color: c.textPrimary },
    dateRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
    dateText: { fontSize: 13, color: c.textSecondary },
    totalWrap: { alignItems: 'flex-end' },
    totalLabel: { fontSize: 11, color: c.textMuted },
    totalValue: { fontSize: 18, fontWeight: '700', color: c.textPrimary },

    line: { padding: 14, gap: 6 },
    lineSeparator: { borderTopWidth: 1, borderTopColor: c.borderSubtle },
    lineRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    lineName: { flex: 1, fontSize: 14, fontWeight: '600', color: c.textPrimary },
    matchRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    matchText: { flex: 1, fontSize: 12, color: c.textMuted },
    unlinkText: { fontSize: 12, fontWeight: '600', color: c.error },
    noMatch: { fontSize: 12, color: c.textMuted, fontStyle: 'italic' },

    fieldsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 4 },
    field: { minWidth: 60 },
    fieldLabel: { fontSize: 10, color: c.textMuted, textTransform: 'uppercase', fontWeight: '600', marginBottom: 2 },
    fieldValueRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    fieldValue: { fontSize: 13, fontWeight: '600', color: c.textPrimary },

    actioningOverlay: {
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.3)', alignItems: 'center', justifyContent: 'center',
    },
});
