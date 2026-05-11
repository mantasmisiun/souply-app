import { View, Text, Image, StyleSheet } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';
import * as Haptics from 'expo-haptics';

export interface DonutSlice {
    label: string;
    value: number;
    color: string;
    logoUri?: string | null;
}

interface Props {
    data: DonutSlice[];
    size?: number;
    thickness?: number;
    emptyColor?: string;
    selectedIndex?: number | null;
    onSelect?: (index: number | null) => void;
    cardBackground?: string;
}

function polarToCartesian(cx: number, cy: number, r: number, deg: number) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number) {
    const s = polarToCartesian(cx, cy, r, startDeg);
    const e = polarToCartesian(cx, cy, r, endDeg);
    const large = endDeg - startDeg > 180 ? 1 : 0;
    return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`;
}

const GAP = 3;
// Extra SVG space on each side so the thicker selected arc (thickness+8 → +4px outward)
// never clips. Disc View stays at size×size as a sibling, not a parent of the SVG.
const OVERFLOW = 8;

// Approximate height of the text block (centerValue lineHeight + centerSub + marginTop).
const TEXT_BLOCK_H = 20 + 1 + 12; // ~33px

type Segment = { path: string; color: string; dataIndex: number | null };

export function DonutChart({
    data,
    size = 200,
    thickness = 28,
    emptyColor = '#E5E7EB',
    selectedIndex,
    onSelect,
    cardBackground = '#FFFFFF',
}: Props) {
    const svgSize = size + OVERFLOW * 2;
    const cx = svgSize / 2;
    const cy = svgSize / 2;
    const r = (size - thickness) / 2;
    const total = data.reduce((s, d) => s + d.value, 0);

    const segments: Segment[] = [];

    if (total === 0) {
        segments.push({
            path: `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.001} ${cy - r}`,
            color: emptyColor,
            dataIndex: null,
        });
    } else if (data.length === 1) {
        segments.push({
            path: `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.001} ${cy - r}`,
            color: data[0].color,
            dataIndex: 0,
        });
    } else {
        let angle = 0;
        data.forEach((slice, i) => {
            const sweep = (slice.value / total) * 360;
            const start = angle + GAP / 2;
            const end = angle + sweep - GAP / 2;
            if (end > start) {
                segments.push({ path: arcPath(cx, cy, r, start, end), color: slice.color, dataIndex: i });
            }
            angle += sweep;
        });
    }

    const anySelected = selectedIndex !== null && selectedIndex !== undefined;
    const selectedSlice = anySelected && selectedIndex! < data.length ? data[selectedIndex!] : null;
    const centerValue = selectedSlice ? selectedSlice.value : total;
    const centerLabel = selectedSlice ? selectedSlice.label : 'Iš viso';
    const displayLabel = centerLabel.length > 14 ? centerLabel.slice(0, 13) + '…' : centerLabel;

    const holeRadius = r - thickness / 2 - 4;

    // Logo sits above the text block inside the hole, outside the centerLabel flow so it
    // never shifts the text position — the amount always renders identically to the total state.
    const LOGO_SIZE = 28;
    const logoTop = cy - TEXT_BLOCK_H / 2 - LOGO_SIZE - 4;
    const logoLeft = cx - LOGO_SIZE / 2;

    return (
        <View style={{ width: svgSize, height: svgSize, alignItems: 'center', justifyContent: 'center' }}>
            {/* Shadow disc — sibling of SVG so its borderRadius never clips the arcs */}
            <View style={[
                styles.disc,
                { width: size, height: size, borderRadius: size / 2, backgroundColor: cardBackground, position: 'absolute' },
            ]} />

            <Svg width={svgSize} height={svgSize}>
                {segments.map((seg, i) => {
                    const isSelected = seg.dataIndex !== null && seg.dataIndex === selectedIndex;
                    return (
                        <Path
                            key={i}
                            d={seg.path}
                            stroke={seg.color}
                            strokeWidth={isSelected ? thickness + 8 : thickness}
                            fill="none"
                            strokeLinecap="round"
                            onPress={seg.dataIndex !== null && onSelect ? () => {
                                Haptics.selectionAsync();
                                const idx = seg.dataIndex as number;
                                onSelect(selectedIndex === idx ? null : idx);
                            } : undefined}
                        />
                    );
                })}

                {/* Tap center hole to deselect */}
                {anySelected && onSelect && (
                    <Circle cx={cx} cy={cy} r={holeRadius} fill="transparent" onPress={() => { Haptics.selectionAsync(); onSelect(null); }} />
                )}
            </Svg>

            {/* Logo floats above the text block without affecting its layout */}
            {selectedSlice?.logoUri && (
                <View pointerEvents="none" style={{ position: 'absolute', top: logoTop, left: logoLeft }}>
                    <Image
                        source={{ uri: selectedSlice.logoUri }}
                        style={{ width: LOGO_SIZE, height: LOGO_SIZE, borderRadius: 4 }}
                        resizeMode="contain"
                    />
                </View>
            )}

            {/* Center label — always identical structure: amount + sub-label.
                Sub-label is hidden (opacity 0) when the logo is shown, but still takes up
                its natural height so the amount renders at the exact same position as in
                the total (unselected) state — same font context, same pixel position. */}
            <View pointerEvents="none" style={styles.centerLabel}>
                <Text style={styles.centerValue}>{centerValue.toFixed(2)}€</Text>
                <Text style={[styles.centerSub, selectedSlice?.logoUri ? { opacity: 0 } : null]}>
                    {displayLabel}
                </Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    disc: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.12,
        shadowRadius: 8,
        elevation: 6,
    },
    centerLabel: {
        position: 'absolute',
        alignItems: 'center',
    },
    centerValue: {
        fontSize: 16,
        fontWeight: '700',
        color: '#111827',
        lineHeight: 20,
    },
    centerSub: {
        fontSize: 10,
        color: '#6B7280',
        marginTop: 1,
    },
});
