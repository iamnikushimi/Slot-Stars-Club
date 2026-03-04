package com.slotstarsclub.app

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import android.webkit.JavascriptInterface

/**
 * Provides haptic feedback for game events.
 * Exposed to JavaScript via @JavascriptInterface so the web games
 * can trigger native vibrations for spins, wins, jackpots, etc.
 *
 * Usage from JavaScript:
 *   if (window.SSCHaptic) {
 *       SSCHaptic.spin();      // light tick for spin start
 *       SSCHaptic.win();       // medium buzz for regular win
 *       SSCHaptic.bigWin();    // strong double-pulse for big win
 *       SSCHaptic.jackpot();   // dramatic escalating pattern
 *       SSCHaptic.click();     // subtle tap for button presses
 *       SSCHaptic.error();     // short sharp buzz for errors
 *   }
 */
class HapticManager(private val context: Context) {

    companion object {
        private const val TAG = "SSC-Haptic"
    }

    private val vibrator: Vibrator? by lazy {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vm = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
                vm?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            }
        } catch (e: Exception) {
            Log.e(TAG, "Vibrator init failed", e)
            null
        }
    }

    private fun vibrate(millis: Long, amplitude: Int = VibrationEffect.DEFAULT_AMPLITUDE) {
        try {
            val v = vibrator ?: return
            if (!v.hasVibrator()) return

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v.vibrate(VibrationEffect.createOneShot(millis, amplitude))
            } else {
                @Suppress("DEPRECATION")
                v.vibrate(millis)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Vibrate failed", e)
        }
    }

    private fun vibratePattern(pattern: LongArray, amplitudes: IntArray? = null) {
        try {
            val v = vibrator ?: return
            if (!v.hasVibrator()) return

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && amplitudes != null) {
                v.vibrate(VibrationEffect.createWaveform(pattern, amplitudes, -1))
            } else {
                @Suppress("DEPRECATION")
                v.vibrate(pattern, -1)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Vibrate pattern failed", e)
        }
    }

    // ── JavaScript Interface Methods ─────────────────────────────────────────

    /** Light tick when spin button is pressed */
    @JavascriptInterface
    fun spin() {
        vibrate(25, 80)
    }

    /** Subtle tap for UI button clicks */
    @JavascriptInterface
    fun click() {
        vibrate(15, 50)
    }

    /** Medium buzz for a regular win */
    @JavascriptInterface
    fun win() {
        vibratePattern(
            longArrayOf(0, 60, 80, 60),
            intArrayOf(0, 120, 0, 180)
        )
    }

    /** Strong double-pulse for big wins */
    @JavascriptInterface
    fun bigWin() {
        vibratePattern(
            longArrayOf(0, 80, 60, 80, 60, 120),
            intArrayOf(0, 150, 0, 200, 0, 255)
        )
    }

    /** Dramatic escalating pattern for jackpots */
    @JavascriptInterface
    fun jackpot() {
        vibratePattern(
            longArrayOf(0, 50, 50, 70, 50, 90, 50, 120, 50, 200),
            intArrayOf(0, 80, 0, 120, 0, 160, 0, 200, 0, 255)
        )
    }

    /** Short sharp buzz for errors or insufficient funds */
    @JavascriptInterface
    fun error() {
        vibratePattern(
            longArrayOf(0, 40, 60, 40),
            intArrayOf(0, 200, 0, 200)
        )
    }

    /** Reel stop tick — called when each reel lands */
    @JavascriptInterface
    fun reelStop() {
        vibrate(20, 100)
    }

    /** Bonus trigger — exciting build-up */
    @JavascriptInterface
    fun bonus() {
        vibratePattern(
            longArrayOf(0, 30, 30, 30, 30, 30, 30, 60, 40, 100),
            intArrayOf(0, 60, 0, 90, 0, 120, 0, 180, 0, 255)
        )
    }

    /** Credit add — satisfying confirmation */
    @JavascriptInterface
    fun creditAdd() {
        vibrate(30, 100)
    }
}
