import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
} from 'react-native';
import { useMemo, useState, useEffect, useRef } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, radius, type AppTheme } from '../constants/theme';
import { useTranslation } from 'react-i18next';
import Reanimated, { FadeInDown, LinearTransition } from 'react-native-reanimated';
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

/**
 * Store-search settings CONTENT — store count, location mode (GPS / place /
 * route with from→to dropdowns + swap), transport. Chrome-free: it renders
 * inside a host surface (the basket screen's GlassStageSheet bar-sheet) which
 * owns the drag pill, glass material and stage management. Every change is
 * persisted immediately and reported via `onChanged`, so the host can reflect
 * state (e.g. the incomplete-route "!" badge) live, not on close.
 */

interface Props {
    /** Bump to re-load settings + presets (e.g. after the preset map saves). */
    refreshKey?: number;
    onOpenPresetMap: (key: PresetKey, label: string, existing: LocationPreset | null) => void;
    onChanged?: (next: LocationSettings) => void;
}

const PRESET_KEYS: PresetKey[] = ['home', 'work', 'custom'];

export default function LocationSettingsPanel({ refreshKey, onOpenPresetMap, onChanged }: Props) {
    const colors = useTheme();
    const { t } = useTranslation();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const presetLabels: Record<PresetKey, string> = {
        home: t('locationSettings.presetHome'),
        work: t('locationSettings.presetWork'),
        custom: t('locationSettings.presetCustom'),
    };

    const [settings, setSettings] = useState<LocationSettings>({
        transport: 'bus',
        mode: 'current',
        specificPreset: null,
        routeFrom: null,
        routeTo: null,
        storeCount: 1,
    });

    const [presets, setPresets] = useState<Record<PresetKey, LocationPreset | null>>({
        home: null,
        work: null,
        custom: null,
    });

    // Which route dropdown is expanded.
    const [openMenu, setOpenMenu] = useState<'from' | 'to' | null>(null);
    // Remembers WHY the user went to the preset map ("route from = home") so
    // that confirming the new location auto-applies it — without this the user
    // had to reopen the dropdown and pick the freshly-created preset AGAIN.
    const pendingApplyRef = useRef<{ endpoint: 'from' | 'to' | 'specific'; key: PresetKey } | null>(null);

    useEffect(() => {
        setOpenMenu(null);
        Promise.all([getLocationSettings(), getPresets()]).then(([s, p]) => {
            setSettings(s);
            setPresets(p);
            const pending = pendingApplyRef.current;
            pendingApplyRef.current = null;
            if (pending && p[pending.key]) {
                // The awaited preset now exists — finish the original intent.
                const patch: Partial<LocationSettings> =
                    pending.endpoint === 'specific' ? { specificPreset: pending.key }
                    : pending.endpoint === 'from' ? { routeFrom: pending.key }
                    : { routeTo: pending.key };
                const next = { ...s, ...patch };
                setSettings(next);
                onChanged?.(next);
                void saveLocationSettings(patch);
            }
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [refreshKey]);

    const update = async (patch: Partial<LocationSettings>) => {
        const next = { ...settings, ...patch };
        setSettings(next);
        onChanged?.(next);
        await saveLocationSettings(patch);
    };

    const handleTransport = (t: TransportMode) => update({ transport: t });

    const handleMode = (m: LocationMode) => {
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
        setOpenMenu(null);
        update(patch);
    };

    const handleSpecificPreset = (key: PresetKey) => {
        if (!presets[key]) return; // not set yet — user must add it first
        update({ specificPreset: key });
    };

    /** Pick an endpoint value from a dropdown. The option held by the OTHER
     *  endpoint is offered greyed but SELECTABLE — picking it TAKES it over
     *  and vacates the other endpoint (the route is then incomplete until the
     *  user picks the freed side; the basket screen flags that state). */
    const pickRouteOption = (endpoint: 'from' | 'to', key: PresetKey) => {
        setOpenMenu(null);
        if (!presets[key]) {
            pendingApplyRef.current = { endpoint, key };
            onOpenPresetMap(key, presetLabels[key], null);
            return;
        }
        const patch: Partial<LocationSettings> =
            endpoint === 'from' ? { routeFrom: key } : { routeTo: key };
        const otherValue = endpoint === 'from' ? settings.routeTo : settings.routeFrom;
        if (otherValue === key) {
            if (endpoint === 'from') patch.routeTo = null;
            else patch.routeFrom = null;
        }
        update(patch);
    };

    /** ⇅ — "Iš namų į darbą" becomes "Iš darbo į namus" in one tap. Works
     *  with a half-set route too (the single value hops to the other side). */
    const handleSwap = () => {
        setOpenMenu(null);
        update({ routeFrom: settings.routeTo, routeTo: settings.routeFrom });
    };

    const availablePresets = PRESET_KEYS.filter(k => !!presets[k]);

    return (
        <View>
            <View style={styles.header}>
                <Text style={styles.title}>{t('locationSettings.title')}</Text>
            </View>

            {/* ── Store count — always first ── */}
            <Text style={styles.sectionLabel}>{t('locationSettings.storeCountLabel')}</Text>
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
                    ? t('locationSettings.storeCountHint1')
                    : settings.storeCount === 2
                    ? t('locationSettings.storeCountHint2')
                    : t('locationSettings.storeCountHint3')}
            </Text>

            {/* ── Location mode ── */}
            <Text style={styles.sectionLabel}>{t('locationSettings.modeLabel')}</Text>
            <View style={styles.segmentRow}>
                <SegmentBtn
                    label={t('locationSettings.modeGps')}
                    icon="locate-outline"
                    active={settings.mode === 'current'}
                    onPress={() => handleMode('current')}
                    colors={colors}
                    styles={styles}
                />
                <SegmentBtn
                    label={t('locationSettings.modePlace')}
                    icon="location-outline"
                    active={settings.mode === 'specific'}
                    onPress={() => handleMode('specific')}
                    colors={colors}
                    styles={styles}
                />
                <SegmentBtn
                    label={t('locationSettings.modeRoute')}
                    icon="git-commit-outline"
                    active={settings.mode === 'route'}
                    onPress={() => handleMode('route')}
                    colors={colors}
                    styles={styles}
                />
            </View>

            {/* ── Specific location — preset picker ── */}
            {settings.mode === 'specific' && (
                <Reanimated.View style={styles.presetBlock} entering={FadeInDown.duration(220)} layout={LinearTransition.duration(200)}>
                    {PRESET_KEYS.map(key => (
                        <PresetRow
                            key={key}
                            presetKey={key}
                            label={presetLabels[key]}
                            preset={presets[key]}
                            selected={settings.specificPreset === key}
                            onSelect={() => handleSpecificPreset(key)}
                            onAdd={() => {
                                pendingApplyRef.current = { endpoint: 'specific', key };
                                onOpenPresetMap(key, presetLabels[key], null);
                            }}
                            onEdit={() => onOpenPresetMap(key, presetLabels[key], presets[key])}
                            colors={colors}
                            styles={styles}
                        />
                    ))}
                </Reanimated.View>
            )}

            {/* ── Route — two dropdown fields + swap (Google-Maps-style) ── */}
            {settings.mode === 'route' && (
                <Reanimated.View style={styles.presetBlock} entering={FadeInDown.duration(220)} layout={LinearTransition.duration(200)}>
                    <View style={styles.routeFieldsRow}>
                        <View style={styles.routeFieldsCol}>
                            <RouteField
                                label={t('locationSettings.routeFrom')}
                                valueLabel={settings.routeFrom ? presetLabels[settings.routeFrom] : null}
                                open={openMenu === 'from'}
                                onPress={() => setOpenMenu(m => (m === 'from' ? null : 'from'))}
                                colors={colors}
                                styles={styles}
                            />
                            <View style={styles.routeSeparator} />
                            <RouteField
                                label={t('locationSettings.routeTo')}
                                valueLabel={settings.routeTo ? presetLabels[settings.routeTo] : null}
                                open={openMenu === 'to'}
                                onPress={() => setOpenMenu(m => (m === 'to' ? null : 'to'))}
                                colors={colors}
                                styles={styles}
                            />
                        </View>
                        <TouchableOpacity
                            style={styles.swapBtn}
                            onPress={handleSwap}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            accessibilityLabel={t('locationSettings.swap')}
                        >
                            <Ionicons name="swap-vertical" size={18} color={colors.primary} />
                        </TouchableOpacity>
                    </View>
                    {openMenu != null && (
                        <Reanimated.View entering={FadeInDown.duration(160)}>
                            <View style={styles.routeSeparator} />
                            {PRESET_KEYS.map(key => {
                                const takenByOther = openMenu === 'from'
                                    ? settings.routeTo === key
                                    : settings.routeFrom === key;
                                return (
                                    <PresetRow
                                        key={`${openMenu}-${key}`}
                                        presetKey={key}
                                        label={presetLabels[key]}
                                        preset={presets[key]}
                                        selected={(openMenu === 'from' ? settings.routeFrom : settings.routeTo) === key}
                                        dimmed={takenByOther}
                                        onSelect={() => pickRouteOption(openMenu, key)}
                                        onAdd={() => pickRouteOption(openMenu, key)}
                                        onEdit={() => onOpenPresetMap(key, presetLabels[key], presets[key])}
                                        colors={colors}
                                        styles={styles}
                                        compact
                                    />
                                );
                            })}
                        </Reanimated.View>
                    )}
                    {availablePresets.length === 0 && (
                        <Text style={styles.routeHint}>
                            {t('locationSettings.routeHint')}
                        </Text>
                    )}
                </Reanimated.View>
            )}

            {/* ── Transport — only relevant for route mode ── */}
            {settings.mode === 'route' && (
                <Reanimated.View entering={FadeInDown.duration(220)} layout={LinearTransition.duration(200)}>
                    <Text style={styles.sectionLabel}>{t('locationSettings.transportLabel')}</Text>
                    <View style={styles.segmentRow}>
                        <SegmentBtn
                            label={t('locationSettings.transportBus')}
                            icon="bus-outline"
                            active={settings.transport === 'bus'}
                            onPress={() => handleTransport('bus')}
                            colors={colors}
                            styles={styles}
                        />
                        <SegmentBtn
                            label={t('locationSettings.transportCar')}
                            icon="car-outline"
                            active={settings.transport === 'car'}
                            onPress={() => handleTransport('car')}
                            colors={colors}
                            styles={styles}
                        />
                    </View>
                </Reanimated.View>
            )}
        </View>
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

/** One compact dropdown field: "Iš:  Namai  ⌄". Tapping toggles the shared
 *  option list below the fields. */
function RouteField({ label, valueLabel, open, onPress, colors, styles }: {
    label: string;
    valueLabel: string | null;
    open: boolean;
    onPress: () => void;
    colors: AppTheme;
    styles: ReturnType<typeof makeStyles>;
}) {
    const { t } = useTranslation();
    return (
        <TouchableOpacity style={styles.routeField} onPress={onPress} activeOpacity={0.7}>
            <Text style={styles.routeFieldLabel}>{label}</Text>
            <Text
                style={[styles.routeFieldValue, !valueLabel && styles.routeFieldPlaceholder]}
                numberOfLines={1}
            >
                {valueLabel ?? t('locationSettings.select')}
            </Text>
            <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} />
        </TouchableOpacity>
    );
}

interface PresetRowProps {
    presetKey: PresetKey;
    label: string;
    preset: LocationPreset | null;
    selected: boolean;
    /** Greyed-out but still SELECTABLE (the value currently held by the other
     *  route endpoint — picking it takes it over and vacates that endpoint). */
    dimmed?: boolean;
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
    dimmed,
    onSelect,
    onAdd,
    onEdit,
    colors,
    styles,
    compact,
}: PresetRowProps) {
    const { t } = useTranslation();
    return (
        <TouchableOpacity
            style={[
                styles.presetRow,
                selected && styles.presetRowSelected,
                compact && styles.presetRowCompact,
                dimmed && styles.presetRowDisabled,
            ]}
            onPress={preset ? onSelect : onAdd}
            activeOpacity={0.7}
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
                    <Text style={styles.presetRowAdd}>{t('locationSettings.add')}</Text>
                )}
            </View>

            {preset && !dimmed && (
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
        header: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 16,
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
            borderRadius: radius.md,
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
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: c.border,
            overflow: 'hidden',
            // Solid on the glass sheet — rows read as a card, and the
            // hint/option area can't show raw glass between rows.
            backgroundColor: c.cardBackground,
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
        routeFieldsRow: {
            flexDirection: 'row',
            alignItems: 'stretch',
            backgroundColor: c.cardBackground,
        },
        routeFieldsCol: {
            flex: 1,
        },
        routeField: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingVertical: 13,
            paddingLeft: 14,
            paddingRight: 6,
        },
        routeFieldLabel: {
            fontSize: 13,
            fontWeight: '700',
            color: c.textMuted,
            minWidth: 24,
        },
        routeFieldValue: {
            flex: 1,
            fontSize: 14,
            fontWeight: '600',
            color: c.textPrimary,
        },
        routeFieldPlaceholder: {
            color: c.primary,
        },
        swapBtn: {
            width: 44,
            alignItems: 'center',
            justifyContent: 'center',
            borderLeftWidth: StyleSheet.hairlineWidth,
            borderLeftColor: c.border,
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
            borderRadius: radius.md,
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
