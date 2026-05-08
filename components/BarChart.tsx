import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Rect, Text as SvgText } from 'react-native-svg';

export interface BarSlice {
    label: string;
    total: number;
}

interface Props {
    data: BarSlice[];
    color: string;
    height?: number;
}

const LABEL_PAD = 20; // top padding so value labels above the tallest bar never clip

export function BarChart({ data, color, height = 120 }: Props) {
    const max = Math.max(...data.map(d => d.total), 0.01);
    const barAreaHeight = height;
    const svgHeight = barAreaHeight + LABEL_PAD;
    const barWidth = 28;
    const gap = 8;
    const totalWidth = data.length * (barWidth + gap) - gap;

    return (
        <View style={{ alignItems: 'center' }}>
            <Svg width={totalWidth} height={svgHeight}>
                {data.map((bar, i) => {
                    const barH = Math.max((bar.total / max) * (barAreaHeight - 20), bar.total > 0 ? 4 : 0);
                    const x = i * (barWidth + gap);
                    const y = LABEL_PAD + (barAreaHeight - barH - 18);
                    return (
                        <React.Fragment key={i}>
                            <Rect
                                x={x}
                                y={y}
                                width={barWidth}
                                height={barH}
                                rx={4}
                                fill={color}
                            />
                            {bar.total > 0 && (
                                <SvgText
                                    x={x + barWidth / 2}
                                    y={y - 3}
                                    textAnchor="middle"
                                    fontSize={8}
                                    fill="#374151"
                                >
                                    {`${bar.total.toFixed(2)}€`}
                                </SvgText>
                            )}
                        </React.Fragment>
                    );
                })}
            </Svg>
            <View style={[styles.labels, { width: totalWidth }]}>
                {data.map((bar, i) => (
                    <Text key={i} style={[styles.label, { width: barWidth + gap }]}>
                        {bar.label}
                    </Text>
                ))}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    labels: { flexDirection: 'row', marginTop: 4 },
    label: { fontSize: 10, color: '#6B7280', textAlign: 'center' },
});
