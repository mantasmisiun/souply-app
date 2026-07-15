import { memo } from "react";
import { Text, View, StyleSheet } from "react-native";
import type { AppTheme } from "../constants/theme";
import { withAlpha } from "../constants/theme";
import type { ItemConfidence } from "@shared/recognitionConfig";

/**
 * Small per-item confidence chip for the receipt Items tab.
 *
 * Two modes off the same {@link ItemConfidence} breakdown:
 *  - `variant="dev"` — a `__DEV__`-only debug pill ("S2 · 0.74 · veto:…") so we
 *    can read the band + score + top veto on-device while the band scoring is
 *    still being calibrated. Always shown in dev builds when a score exists.
 *  - `variant="review"` — the user-facing "patikrinti" (verify) chip shown on
 *    S2 lines once {@link CONFIDENCE_BAND_DISPLAY} is on: the OCR name is trusted
 *    but the matched SP wants a human glance.
 *
 * Display-only — it never changes which SP is linked. Colour per band:
 * S1 success · S2 warning · S3 textSecondary.
 */
const BAND_COLOR = (colors: AppTheme, band: ItemConfidence["band"]): string =>
  band === "S1" ? colors.success : band === "S2" ? colors.warning : colors.textSecondary;

function ConfidenceBadgeImpl({
  ic,
  colors,
  variant = "dev",
}: {
  ic: ItemConfidence;
  colors: AppTheme;
  variant?: "dev" | "review";
}) {
  const tint = BAND_COLOR(colors, ic.band);

  if (variant === "review") {
    return (
      <View style={[styles.pill, { backgroundColor: withAlpha(tint, 0.14), borderColor: withAlpha(tint, 0.5) }]}>
        <Text style={[styles.reviewText, { color: tint }]}>Patikrinti</Text>
      </View>
    );
  }

  // dev: band · score (· top veto / override) — terse, monospace-ish.
  const veto = ic.vetoes?.[0]?.reason;
  const tag = ic.override ? "ocr-only" : veto ? `v:${veto}` : null;
  return (
    <View style={[styles.devPill, { borderColor: withAlpha(tint, 0.6) }]}>
      <Text style={[styles.devText, { color: tint }]}>
        {ic.band} · {ic.score.toFixed(2)}
        {tag ? ` · ${tag}` : ""}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 3,
  },
  reviewText: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  devPill: {
    alignSelf: "flex-start",
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 5,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 3,
  },
  devText: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.2,
  },
});

export default memo(ConfidenceBadgeImpl);
