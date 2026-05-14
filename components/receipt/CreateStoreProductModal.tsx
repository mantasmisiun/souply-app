import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useMemo, useState } from "react";
import {
    ActivityIndicator,
    Alert,
    Image,
    KeyboardAvoidingView,
    Modal,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from "react-native";
import { useTranslation } from "react-i18next";
import { API_BASE_URL } from "../../config/api";
import { getUserId } from "../../config/user";
import { useReceiptCreateContext } from "../../state/basketState";
import { parseProductName } from "@shared/parsers/productNameParser";
import { useTheme, type AppTheme } from "../../constants/theme";

interface L3CategoryOption {
  id: number;
  name: string;
  path: string;
}

export interface CreatedStoreProductPayload {
  productId: number;
  storeProductId: number;
  storeProductName: string;
  imageUrl: string | null;
  amount: number | null;
  unit: string | null;
}

interface CreateStoreProductModalProps {
  visible: boolean;
  onClose: () => void;
  chainId: number;
  initialName: string;
  initialCategoryId: number | null;
  onCreated: (payload: CreatedStoreProductPayload) => Promise<void> | void;
}

export default function CreateStoreProductModal({
  visible,
  onClose,
  chainId,
  initialName,
  initialCategoryId,
  onCreated,
}: CreateStoreProductModalProps) {
  const colors = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [draftName, setDraftName] = useState("");
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(
    null,
  );
  const [categoryInput, setCategoryInput] = useState("");
  const [selectedCategoryPath, setSelectedCategoryPath] = useState("");
  const [categoryOptions, setCategoryOptions] = useState<L3CategoryOption[]>(
    [],
  );
  const [searchingCategories, setSearchingCategories] = useState(false);
  const [createImageUri, setCreateImageUri] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const createContext = useReceiptCreateContext((s) => s.context);

  useEffect(() => {
    if (!visible) return;

    setDraftName(initialName.trim());
    setCreateImageUri(null);
    setCategoryOptions([]);
    setSearchingCategories(false);
    setSubmitting(false);

    if (Number.isFinite(initialCategoryId) && Number(initialCategoryId) > 0) {
      const id = Number(initialCategoryId);
      setSelectedCategoryId(id);
      (async () => {
        try {
          const res = await fetch(`${API_BASE_URL}/api/categories/${id}/path`);
          const data = await res.json();
          const path = typeof data?.path === "string" ? data.path : "";
          setSelectedCategoryPath(path);
          setCategoryInput(path);
        } catch {
          setSelectedCategoryPath("");
          setCategoryInput("");
        }
      })();
      return;
    }

    setSelectedCategoryId(null);
    setSelectedCategoryPath("");
    setCategoryInput("");
  }, [visible, initialName, initialCategoryId]);

  useEffect(() => {
    if (!visible) return;
    const q = categoryInput.trim();

    if (q.length < 2 || (selectedCategoryPath && q === selectedCategoryPath)) {
      setCategoryOptions([]);
      setSearchingCategories(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        setSearchingCategories(true);
        const res = await fetch(
          `${API_BASE_URL}/api/categories/l3/search?q=${encodeURIComponent(q)}`,
        );
        const data = await res.json();
        if (!cancelled) {
          setCategoryOptions(Array.isArray(data) ? data : []);
        }
      } catch {
        if (!cancelled) {
          setCategoryOptions([]);
        }
      } finally {
        if (!cancelled) setSearchingCategories(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [categoryInput, selectedCategoryPath, visible]);

  const pickCreateImage = () => {
    Alert.alert(t('createProduct.pickerTitle'), t('createProduct.pickerBody'), [
      {
        text: t('createProduct.pickerCamera'),
        onPress: async () => {
          const r = await ImagePicker.launchCameraAsync({
            mediaTypes: ["images"],
            quality: 0.8,
          });
          if (!r.canceled && r.assets[0]) setCreateImageUri(r.assets[0].uri);
        },
      },
      {
        text: t('createProduct.pickerGallery'),
        onPress: async () => {
          const r = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ["images"],
            quality: 0.8,
          });
          if (!r.canceled && r.assets[0]) setCreateImageUri(r.assets[0].uri);
        },
      },
      { text: t('common.cancel'), style: "cancel" },
    ]);
  };

  const compressForProductImage = async (uri: string) => {
    let out = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 900 } }],
      { compress: 0.35, format: ImageManipulator.SaveFormat.JPEG },
    );

    const size = (await (await fetch(out.uri)).blob()).size;
    if (size > 350_000) {
      out = await ImageManipulator.manipulateAsync(
        out.uri,
        [{ resize: { width: 640 } }],
        { compress: 0.25, format: ImageManipulator.SaveFormat.JPEG },
      );
    }
    return out.uri;
  };

  const uploadCreateImage = async (uri: string) => {
    const compressedUri = await compressForProductImage(uri);

    const urlRes = await fetch(
      `${API_BASE_URL}/api/store-products/upload-url`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: `product-${Date.now()}.jpg`,
          mimeType: "image/jpeg",
        }),
      },
    );
    const urlData = await urlRes.json();
    if (!urlRes.ok || !urlData?.uploadUrl || !urlData?.filePath) {
      throw new Error(urlData?.error || t('createProduct.errors.uploadUrl'));
    }

    const blob = await (await fetch(compressedUri)).blob();
    const putRes = await fetch(urlData.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: blob,
    });
    if (!putRes.ok) {
      throw new Error(t('createProduct.errors.uploadImage'));
    }

    return urlData.filePath as string;
  };

  const submit = async () => {
    const trimmedName = draftName.trim();
    if (!trimmedName) {
      Alert.alert(t('createProduct.errors.missingName'), t('createProduct.errors.missingNameBody'));
      return;
    }
    if (!Number.isFinite(chainId) || chainId <= 0) {
      Alert.alert(t('createProduct.errors.missingChain'), t('createProduct.errors.missingChainBody'));
      return;
    }
    if (
      !Number.isFinite(selectedCategoryId) ||
      Number(selectedCategoryId) <= 0
    ) {
      Alert.alert(t('createProduct.errors.missingCategory'), t('createProduct.errors.missingCategoryBody'));
      return;
    }

    try {
      setSubmitting(true);

      const uploadedImageUrl = createImageUri
        ? await uploadCreateImage(createImageUri)
        : null;

      // Strip weight / unit tail from the OCR-sourced name. Keep the fully
      // stripped version for both Product.name and StoreProduct.storeProductName;
      // amount + unit only set when "g" is present in the stripped tail (per spec).
      const isWeighable = createContext?.ocrIsWeighable ?? false;
      const parsed = parseProductName(trimmedName, isWeighable);
      const finalName = parsed.strippedName || trimmedName;

      const pRes = await fetch(`${API_BASE_URL}/api/products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryId: Number(selectedCategoryId),
          name: finalName,
        }),
      });
      const pData = await pRes.json();
      if (!pRes.ok || !pData?.id) {
        throw new Error(pData?.error || t('createProduct.errors.createProduct'));
      }

      // Send userId so the server can decide whether a user-supplied
      // imageUrl publishes directly (admin) or lands in the admin
      // pending queue (regular user).
      const userId = await getUserId();
      const spRes = await fetch(`${API_BASE_URL}/api/store-products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: pData.id,
          chainId: Number(chainId),
          storeProductName: finalName,
          brandName: null,
          isWeighable,
          amount: parsed.amount,
          unit: parsed.unit,
          imageUrl: uploadedImageUrl,
          userId,
        }),
      });
      const spData = await spRes.json();
      if (!spRes.ok || !spData?.id) {
        throw new Error(
          spData?.error || t('createProduct.errors.createStoreProduct'),
        );
      }

      // Create the user-verified-false Price row linked to the receipt,
      // and let the server propagate fallbacks to other stores in the chain.
      if (
        createContext &&
        Number.isFinite(createContext.receiptId) &&
        Number.isFinite(createContext.storeId) &&
        createContext.ocrPrice > 0
      ) {
        const priceDate = createContext.receiptDate
          ? new Date(createContext.receiptDate.replace(" ", "T"))
          : new Date();
        try {
          const priceRes = await fetch(`${API_BASE_URL}/api/prices`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              storeProductId: spData.id,
              storeId: createContext.storeId,
              price: createContext.ocrPrice,
              promoPrice: createContext.ocrPromoPrice,
              promoEnd: null,
              isFallback: false,
              date: priceDate.toISOString(),
              priceVerified: false,
              receiptId: createContext.receiptId,
            }),
          });
          const priceData = await priceRes.json().catch(() => ({}));
          if (!priceRes.ok) {
            throw new Error(priceData?.error || `HTTP ${priceRes.status}`);
          }
        } catch (e: any) {
          console.warn("Price creation failed:", e);
          Alert.alert(
            t('createProduct.errors.priceWarningTitle'),
            t('createProduct.errors.priceWarningBody', {
              detail: e?.message ?? t('createProduct.errors.unknown'),
            }),
          );
        }
      }

      // When the server quarantined the image, drop it from the
      // local notification so the create-page UI doesn't show the
      // user's not-yet-public photo as if it were live.
      const effectiveImageUrl = spData?.imageQueued ? null : (spData?.imageUrl ?? uploadedImageUrl);
      await onCreated({
        productId: pData.id,
        storeProductId: spData.id,
        storeProductName: finalName,
        imageUrl: effectiveImageUrl,
        amount: parsed.amount,
        unit: parsed.unit,
      });
      if (spData?.imageQueued) {
        Alert.alert(t('imageUpload.sentForReviewTitle'), t('imageUpload.sentForReviewBody'));
      }
      onClose();
    } catch (e: any) {
      Alert.alert(t('createProduct.errors.generic'), e?.message || t('createProduct.errors.createProduct'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.card}>
          <Text style={styles.title}>{t('createProduct.title')}</Text>

          <Text style={styles.label}>{t('createProduct.name')}</Text>
          <TextInput
            value={draftName}
            onChangeText={setDraftName}
            style={styles.input}
            placeholder={t('createProduct.namePlaceholder')}
            placeholderTextColor={colors.textMuted}
          />

          <Text style={styles.label}>{t('createProduct.categoryL3')}</Text>
          <TextInput
            value={categoryInput}
            onChangeText={(v) => {
              setCategoryInput(v);
              setSelectedCategoryId(null);
              setSelectedCategoryPath("");
            }}
            style={styles.input}
            placeholder={t('createProduct.categorySearchPlaceholder')}
            placeholderTextColor={colors.textMuted}
          />

          {searchingCategories && (
            <ActivityIndicator
              size="small"
              color={colors.primary}
              style={{ marginTop: 6 }}
            />
          )}

          {categoryOptions.length > 0 && (
            <ScrollView style={styles.dropdown}>
              {categoryOptions.map((opt) => (
                <TouchableOpacity
                  key={opt.id}
                  style={styles.dropdownItem}
                  onPress={() => {
                    setSelectedCategoryId(opt.id);
                    setSelectedCategoryPath(opt.path);
                    setCategoryInput(opt.path);
                    setCategoryOptions([]);
                  }}
                >
                  <Text style={styles.dropdownText}>{opt.path}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}

          <Text style={styles.categoryHint}>
            {selectedCategoryId
              ? t('createProduct.categorySelected')
              : t('createProduct.categoryHint')}
          </Text>

          <TouchableOpacity
            onPress={pickCreateImage}
            style={styles.imageButton}
            activeOpacity={0.8}
          >
            <Text style={styles.imageButtonText}>
              {createImageUri
                ? t('createProduct.imageReplace')
                : t('createProduct.imageAdd')}
            </Text>
          </TouchableOpacity>

          {createImageUri && (
            <Image
              source={{ uri: createImageUri }}
              style={styles.previewImage}
            />
          )}

          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.actionBtn, styles.cancelBtn]}
              onPress={onClose}
              disabled={submitting}
            >
              <Text style={styles.cancelText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, styles.confirmBtn]}
              onPress={submit}
              disabled={submitting}
            >
              <Text style={styles.confirmText}>
                {submitting ? t('createProduct.creating') : t('createProduct.add')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const makeStyles = (c: AppTheme) => StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: c.overlayBackdrop,
    justifyContent: "center",
    padding: 20,
  },
  card: {
    backgroundColor: c.cardBackground,
    borderRadius: 12,
    padding: 16,
  },
  title: {
    fontSize: 16,
    fontWeight: "700",
    color: c.textPrimary,
    marginBottom: 10,
  },
  label: {
    fontSize: 13,
    color: c.textPrimary,
    marginBottom: 6,
    marginTop: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 14,
    color: c.textPrimary,
    backgroundColor: c.cardBackground,
  },
  dropdown: {
    marginTop: 6,
    maxHeight: 140,
    borderWidth: 1,
    borderColor: c.borderSubtle,
    borderRadius: 8,
    backgroundColor: c.cardBackground,
  },
  dropdownItem: {
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: c.borderSubtle,
  },
  dropdownText: {
    fontSize: 13,
    color: c.textPrimary,
  },
  categoryHint: {
    marginTop: 6,
    fontSize: 12,
    color: c.textSecondary,
  },
  imageButton: {
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.border,
    alignSelf: "flex-start",
  },
  imageButtonText: {
    fontSize: 12,
    color: c.textSecondary,
    fontWeight: "600",
  },
  previewImage: {
    marginTop: 10,
    width: 110,
    height: 110,
    borderRadius: 10,
    backgroundColor: c.surfaceSubtle,
    alignSelf: "flex-start",
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 14,
  },
  actionBtn: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 8,
  },
  cancelBtn: {
    backgroundColor: c.surfaceMuted,
  },
  confirmBtn: {
    backgroundColor: c.primary,
  },
  cancelText: {
    color: c.textPrimary,
    fontWeight: "600",
    fontSize: 13,
  },
  confirmText: {
    color: c.onPrimary,
    fontWeight: "700",
    fontSize: 13,
  },
});
