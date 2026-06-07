import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    Modal,
    ScrollView,
    Platform,
    Animated,
    PanResponder,
    LayoutAnimation,
} from 'react-native';
import { useMemo, useState, useEffect, useRef } from 'react';
import { type ScrollView as ScrollViewType } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, type AppTheme } from '../constants/theme';
import {
    getLocationSettings,
    saveLocationSettings,
    getPresets,
    type LocationSettings,
    type LocationPreset,
    type PresetKey,
    type TransportMode,
    type LocationMode,
} from '../utils/locationStorage';

interface Props {
    visible: boolean;
    onClose: () => void;
    refreshKey?: number;
    onOpenPresetMap: (key: PresetKey, label: string, existing: LocationPreset | null) => void;
}

const PRESET_LABELS: Record<PresetKey, string> = {
    home: 'Namai',
    work: 'Darbas',
    custom: 'Kita',
};

const PRESET_KEYS: PresetKey[] = ['home', 'work', 'custom'];

export default function LocationSettingsModal({ visible, onClose, refreshKey, onOpenPresetMap }: Props) {
    const colors = useTheme();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const { bottom: bottomInset } = useSafeAreaInsets();

    const [settings, setSettings] = useState<LocationSettings>({
        transport: 'bus',
        mode: 'current',
        specificPreset: null,
        routeFrom: null,
        routeTo: null,
        storeCount: 1,
    });
    const scrollRef = useRef<ScrollViewType>(null);

    const [presets, setPresets] = useState<Record<PresetKey, LocationPreset | null>>({
        home: null,
        work: null,
        custom: null,
    });

    const translateY = useRef(new Animated.Value(600)).current;
    const panResponder = useRef(PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderMove: (_, gs) => { if (gs.dy > 0) translateY.setValue(gs.dy); },
        onPanResponderRelease: (_, gs) => {
            if (gs.dy > 100 || gs.vy > 0.8) {
                Animated.timing(translateY, { toValue: 800, duration: 200, useNativeDriver: true })
                    .start(() => onClose());
            } else {
                Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
            }
        },
        onPanResponderTerminate: () => {
            Animated.spring(translateY, { toValue: 0, useNativeDriver: true }).start();
        },
    })).current;

    useEffect(() => {
        if (!visible) return;
        // Reset off-screen then spring up — we own the enter animation (animationType="none")
        translateY.setValue(600);
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 5, speed: 14 }).start();
        Promise.all([getLocationSettings(), getPresets()]).then(([s, p]) => {
            setSettings(s);
            setPresets(p);
        });
    }, [visible, refreshKey]);

    const update = async (patch: Partial<LocationSettings>) => {
        const next = { ...settings, ...patch };
        setSettings(next);
        await saveLocationSettings(patch);
    };

    const handleTransport = (t: TransportMode) => update({ transport: t });

    const handleMode = (m: LocationMode) => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        const patch: Partial<LocationSettings> = { mode: m };
        if (m === 'current') {
            patch.specificPreset = null;
            patch.routeFrom = null;
            patch.routeTo = null;
        }
        if (m === 'specific' && !settings.specificPreset) {
            const first = PRESET_KEYS.find(k => !!presets[k]);
            if (first) patch.specificPreset = first;
        }
        update(patch);
        if (m === 'route' || m === 'specific') {
            setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 200);
        }
    };

    const handleSpecificPreset = (key: PresetKey) => {
        if (!presets[key]) return; // not set yet — user must add it first
        update({ specificPreset: key });
    };

    const handleRouteEndpoint = (endpoint: 'from' | 'to', key: PresetKey) => {
        if (!presets[key]) return;
        update(endpoint === 'from' ? { routeFrom: key } : { routeTo: key });
    };

    const availablePresets = PRESET_KEYS.filter(k => !!presets[k]);

    return (
        <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
                <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose} />
                <Animated.View style={[styles.sheet, { paddingBottom: Math.max(bottomInset, 16), transform: [{ translateY }] }]}>
                    {/* Handle — drag to close */}
                    <View {...panResponder.panHandlers} style={styles.handleTouchArea}>
                        <View style={styles.handle} />
                    </View>
                    <View style={styles.header}>
                        <Text style={styles.title}>Parduotuvių paieškos nustatymai</Text>
                        <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                            <Ionicons name="close" size={22} color={colors.textSecondary} />
                        </TouchableOpacity>
                    </View>

                    <ScrollView ref={scrollRef} showsVerticalScrollIndicator={false} bounces={false}>
                        {/* ── Store count — always first ── */}
                        <Text style={styles.sectionLabel}>Kiek parduotuvių aplankysite</Text>
                        <View style={styles.countRow}>
                            {([1, 2, 3] as const).map(n => (
                                <TouchableOpacity
                                    key={n}
                                    style={[styles.countBtn, settings.storeCount === n && styles.countBtnActive]}
                                    onPress={() => update({ storeCount: n })}
                                >
                                    <Text style={[styles.countBtnText, settings.storeCount === n && styles.countBtnTextActive]}>
                                        {n}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                        <Text style={styles.countHint}>
                            {settings.storeCount === 1
                                ? 'Rekomenduojama 1 parduotuvė'
                                : settings.storeCount === 2
                                ? 'Palyginami apsipirkimai 1 ir 2 parduotuvėse'
                                : 'Palyginami apsipirkimai iki 3 parduotuvių kombinacijose'}
                        </Text>

                        {/* ── Location mode ── */}
                        <Text style={styles.sectionLabel}>Kur ieškoti parduotuvių?</Text>
                        <View style={styles.segmentRow}>
                            <SegmentBtn
                                label="GPS"
                                icon="locate-outline"
                                active={settings.mode === 'current'}
                                onPress={() => handleMode('current')}
                                colors={colors}
                                styles={styles}
                            />
                            <SegmentBtn
                                label="Vieta"
                                icon="location-outline"
                                active={settings.mode === 'specific'}
                                onPress={() => handleMode('specific')}
                                colors={colors}
                                styles={styles}
                            />
                            <SegmentBtn
                                label="Kelias"
                                icon="git-commit-outline"
                                active={settings.mode === 'route'}
                                onPress={() => handleMode('route')}
                                colors={colors}
                                styles={styles}
                            />
                        </View>

                        {/* ── Specific location — preset picker ── */}
                        {settings.mode === 'specific' && (
                            <View style={styles.presetBlock}>
                                {PRESET_KEYS.map(key => (
                                    <PresetRow
                                        key={key}
                                        presetKey={key}
                                        label={PRESET_LABELS[key]}
                                        preset={presets[key]}
                                        selected={settings.specificPreset === key}
                                        onSelect={() => handleSpecificPreset(key)}
                                        onAdd={() => onOpenPresetMap(key, PRESET_LABELS[key], null)}
                                        onEdit={() => onOpenPresetMap(key, PRESET_LABELS[key], presets[key])}
                                        colors={colors}
                                        styles={styles}
                                    />
                                ))}
                            </View>
                        )}

                        {/* ── Route — from/to pickers ── */}
                        {settings.mode === 'route' && (
                            <View style={styles.presetBlock}>
                                <Text style={styles.routeRowLabel}>Iš:</Text>
                                {PRESET_KEYS.map(key => (
                                    <PresetRow
                                        key={`from-${key}`}
                                        presetKey={key}
                                        label={PRESET_LABELS[key]}
                                        preset={presets[key]}
                                        selected={settings.routeFrom === key}
                                        disabled={settings.routeTo === key}
                                        onSelect={() => handleRouteEndpoint('from', key)}
                                        onAdd={() => onOpenPresetMap(key, PRESET_LABELS[key], null)}
                                        onEdit={() => onOpenPresetMap(key, PRESET_LABELS[key], presets[key])}
                                        colors={colors}
                                        styles={styles}
                                        compact
                                    />
                                ))}
                                <View style={styles.routeSeparator} />
                                <Text style={styles.routeRowLabel}>Į:</Text>
                                {PRESET_KEYS.map(key => (
                                    <PresetRow
                                        key={`to-${key}`}
                                        presetKey={key}
                                        label={PRESET_LABELS[key]}
                                        preset={presets[key]}
                                        selected={settings.routeTo === key}
                                        disabled={settings.routeFrom === key}
                                        onSelect={() => handleRouteEndpoint('to', key)}
                                        onAdd={() => onOpenPresetMap(key, PRESET_LABELS[key], null)}
                                        onEdit={() => onOpenPresetMap(key, PRESET_LABELS[key], presets[key])}
                                        colors={colors}
                                        styles={styles}
                                        compact
                                    />
                                ))}
                                {availablePresets.length === 0 && (
                                    <Text style={styles.routeHint}>
                                        Pridėkite bent vieną vietą, kad galėtumėte naudoti maršruto režimą.
                                    </Text>
                                )}
                            </View>
                        )}

                        {/* ── Transport — only relevant for route mode ── */}
                        {settings.mode === 'route' && (
                            <>
                                <Text style={styles.sectionLabel}>Transportas</Text>
                                <View style={styles.segmentRow}>
                                    <SegmentBtn
                                        label="Autobusas"
                                        icon="bus-outline"
                                        active={settings.transport === 'bus'}
                                        onPress={() => handleTransport('bus')}
                                        colors={colors}
                                        styles={styles}
                                    />
                                    <SegmentBtn
                                        label="Automobilis"
                                        icon="car-outline"
                                        active={settings.transport === 'car'}
                                        onPress={() => handleTransport('car')}
                                        colors={colors}
                                        styles={styles}
                                    />
                                </View>
                            </>
                        )}
                    </ScrollView>
                </Animated.View>
            </Modal>
    );
}

// ── Sub-components ──────────────────────────────────────────────────────────

interface SegmentBtnProps {
    label: string;
    icon: string;
    active: boolean;
    onPress: () => void;
    colors: AppTheme;
    styles: ReturnType<typeof makeStyles>;
}

function SegmentBtn({ label, icon, active, onPress, colors, styles }: SegmentBtnProps) {
    return (
        <TouchableOpacity
            style={[styles.segment, active && styles.segmentActive]}
            onPress={onPress}
        >
            <Ionicons name={icon as any} size={16} color={active ? colors.onPrimary : colors.textSecondary} />
            <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{label}</Text>
        </TouchableOpacity>
    );
}

interface PresetRowProps {
    presetKey: PresetKey;
    label: string;
    preset: LocationPreset | null;
    selected: boolean;
    disabled?: boolean;
    onSelect: () => void;
    onAdd: () => void;
    onEdit: () => void;
    colors: AppTheme;
    styles: ReturnType<typeof makeStyles>;
    compact?: boolean;
}

function PresetRow({
    presetKey,
    label,
    preset,
    selected,
    disabled,
    onSelect,
    onAdd,
    onEdit,
    colors,
    styles,
    compact,
}: PresetRowProps) {
    return (
        <TouchableOpacity
            style={[
                styles.presetRow,
                selected && styles.presetRowSelected,
                compact && styles.presetRowCompact,
                disabled && styles.presetRowDisabled,
            ]}
            onPress={disabled ? undefined : preset ? onSelect : onAdd}
            activeOpacity={disabled ? 1 : 0.7}
        >
            {/* Radio / placeholder */}
            <View style={[styles.radio, selected && styles.radioSelected]}>
                {selected && <View style={styles.radioDot} />}
            </View>

            <View style={styles.presetRowContent}>
                <Text style={styles.presetRowLabel}>{label}</Text>
                {preset ? (
                    <Text style={styles.presetRowSub} numberOfLines={1}>
                        {preset.address ?? preset.label}
                    </Text>
                ) : (
                    <Text style={styles.presetRowAdd}>+ Pridėti</Text>
                )}
            </View>

            {preset && !disabled && (
                <TouchableOpacity
                    onPress={onEdit}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    style={styles.editBtn}
                >
                    <Ionicons name="pencil-outline" size={15} color={colors.textMuted} />
                </TouchableOpacity>
            )}
        </TouchableOpacity>
    );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const makeStyles = (c: AppTheme) =>
    StyleSheet.create({
        overlay: {
            flex: 1,
            backgroundColor: c.overlayBackdrop,
        },
        sheet: {
            backgroundColor: c.cardBackground,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            paddingHorizontal: 20,
            paddingTop: 10,
            maxHeight: '92%',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: -2 },
            shadowOpacity: 0.12,
            shadowRadius: 10,
            elevation: 16,
        },
        handleTouchArea: {
            alignSelf: 'stretch',
            alignItems: 'center',
            paddingVertical: 12,
            marginTop: -10,
        },
        handle: {
            width: 40,
            height: 4,
            borderRadius: 2,
            backgroundColor: c.border,
        },
        header: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 20,
        },
        title: {
            fontSize: 16,
            fontWeight: '700',
            color: c.textPrimary,
        },
        sectionLabel: {
            fontSize: 12,
            fontWeight: '600',
            color: c.textMuted,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            marginBottom: 8,
            marginTop: 4,
        },
        segmentRow: {
            flexDirection: 'row',
            gap: 8,
            marginBottom: 18,
        },
        segment: {
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            paddingVertical: 11,
            borderRadius: 10,
            backgroundColor: c.surfaceMuted,
            borderWidth: 1,
            borderColor: 'transparent',
        },
        segmentActive: {
            backgroundColor: c.primary,
            borderColor: c.primary,
        },
        segmentText: {
            fontSize: 13,
            fontWeight: '600',
            color: c.textSecondary,
        },
        segmentTextActive: {
            color: c.onPrimary,
        },
        presetBlock: {
            marginBottom: 18,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: c.border,
            overflow: 'hidden',
        },
        presetRow: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingVertical: 13,
            paddingHorizontal: 14,
            backgroundColor: c.cardBackground,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: c.border,
        },
        presetRowCompact: {
            paddingVertical: 10,
        },
        presetRowSelected: {
            backgroundColor: c.primaryMuted,
        },
        presetRowDisabled: {
            opacity: 0.38,
        },
        radio: {
            width: 18,
            height: 18,
            borderRadius: 9,
            borderWidth: 2,
            borderColor: c.border,
            alignItems: 'center',
            justifyContent: 'center',
        },
        radioSelected: {
            borderColor: c.primary,
        },
        radioDot: {
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: c.primary,
        },
        presetRowContent: {
            flex: 1,
        },
        presetRowLabel: {
            fontSize: 14,
            fontWeight: '600',
            color: c.textPrimary,
        },
        presetRowSub: {
            fontSize: 12,
            color: c.textSecondary,
            marginTop: 1,
        },
        presetRowAdd: {
            fontSize: 12,
            color: c.primary,
            fontWeight: '600',
            marginTop: 1,
        },
        editBtn: {
            padding: 4,
        },
        routeRowLabel: {
            fontSize: 12,
            fontWeight: '700',
            color: c.textMuted,
            paddingHorizontal: 14,
            paddingTop: 10,
            paddingBottom: 4,
            backgroundColor: c.cardBackground,
        },
        routeSeparator: {
            height: StyleSheet.hairlineWidth,
            backgroundColor: c.border,
            marginVertical: 4,
        },
        routeHint: {
            fontSize: 12,
            color: c.textMuted,
            padding: 14,
            textAlign: 'center',
        },
        countRow: {
            flexDirection: 'row',
            gap: 10,
            marginBottom: 8,
        },
        countBtn: {
            flex: 1,
            paddingVertical: 14,
            alignItems: 'center',
            borderRadius: 10,
            backgroundColor: c.surfaceMuted,
            borderWidth: 1,
            borderColor: 'transparent',
        },
        countBtnActive: {
            backgroundColor: c.primary,
            borderColor: c.primary,
        },
        countBtnText: {
            fontSize: 18,
            fontWeight: '700',
            color: c.textSecondary,
        },
        countBtnTextActive: {
            color: c.onPrimary,
        },
        countHint: {
            fontSize: 12,
            color: c.textMuted,
            textAlign: 'center',
            marginBottom: 18,
        },
    });
