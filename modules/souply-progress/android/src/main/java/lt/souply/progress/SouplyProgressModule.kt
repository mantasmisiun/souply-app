package lt.souply.progress

import android.content.Context
import android.view.ContextThemeWrapper
import android.view.Gravity
import com.google.android.material.progressindicator.CircularProgressIndicator
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.views.ExpoView

/**
 * Hosts the M3 Expressive **WAVY** [CircularProgressIndicator] (Material 1.14+) —
 * the indeterminate arc with a wave-shaped track. ExpoView is a LinearLayout, so
 * `gravity = CENTER` centers it within the RN-measured bounds.
 */
class SouplyProgressView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  // CircularProgressIndicator REQUIRES a Material3 theme on its context; the Expo
  // activity theme is AppCompat-based, so wrap it to avoid an inflation crash.
  private val themedContext = ContextThemeWrapper(context, com.google.android.material.R.style.Theme_Material3_DayNight)
  private val density = resources.displayMetrics.density

  internal val indicator = CircularProgressIndicator(themedContext).also {
    it.isIndeterminate = true
  }

  // Apply the wavy look per Google's M3 Expressive spec, scaled to the diameter so it
  // stays attractive from a tiny inline spinner to a full-screen loader. The protected
  // wavy-style constructor isn't usable from here, so the @Px setters match the style's
  // values instead. Reference: M3 wavy CircularProgressIndicator at the 48dp default =
  // trackThickness 4dp, waveAmplitude 3dp, wavelength 40dp (≈3.8 gentle waves).
  private fun applyWavy(px: Int) {
    val d = density
    indicator.indicatorSize = px
    // TRACK: Google's ~1:12 ratio (4dp at 48dp), but CAPPED at 3.5dp so a full-screen
    // loader stays delicate (the user found a flat 4dp a tad thick), and FLOORED at 1.5dp
    // so a small spinner is a thin ring — the old fixed 4dp was 20% of a 20dp circle.
    val track = (px / 12f).coerceIn(1.5f * d, 3.5f * d)
    indicator.trackThickness = track.toInt()
    indicator.trackCornerRadius = (track / 2f).toInt()
    // WAVE: wavelength scales WITH the diameter (≈0.84·D ⇒ ~3.8 gentle waves at any size;
    // Google's 40dp at 48dp), instead of the old px/3 that crammed ~9 busy waves and read
    // as thick. Amplitude is Google's 3dp at ≥48dp and fades with size² below that, so the
    // wave vanishes on small spinners (Google: "at very small sizes the wavy shape may not
    // be visible") leaving a clean thin ring — no chunky wiggle on a 20dp circle.
    val k = (px / (48f * d)).coerceAtMost(1f)
    indicator.setWaveAmplitude((3f * d * k * k).toInt())
    indicator.setWavelength((px * 0.84f).coerceAtLeast(12f * d).toInt())
  }

  init {
    gravity = Gravity.CENTER
    addView(indicator)
    applyWavy((20 * density).toInt()) // default 'small' until a size prop arrives
  }

  fun setDiameter(dp: Double) = applyWavy((dp * density).toInt())
}

class SouplyProgressModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SouplyProgress")

    View(SouplyProgressView::class) {
      // RN passes a processed color int (from processColor on the JS side).
      Prop("color") { view: SouplyProgressView, color: Int? ->
        if (color != null) view.indicator.setIndicatorColor(color)
      }
      // Diameter in dp.
      Prop("size") { view: SouplyProgressView, size: Double? ->
        if (size != null && size > 0) view.setDiameter(size)
      }
    }
  }
}
