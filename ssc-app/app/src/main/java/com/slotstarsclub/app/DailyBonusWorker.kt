package com.slotstarsclub.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

class DailyBonusWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {

    companion object {
        private const val TAG = "SSC-BonusWorker"
        const val CHANNEL_ID = "ssc_daily_bonus"
        const val NOTIFICATION_ID = 1001
    }

    override suspend fun doWork(): Result {
        Log.d(TAG, "DailyBonusWorker running")

        // Check if bonus is available via API
        val bonusAvailable = checkBonusAvailable()

        if (bonusAvailable) {
            showBonusNotification()
        } else {
            Log.d(TAG, "Bonus already claimed or unavailable")
        }

        return Result.success()
    }

    private suspend fun checkBonusAvailable(): Boolean {
        return withContext(Dispatchers.IO) {
            try {
                val url = URL("${BuildConfig.BASE_URL}/api/game/daily-bonus/status")
                val conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "GET"
                conn.connectTimeout = 10000
                conn.readTimeout = 10000

                val responseCode = conn.responseCode
                Log.d(TAG, "Bonus check response: $responseCode")

                // If we can't reach the server, assume bonus is available
                // to still send the reminder
                if (responseCode != 200) return@withContext true

                val body = conn.inputStream.bufferedReader().readText()
                conn.disconnect()

                // If response contains "claimed":false or similar, bonus is available
                !body.contains("\"claimed\":true", ignoreCase = true)
            } catch (e: Exception) {
                Log.e(TAG, "Error checking bonus", e)
                // On error, still send notification as a reminder
                true
            }
        }
    }

    private fun showBonusNotification() {
        val notificationManager =
            applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        // Create channel (required for Android 8+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Daily Bonus Reminders",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Reminds you to claim your daily bonus"
                enableLights(true)
                lightColor = 0xFFFFD700.toInt()
                enableVibration(true)
            }
            notificationManager.createNotificationChannel(channel)
        }

        // Intent to open the app at daily bonus page
        val intent = Intent(applicationContext, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("deepLink", "/play/daily-bonus")
        }
        val pendingIntent = PendingIntent.getActivity(
            applicationContext,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Your Daily Bonus is Ready!")
            .setContentText("Claim your free credits now before they expire!")
            .setStyle(
                NotificationCompat.BigTextStyle()
                    .bigText("Your daily bonus is waiting! Log in now to claim your free credits and keep your streak going!")
            )
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setColor(0xFFFFD700.toInt())
            .build()

        notificationManager.notify(NOTIFICATION_ID, notification)
        Log.d(TAG, "Bonus notification sent")
    }
}
