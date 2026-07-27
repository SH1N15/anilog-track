const assert = require('node:assert/strict');
const {
  DEFAULT_REMINDER_TIME,
  localDateKey,
  nextReminderAt,
  normalizeReminderTime,
  shouldSendMissedReminder,
} = require('../electron/daily-task-reminder.cjs');

assert.equal(normalizeReminderTime('08:05'), '08:05');
assert.equal(normalizeReminderTime('23:59'), '23:59');
assert.equal(normalizeReminderTime('24:00'), DEFAULT_REMINDER_TIME);
assert.equal(normalizeReminderTime('8:05'), DEFAULT_REMINDER_TIME);
assert.equal(normalizeReminderTime(null), DEFAULT_REMINDER_TIME);

const before = new Date(2026, 6, 27, 19, 30, 0);
const after = new Date(2026, 6, 27, 20, 30, 0);
assert.equal(localDateKey(before), '2026-07-27');
assert.equal(shouldSendMissedReminder(before, '20:00', ''), false);
assert.equal(shouldSendMissedReminder(after, '20:00', ''), true);
assert.equal(shouldSendMissedReminder(after, '20:00', '2026-07-27'), false);
assert.equal(nextReminderAt(before, '20:00').getTime(), new Date(2026, 6, 27, 20, 0, 0).getTime());
assert.equal(nextReminderAt(after, '20:00').getTime(), new Date(2026, 6, 28, 20, 0, 0).getTime());

console.log('Daily task reminder tests passed.');
