const { AndroidConfig } = require('@expo/config-plugins');

/**
 * Strip Android permissions that bundled native modules declare but the app
 * never actually uses, so they don't surface on the Play listing / the
 * device permission screen (and don't invite extra store review):
 *
 *   - RECORD_AUDIO        — expo-camera's video-capture capability; we only
 *                           scan barcodes / take receipt photos, never audio.
 *   - READ_MEDIA_AUDIO    — media libs pull this in; we never read audio.
 *   - READ_MEDIA_IMAGES   — added by expo-media-library, but we only SAVE (the
 *                           shared-template QR) and pick via the Android Photo
 *                           Picker, so we never read the gallery. Declaring it
 *                           triggers Play's Photo & Video Permissions policy.
 *   - READ_MEDIA_VIDEO    — same source; the app has no video feature at all
 *                           (every picker is mediaTypes:['images']).
 *   - SYSTEM_ALERT_WINDOW — "draw over other apps"; we have no overlay feature.
 *
 * Uses Expo's withBlockedPermissions, which both removes them from the static
 * permission list and adds `tools:node="remove"` entries the Android manifest
 * merger honours (so dependency-declared copies are stripped too).
 */
module.exports = (config) =>
    AndroidConfig.Permissions.withBlockedPermissions(config, [
        'android.permission.RECORD_AUDIO',
        'android.permission.READ_MEDIA_AUDIO',
        'android.permission.READ_MEDIA_IMAGES',
        'android.permission.READ_MEDIA_VIDEO',
        'android.permission.SYSTEM_ALERT_WINDOW',
    ]);
