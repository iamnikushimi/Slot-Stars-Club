package com.slotstarsclub.app

import android.app.Activity
import android.app.AlertDialog
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

object UpdateChecker {

    private const val TAG = "SSC-Update"

    data class VersionInfo(
        val latestVersion: String,
        val latestCode: Int,
        val forceUpdate: Boolean,
        val apkUrl: String,
        val message: String
    )

    /**
     * Check server for latest version info.
     * Returns null if check fails (network error, etc.)
     */
    suspend fun checkForUpdate(): VersionInfo? {
        return withContext(Dispatchers.IO) {
            try {
                val url = URL("${BuildConfig.BASE_URL}/api/app/version")
                val conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "GET"
                conn.connectTimeout = 8000
                conn.readTimeout = 8000
                conn.setRequestProperty("Accept", "application/json")

                if (conn.responseCode != 200) {
                    Log.w(TAG, "Version check failed: HTTP ${conn.responseCode}")
                    conn.disconnect()
                    return@withContext null
                }

                val body = conn.inputStream.bufferedReader().readText()
                conn.disconnect()

                val json = JSONObject(body)
                VersionInfo(
                    latestVersion = json.optString("latestVersion", "1.0.0"),
                    latestCode = json.optInt("latestCode", 1),
                    forceUpdate = json.optBoolean("forceUpdate", false),
                    apkUrl = json.optString("apkUrl", ""),
                    message = json.optString("message", "A new version is available.")
                )
            } catch (e: Exception) {
                Log.e(TAG, "Version check error", e)
                null
            }
        }
    }

    /**
     * Returns true if the installed version is older than the server version
     */
    fun needsUpdate(serverCode: Int): Boolean {
        val installedCode = BuildConfig.VERSION_CODE
        return serverCode > installedCode
    }

    /**
     * Show a force-update dialog that blocks the app until the user updates.
     * Dialog is non-cancellable — the user MUST update to continue.
     *
     * @param onDownload callback that triggers in-app APK download with progress
     */
    fun showForceUpdateDialog(
        activity: Activity,
        info: VersionInfo,
        onDownload: (String) -> Unit
    ) {
        Log.d(TAG, "Showing force update dialog: ${info.latestVersion}")

        val dialog = AlertDialog.Builder(activity, R.style.ForceUpdateDialog)
            .setTitle("Update Required")
            .setMessage(
                "${info.message}\n\n" +
                "Your version: ${BuildConfig.VERSION_NAME}\n" +
                "Latest version: ${info.latestVersion}\n\n" +
                "You must update to continue playing."
            )
            .setCancelable(false)
            .setPositiveButton("Download Update") { _, _ ->
                if (info.apkUrl.isNotBlank()) {
                    onDownload(info.apkUrl)
                }
            }
            .create()

        dialog.show()

        // Style the dialog buttons
        dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.apply {
            setTextColor(0xFFFFD700.toInt())
            textSize = 16f
        }
    }

    /**
     * Show an optional update dialog (user can dismiss).
     *
     * @param onDownload callback that triggers in-app APK download with progress
     */
    fun showOptionalUpdateDialog(
        activity: Activity,
        info: VersionInfo,
        onDownload: (String) -> Unit
    ) {
        val dialog = AlertDialog.Builder(activity, R.style.ForceUpdateDialog)
            .setTitle("Update Available")
            .setMessage(
                "${info.message}\n\n" +
                "Latest version: ${info.latestVersion}"
            )
            .setPositiveButton("Update Now") { _, _ ->
                if (info.apkUrl.isNotBlank()) {
                    onDownload(info.apkUrl)
                }
            }
            .setNegativeButton("Later", null)
            .create()

        dialog.show()

        dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.apply {
            setTextColor(0xFFFFD700.toInt())
        }
        dialog.getButton(AlertDialog.BUTTON_NEGATIVE)?.apply {
            setTextColor(0xFF888888.toInt())
        }
    }
}
