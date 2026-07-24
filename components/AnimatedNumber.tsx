import { useEffect, useRef, useState } from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';

/**
 * A number that TWEENS to its new value whenever `value` changes — so when the
 * stats refresh with knowledge gained from swiping, figures visibly count up/down
 * instead of snapping. First mount snaps (no intro animation); subsequent changes
 * ease from the previously-shown value. `format` renders the live tweened number
 * (e.g. formatEuro); pass the SAME style you'd give a <Text>.
 *
 * Deliberately JS-driven (rAF) rather than a reanimated animated-text: only a
 * handful of stat figures use it, and this keeps the value a plain string the
 * caller formats (currency, "/100", plain count) with zero worklet plumbing.
 */
export function AnimatedNumber({
    value,
    format,
    style,
    durationMs = 650,
    allowFontScaling,
    numberOfLines,
}: {
    value: number;
    format: (n: number) => string;
    style?: StyleProp<TextStyle>;
    durationMs?: number;
    allowFontScaling?: boolean;
    numberOfLines?: number;
}) {
    const [shown, setShown] = useState(value);
    const fromRef = useRef(value);
    const rafRef = useRef<number | null>(null);
    const firstRef = useRef(true);

    useEffect(() => {
        // First render: snap, remember, done.
        if (firstRef.current) {
            firstRef.current = false;
            fromRef.current = value;
            setShown(value);
            return;
        }
        const from = fromRef.current;
        const to = value;
        if (from === to) return;
        if (rafRef.current != null) cancelAnimationFrame(rafRef.current);

        const start = Date.now();
        const tick = () => {
            const t = Math.min(1, (Date.now() - start) / durationMs);
            // easeOutCubic — fast then settle.
            const e = 1 - Math.pow(1 - t, 3);
            setShown(from + (to - from) * e);
            if (t < 1) {
                rafRef.current = requestAnimationFrame(tick);
            } else {
                fromRef.current = to;
                setShown(to);
                rafRef.current = null;
            }
        };
        rafRef.current = requestAnimationFrame(tick);
        return () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); };
    }, [value, durationMs]);

    return (
        <Text style={style} allowFontScaling={allowFontScaling} numberOfLines={numberOfLines}>
            {format(shown)}
        </Text>
    );
}
