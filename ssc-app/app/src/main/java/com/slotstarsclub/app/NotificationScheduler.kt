package com.slotstarsclub.app

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.Calendar
import java.util.concurrent.TimeUnit

object NotificationScheduler {

    private const val TAG = "SSC-Scheduler"
    private const val DAILY_BONUS_WORK = "ssc_daily_bonus_reminder"

    /**
     * Schedule a daily bonus reminder notification.
     * Fires once every 24 hours. WorkManager handles battery optimization,
     * Doze mode, and rescheduling automatically.
     */
    fun scheduleDailyBonus(context: Context) {
        Log.d(TAG, "Scheduling daily bonus reminder")

        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        // Calculate initial delay to fire around 10:00 AM local time
        val now = Calendar.getInstance()
        val target = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, 10)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
            // If 10 AM already passed today, schedule for tomorrow
            if (before(now)) {
                add(Calendar.DAY_OF_MONTH, 1)
            }
        }

        val initialDelay = target.timeInMillis - now.timeInMillis

        val workRequest = PeriodicWorkRequestBuilder<DailyBonusWorker>(
            24, TimeUnit.HOURS
        )
            .setConstraints(constraints)
            .setInitialDelay(initialDelay, TimeUnit.MILLISECONDS)
            .build()

        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            DAILY_BONUS_WORK,
            ExistingPeriodicWorkPolicy.KEEP,  // Don't replace if already scheduled
            workRequest
        )

        Log.d(TAG, "Daily bonus scheduled, initial delay: ${initialDelay / 1000 / 60} minutes")
    }

    /**
     * Cancel all scheduled notifications
     */
    fun cancelAll(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(DAILY_BONUS_WORK)
        Log.d(TAG, "All scheduled notifications cancelled")
    }
}
