package com.slotstarsclub.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            Log.d("SSC-Boot", "Device rebooted — rescheduling daily bonus notification")
            NotificationScheduler.scheduleDailyBonus(context)
        }
    }
}
