const assert = require('node:assert/strict');
const { removeOrphanedPendingTasks, removePendingTasksForAnime } = require('../electron/task-retention.cjs');

const tasks = [
  { id: 'target-pending', animeId: 10, status: 'pending' },
  { id: 'target-completed', animeId: 10, status: 'completed' },
  { id: 'other-pending', animeId: 20, status: 'pending' },
  { id: 'other-completed', animeId: 20, status: 'completed' },
];

const remaining = removePendingTasksForAnime(tasks, 10);

assert.deepEqual(remaining.map((task) => task.id), [
  'target-completed',
  'other-pending',
  'other-completed',
]);
assert.equal(tasks.length, 4, 'The input task list must not be mutated.');
assert.deepEqual(removePendingTasksForAnime(tasks, 999), tasks);

const migrated = removeOrphanedPendingTasks(tasks, [20]);
assert.deepEqual(migrated.map((task) => task.id), [
  'target-completed',
  'other-pending',
  'other-completed',
]);

console.log('Task retention tests passed.');
