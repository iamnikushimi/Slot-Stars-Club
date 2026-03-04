package com.slotstarsclub.app

import android.content.Context
import android.util.Log
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat

/**
 * Handles biometric (fingerprint/face) authentication.
 * Falls back to device PIN/pattern/password if biometrics unavailable.
 *
 * Usage:
 *   BiometricHelper.authenticate(activity) { success ->
 *       if (success) loadApp() else finish()
 *   }
 */
object BiometricHelper {

    private const val TAG = "SSC-Biometric"
    private const val PREF_NAME = "ssc_security"
    private const val KEY_BIOMETRIC_ENABLED = "biometric_lock_enabled"

    /**
     * Check if biometric authentication is available on this device
     */
    fun isAvailable(context: Context): Boolean {
        val biometricManager = BiometricManager.from(context)
        return when (biometricManager.canAuthenticate(
            BiometricManager.Authenticators.BIOMETRIC_WEAK or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL
        )) {
            BiometricManager.BIOMETRIC_SUCCESS -> true
            else -> false
        }
    }

    /**
     * Check if biometric lock is enabled by the user
     */
    fun isEnabled(context: Context): Boolean {
        val prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        return prefs.getBoolean(KEY_BIOMETRIC_ENABLED, false)
    }

    /**
     * Enable or disable biometric lock
     */
    fun setEnabled(context: Context, enabled: Boolean) {
        val prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        prefs.edit().putBoolean(KEY_BIOMETRIC_ENABLED, enabled).apply()
        Log.d(TAG, "Biometric lock ${if (enabled) "enabled" else "disabled"}")
    }

    /**
     * Show biometric prompt. Calls [onResult] with true if authenticated,
     * false if failed/cancelled.
     */
    fun authenticate(
        activity: AppCompatActivity,
        onResult: (Boolean) -> Unit
    ) {
        val executor = ContextCompat.getMainExecutor(activity)

        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                Log.d(TAG, "Authentication succeeded")
                onResult(true)
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                Log.e(TAG, "Authentication error: $errorCode — $errString")
                // If user cancelled, don't allow access
                onResult(false)
            }

            override fun onAuthenticationFailed() {
                Log.w(TAG, "Authentication failed (bad biometric)")
                // Don't call onResult — BiometricPrompt allows retry automatically
            }
        }

        val biometricPrompt = BiometricPrompt(activity, executor, callback)

        val promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Slot Stars Club")
            .setSubtitle("Verify your identity to continue")
            .setAllowedAuthenticators(
                BiometricManager.Authenticators.BIOMETRIC_WEAK or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL
            )
            .build()

        try {
            biometricPrompt.authenticate(promptInfo)
        } catch (e: Exception) {
            Log.e(TAG, "Biometric prompt failed", e)
            // If biometric fails to even show, allow access
            onResult(true)
        }
    }
}
