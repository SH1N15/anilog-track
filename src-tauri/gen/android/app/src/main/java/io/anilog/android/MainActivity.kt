package io.anilog.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    prepareBackground(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    prepareBackground(intent)
  }

  private fun prepareBackground(intent: Intent?) {
    NotificationScheduler.ensureChannel(applicationContext)
    DailyTaskReminderScheduler.ensureChannel(applicationContext)
    if (intent?.getBooleanExtra("openTasks", false) == true) MobileStore.requestOpenTasks(applicationContext)
    NotificationScheduler.scheduleAll(applicationContext)
    DailyTaskReminderScheduler.schedule(applicationContext, true)
    BackgroundSync.schedulePeriodic(applicationContext)
  }
}
