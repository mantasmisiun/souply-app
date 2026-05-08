import { View, StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';

export interface DonutSlice {
    label: string;
    value: number;
    color: string;
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

const GAP = 2;

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
    const cx = size / 2;
    const cy = size / 2;
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

    return (
        // Circular card gives the disc a raised 3D feel via elevation/shadow.
        // cardBackground fills the donut hole so it matches the parent card.
        <View style={[styles.disc, { width: size, height: size, borderRadius: size / 2, backgroundColor: cardBackground }]}>
            <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
                {segments.map((seg, i) => {
                    const isSelected = seg.dataIndex !== null && seg.dataIndex === selectedIndex;
                    return (
                        <Path
                            key={i}
                            d={seg.path}
                            stroke={anySelected && !isSelected ? emptyColor : seg.color}
                            strokeWidth={thickness}
                            fill="none"
                            strokeLinecap="butt"
                            onPress={seg.dataIndex !== null && onSelect ? () => {
                                const idx = seg.dataIndex as number;
                                onSelect(selectedIndex === idx ? null : idx);
                            } : undefined}
                        />
                    );
                })}
            </Svg>
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
});
