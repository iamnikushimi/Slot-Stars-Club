package com.slotstarsclub.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Downloads APK files in-app with a progress notification.
 * After download completes, triggers the Android package installer.
 */
object ApkDownloader {

    private const val TAG = "SSC-Downloader"
    private const val CHANNEL_ID = "ssc_apk_download"
    private const val NOTIFICATION_ID = 2001

    interface DownloadListener {
        fun onProgress(percent: Int)
        fun onComplete(file: File)
        fun onError(message: String)
    }

    /**
     * Download an APK from [url] and save to app's external files directory.
     * Shows a progress notification during download.
     */
    suspend fun downloadApk(
        context: Context,
        url: String,
        listener: DownloadListener? = null
    ) {
        withContext(Dispatchers.IO) {
            val notificationManager =
                context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

            // Create notification channel
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    "App Updates",
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    description = "Shows download progress for app updates"
                    setShowBadge(false)
                }
                notificationManager.createNotificationChannel(channel)
            }

            val builder = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Downloading Update")
                .setContentText("Starting download...")
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .setAutoCancel(false)
                .setProgress(100, 0, false)
                .setColor(0xFFFFD700.toInt())

            notificationManager.notify(NOTIFICATION_ID, builder.build())

            try {
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.requestMethod = "GET"
                conn.connectTimeout = 30000
                conn.readTimeout = 60000
                conn.connect()

                if (conn.responseCode != 200) {
                    throw Exception("HTTP ${conn.responseCode}")
                }

                val fileLength = conn.contentLength
                val downloadDir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
                    ?: context.cacheDir
                val apkFile = File(downloadDir, "SlotStarsClub-update.apk")

                // Delete old file if exists
                if (apkFile.exists()) apkFile.delete()

                val input = conn.inputStream
                val output = FileOutputStream(apkFile)

                val buffer = ByteArray(8192)
                var totalRead = 0L
                var lastNotifiedPercent = -1
                var bytesRead: Int

                while (input.read(buffer).also { bytesRead = it } != -1) {
                    output.write(buffer, 0, bytesRead)
                    totalRead += bytesRead

                    if (fileLength > 0) {
                        val percent = ((totalRead * 100) / fileLength).toInt()
                        if (percent != lastNotifiedPercent) {
                            lastNotifiedPercent = percent

                            // Update notification
                            val sizeMB = String.format("%.1f", totalRead / 1048576.0)
                            val totalMB = String.format("%.1f", fileLength / 1048576.0)
                            builder.setContentText("$sizeMB MB / $totalMB MB")
                                .setProgress(100, percent, false)
                            notificationManager.notify(NOTIFICATION_ID, builder.build())

                            // Callback on main thread
                            withContext(Dispatchers.Main) {
                                listener?.onProgress(percent)
                            }
                        }
                    }
                }

                output.flush()
                output.close()
                input.close()
                conn.disconnect()

                Log.d(TAG, "Download complete: ${apkFile.absolutePath}")

                // Update notification to show completion
                val installIntent = getInstallIntent(context, apkFile)
                val pendingIntent = PendingIntent.getActivity(
                    context, 0, installIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )

                builder.setContentTitle("Update Downloaded")
                    .setContentText("Tap to install Slot Stars Club")
                    .setProgress(0, 0, false)
                    .setOngoing(false)
                    .setAutoCancel(true)
                    .setContentIntent(pendingIntent)
                notificationManager.notify(NOTIFICATION_ID, builder.build())

                withContext(Dispatchers.Main) {
                    listener?.onComplete(apkFile)
                }

            } catch (e: Exception) {
                Log.e(TAG, "Download failed", e)

                builder.setContentTitle("Download Failed")
                    .setContentText("Tap to retry")
                    .setProgress(0, 0, false)
                    .setOngoing(false)
                    .setAutoCancel(true)
                notificationManager.notify(NOTIFICATION_ID, builder.build())

                withContext(Dispatchers.Main) {
                    listener?.onError(e.message ?: "Unknown error")
                }
            }
        }
    }

    /**
     * Create an intent to install the downloaded APK
     */
    fun getInstallIntent(context: Context, apkFile: File): Intent {
        val uri: Uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                apkFile
            )
        } else {
            Uri.fromFile(apkFile)
        }

        return Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }

    /**
     * Install a downloaded APK file
     */
    fun installApk(context: Context, apkFile: File) {
        try {
            val intent = getInstallIntent(context, apkFile)
            context.startActivity(intent)
        } catch (e: Exception) {
            Log.e(TAG, "Install failed", e)
        }
    }
}
