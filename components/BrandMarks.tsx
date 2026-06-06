import Svg, { Path } from 'react-native-svg';

/**
 * Brand marks for the OAuth buttons — the SAME official trademarks the website
 * uses (souply-web/src/components/BrandMarks.tsx), ported to react-native-svg.
 * Apple takes a `color` (so it can flip with the theme like Apple's HIG button);
 * Google is always the fixed four-colour "G".
 */

export function AppleMark({ size = 16, color = '#000' }: { size?: number; color?: string }) {
    return (
        <Svg viewBox="0 0 24 24" width={size} height={size}>
            <Path
                fill={color}
                d="M16.365 1.43c0 1.14-.466 2.236-1.272 3.063-.844.86-1.957 1.5-3.05 1.418-.13-1.094.42-2.224 1.214-3.05.86-.892 2.087-1.476 3.108-1.43zM20.5 17.74c-.55 1.25-.815 1.81-1.526 2.92-.99 1.546-2.387 3.475-4.117 3.49-1.538.014-1.933-1.001-4.02-.99-2.086.01-2.52 1.005-4.06.99-1.73-.015-3.052-1.755-4.04-3.3C-.42 16.92-.71 11.79.95 9.072c1.18-1.92 3.045-3.046 4.798-3.046 1.79 0 2.913.984 4.397.984 1.44 0 2.318-.986 4.387-.986 1.563 0 3.22.853 4.398 2.326-3.866 2.122-3.236 7.654.57 9.39z"
            />
        </Svg>
    );
}

export function GoogleMark({ size = 16 }: { size?: number }) {
    return (
        <Svg viewBox="0 0 48 48" width={size} height={size}>
            <Path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
            <Path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
            <Path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19A23.953 23.953 0 0 0 0 24c0 3.88.93 7.54 2.56 10.78l7.97-6.19z" />
            <Path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
        </Svg>
    );
}
