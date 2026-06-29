import Svg, { Path } from "react-native-svg";

/**
 * Swipe-vote icons (line-art, stroked to match Ionicons-outline). The three convey a
 * semantic gradient of "how alike are these two products?":
 *   identical → two arrows JOIN into one (2→1, merge)
 *   similar   → two PARALLEL up-arrows, close but separate
 *   different → one line SPLITS into two diverging arrows (1→2)
 * `different` is the visual inverse of `identical`. Skip keeps its Ionicons glyph.
 */
export type VoteIconProps = { size?: number; color?: string };

const STROKE = 2;

/** IDENTICAL — two arrows joining together into one upward arrow (merge). */
export function MergeArrowsIcon({ size = 30, color = "#000" }: VoteIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M5 20.5 L12 12 M19 20.5 L12 12 M12 12 L12 4 M8.5 7.5 L12 4 L15.5 7.5"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** SIMILAR — two parallel arrows pointing up, close but not joined. */
export function ParallelArrowsIcon({ size = 30, color = "#000" }: VoteIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M9 20.5 L9 5 M6.5 8 L9 5 L11.5 8 M15 20.5 L15 5 M12.5 8 L15 5 L17.5 8"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** DIFFERENT — one line splitting into two diverging up-arrows. */
export function DivergeArrowsIcon({ size = 30, color = "#000" }: VoteIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 20.5 L12 13 M12 13 L6.5 5.5 M12 13 L17.5 5.5 M6.8 8.5 L6.5 5.5 L9.3 6.7 M14.7 6.7 L17.5 5.5 L17.2 8.5"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
