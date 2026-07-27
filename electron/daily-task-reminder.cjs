const DEFAULT_REMINDER_TIME = '20:00';

function normalizeReminderTime(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return DEFAULT_REMINDER_TIME;
  return value;
}

function localDateKey(value = new Date()) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function reminderTimeToday(now, reminderTime) {
  const [hours, minutes] = normalizeReminderTime(reminderTime).split(':').map(Number);
  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);
  return target;
}

function shouldSendMissedReminder(now, reminderTime, lastReminderDate) {
  return now.getTime() >= reminderTimeToday(now, reminderTime).getTime()
    && lastReminderDate !== localDateKey(now);
}

function nextReminderAt(now, reminderTime) {
  const target = reminderTimeToday(now, reminderTime);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target;
}

module.exports = {
  DEFAULT_REMINDER_TIME,
  localDateKey,
  nextReminderAt,
  normalizeReminderTime,
  shouldSendMissedReminder,
};
