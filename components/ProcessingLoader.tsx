import { useMemo } from "react";
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useTranslation } from "react-i18next";
import { useTheme, type AppTheme } from "../constants/theme";
import { MaterialProgress } from "./MaterialProgress";

/**
 * The ONE loading presentation for the whole receipt flow (scan → process → swipe).
 * A spinner + a silly-but-REPRESENTATIVE line that reflects the action the app is taking
 * RIGHT NOW (it changes as the flow advances — it does NOT randomly rotate). An optional
 * muted `subStep` carries a precise detail (e.g. the "12 / 30 matched" counter).
 *
 * The CALLER owns positioning (full-screen overlay / absolute-fill wrapper); this renders
 * the centred spinner + text column.
 */

// Each pipeline stage → a grocery-themed line that actually describes what's happening.
export type LoadingStage =
  | "scanning"      // OCR — reading the receipt
  | "matching"      // matching OCR lines to catalog products
  | "sending"       // POST /api/receipts
  | "uploading"     // uploading the (masked) photo to storage
  | "comparing"     // fetching the cross-store price comparison
  | "loadingCards"  // building the swipe queue
  | "buildingCrop"; // re-projecting the photo + cropping a line band

const STAGE_KEY: Record<LoadingStage, string> = {
  scanning: "receiptProcess.stageScanning",
  matching: "receiptProcess.stageMatching",
  sending: "receiptProcess.stageSending",
  uploading: "receiptProcess.stageUploading",
  comparing: "receiptProcess.stageComparing",
  loadingCards: "swipe.stageLoadingCards",
  buildingCrop: "swipe.cropBuilding",
};

export function ProcessingLoader({
  stage,
  subStep,
  color,
  style,
}: {
  /** The action the app is currently doing — picks the representative silly line. */
  stage: LoadingStage;
  /** Optional precise detail under the headline (e.g. the match counter). */
  subStep?: string | null;
  color?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const colors = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={[styles.wrap, style]}>
      <MaterialProgress size="large" color={color ?? colors.primary} />
      <Text style={styles.message} numberOfLines={2}>{t(STAGE_KEY[stage])}</Text>
      {subStep ? <Text style={styles.subStep} numberOfLines={2}>{subStep}</Text> : null}
    </View>
  );
}

const makeStyles = (c: AppTheme) =>
  StyleSheet.create({
    wrap: {
      alignItems: "center",
      justifyContent: "center",
    },
    message: {
      marginTop: 18,
      fontSize: 15,
      color: c.textMuted,
      textAlign: "center",
      paddingHorizontal: 28,
    },
    subStep: {
      marginTop: 8,
      fontSize: 12,
      color: c.textMuted,
      opacity: 0.8,
      textAlign: "center",
      paddingHorizontal: 28,
    },
  });
