import DocumentScanner, {
    ResponseType,
    ScanDocumentResponseStatus,
} from 'react-native-document-scanner-plugin';

/**
 * Launch the OS document scanner — ML Kit Document Scanner on Android,
 * VisionKit on iOS. Both are free, on-device and give the premium guided
 * capture UX (live edge detection, auto-capture, perspective de-skew,
 * multi-page) with no CV code of ours to maintain.
 *
 * The corrected page image(s) are handed to /receipt-process exactly like the
 * PDF multi-page flow — plain comma-separated `uris` — so the existing OCR →
 * parse → mask-burn-in → upload pipeline is unchanged and masking/privacy are
 * preserved. This is the ONLY scan entry point (the guided multi-segment "long
 * receipt" scanner was removed).
 */

export interface ScanRouteParams {
    /** true → results screen is preview-only (no upload). */
    preview?: boolean;
    shoppingListId?: string;
    expectedChainId?: string;
    /** chainId→listId map (post-completion shopping-list receipt flow). */
    listMap?: string;
    /** true → replace the current route instead of pushing (used by the
     *  "retake" flow from receipt-process, so the failed attempt is swapped
     *  out rather than stacked). */
    replace?: boolean;
}

// Minimal structural type so we don't depend on expo-router's exported Router
// type (which churns between versions). `href` is `any` because typedRoutes
// narrows the real signature to a static union that our runtime query string
// can't satisfy — the same reason the call sites use `as any`.
interface PushRouter {
    push: (href: any) => void;
    replace: (href: any) => void;
}

/** File paths from the scanner may come back without a scheme; OCR/ImageManipulator
 *  need a `file://` URI. */
function toFileUri(path: string): string {
    return /^[a-z]+:\/\//i.test(path) ? path : `file://${path}`;
}

/**
 * Open the native scanner and return the captured page URIs — WITHOUT any
 * navigation. Callers that want the receipt processed silently in the
 * background enqueue these into the receipt queue instead of routing to the
 * full-screen /receipt-process flow. Returns null on cancel/failure.
 */
export async function scanDocumentOnly(): Promise<string[] | null> {
    // iOS: presenting VisionKit while a JS Modal is still dismissing wedges the
    // view hierarchy — give the modal a beat to fully dismiss first.
    await new Promise((resolve) => setTimeout(resolve, 300));

    let scannedImages: string[] | undefined;
    let status: ScanDocumentResponseStatus | undefined;
    try {
        const res = await DocumentScanner.scanDocument({
            maxNumDocuments: 5,
            croppedImageQuality: 100,
            responseType: ResponseType.ImageFilePath,
        });
        scannedImages = res.scannedImages;
        status = res.status;
    } catch (e) {
        console.warn('[docScanner] launch failed', e);
        return null;
    }

    if (status === ScanDocumentResponseStatus.Cancel) return null;
    if (!scannedImages || scannedImages.length === 0) return null;
    return scannedImages.map(toFileUri);
}

/**
 * Open the scanner; on success route to /receipt-process with the captured
 * page(s). Returns the captured URIs (or null on cancel/failure) in case the
 * caller wants to react.
 */
export async function launchDocumentScanner(
    router: PushRouter,
    params: ScanRouteParams = {},
): Promise<string[] | null> {
    const uris = await scanDocumentOnly();
    if (!uris) return null;

    const qp = new URLSearchParams();
    if (uris.length === 1) {
        qp.set('uri', uris[0]);
    } else {
        qp.set('uris', uris.join(','));
    }
    if (params.preview) qp.set('preview', 'true');
    if (params.shoppingListId) qp.set('shoppingListId', params.shoppingListId);
    if (params.expectedChainId) qp.set('expectedChainId', params.expectedChainId);
    if (params.listMap) qp.set('listMap', params.listMap);

    const href = `/receipt-process?${qp.toString()}`;
    if (params.replace) router.replace(href);
    else router.push(href);
    return uris;
}
