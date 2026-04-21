import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { Image, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useTheme, type AppTheme } from "../../constants/theme";

export default function CaptureReceiptScreen() {
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [permission, requestPermission] = useCameraPermissions();
  const [photo, setPhoto] = useState<string | null>(null);
  const cameraRef = useRef<CameraView>(null);
  const router = useRouter();

  if (!permission) {
    return <View style={styles.container} />;
  }

  if (!permission.granted) {
    return (
      <View style={styles.permissionContainer}>
        <Ionicons name="camera-outline" size={64} color={colors.textMuted} />
        <Text style={styles.permissionText}>Reikia prieigos prie kameros</Text>
        <TouchableOpacity
          style={styles.permissionButton}
          onPress={requestPermission}
        >
          <Text style={styles.permissionButtonText}>Leisti</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const takePicture = async () => {
    if (!cameraRef.current) return;
    const result = await cameraRef.current.takePictureAsync({
      quality: 0.8,
      base64: false,
    });
    if (result?.uri) {
      setPhoto(result.uri);
    }
  };

  const confirmPhoto = async () => {
    if (!photo) return;
    // Navigate to processing screen with the photo URI
    router.push(`/receipt-process?uri=${encodeURIComponent(photo)}` as any);
  };

  const retakePhoto = () => {
    setPhoto(null);
  };

  // Preview mode
  if (photo) {
    return (
      <View style={styles.container}>
        <Image
          source={{ uri: photo }}
          style={styles.preview}
          resizeMode="contain"
        />
        <View style={styles.previewActions}>
          <TouchableOpacity style={styles.retakeButton} onPress={retakePhoto}>
            <Ionicons name="refresh" size={24} color={colors.onPrimary} />
            <Text style={styles.retakeText}>Iš naujo</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.confirmButton} onPress={confirmPhoto}>
            <Ionicons name="checkmark" size={24} color={colors.onPrimary} />
            <Text style={styles.confirmText}>Tęsti</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Camera mode
  return (
    <View style={styles.container}>
      <CameraView ref={cameraRef} style={styles.camera} facing="back">
        <View style={styles.overlay}>
          <View style={styles.receiptGuide}>
            <View style={styles.cornerTL} />
            <View style={styles.cornerTR} />
            <View style={styles.cornerBL} />
            <View style={styles.cornerBR} />
          </View>
        </View>
      </CameraView>
      <View style={styles.controls}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
        >
          <Ionicons name="arrow-back" size={24} color={colors.onPrimary} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.captureButton} onPress={takePicture}>
          <View style={styles.captureInner} />
        </TouchableOpacity>
        <View style={{ width: 48 }} />
      </View>
    </View>
  );
}

const makeStyles = (c: AppTheme) => {
  const cornerStyle = {
    position: "absolute" as const,
    width: 24,
    height: 24,
    borderColor: c.primary,
  };

  return StyleSheet.create({
    container: { flex: 1, backgroundColor: "black" },
    camera: { flex: 1 },
    overlay: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
    },
    receiptGuide: {
      width: "75%",
      height: "80%",
      position: "relative",
    },
    cornerTL: {
      ...cornerStyle,
      top: 0,
      left: 0,
      borderTopWidth: 3,
      borderLeftWidth: 3,
    },
    cornerTR: {
      ...cornerStyle,
      top: 0,
      right: 0,
      borderTopWidth: 3,
      borderRightWidth: 3,
    },
    cornerBL: {
      ...cornerStyle,
      bottom: 0,
      left: 0,
      borderBottomWidth: 3,
      borderLeftWidth: 3,
    },
    cornerBR: {
      ...cornerStyle,
      bottom: 0,
      right: 0,
      borderBottomWidth: 3,
      borderRightWidth: 3,
    },
    controls: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 24,
      paddingBottom: 40,
      paddingTop: 16,
      backgroundColor: "black",
    },
    backButton: {
      width: 48,
      height: 48,
      alignItems: "center",
      justifyContent: "center",
    },
    captureButton: {
      width: 72,
      height: 72,
      borderRadius: 36,
      borderWidth: 4,
      borderColor: c.onPrimary,
      alignItems: "center",
      justifyContent: "center",
    },
    captureInner: {
      width: 58,
      height: 58,
      borderRadius: 29,
      backgroundColor: c.onPrimary,
    },
    preview: {
      flex: 1,
    },
    previewActions: {
      flexDirection: "row",
      justifyContent: "space-around",
      paddingVertical: 24,
      paddingBottom: 40,
      backgroundColor: "black",
    },
    retakeButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 24,
      paddingVertical: 14,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.textSecondary,
    },
    retakeText: { color: c.onPrimary, fontSize: 15, fontWeight: "600" },
    confirmButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 24,
      paddingVertical: 14,
      borderRadius: 12,
      backgroundColor: c.primary,
    },
    confirmText: { color: c.onPrimary, fontSize: 15, fontWeight: "600" },
    permissionContainer: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 16,
      backgroundColor: c.pageBackground,
    },
    permissionText: { fontSize: 16, color: c.textSecondary },
    permissionButton: {
      backgroundColor: c.primary,
      paddingHorizontal: 24,
      paddingVertical: 12,
      borderRadius: 10,
    },
    permissionButtonText: { color: c.onPrimary, fontSize: 15, fontWeight: "600" },
  });
};
