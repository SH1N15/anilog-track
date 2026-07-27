const assert = require('node:assert/strict');
const {
  documentFromState,
  markFollowingChanged,
  markFollowingDeleted,
  markTaskChanged,
  mergeDocumentIntoState,
} = require('../electron/webdav-sync.cjs');

function state() {
  return {
    following: [{ id: 1, title: { romaji: 'One' }, displayTitle: 'One', followedAt: 10, syncUpdatedAt: 10_000 }],
    tasks: [{ id: '1-1', animeId: 1, animeTitle: 'One', episode: 1, airingAt: 20, status: 'pending', createdAt: 20, completedAt: null, syncUpdatedAt: 20_000 }],
    syncMetadata: { followingDeletedAt: {} },
  };
}

const local = state();
const remote = documentFromState(state());
remote.tasks[0].status = 'completed';
remote.tasks[0].completedAt = 30;
remote.tasks[0].syncUpdatedAt = 30_000;
remote.following.push({ id: 2, title: { romaji: 'Two' }, displayTitle: 'Two', followedAt: 25, syncUpdatedAt: 25_000 });

const merged = mergeDocumentIntoState(local, remote);
assert.equal(merged.changed, true);
assert.equal(local.following.length, 2);
assert.equal(local.tasks[0].status, 'completed');
assert.equal(merged.remoteChanged, false);

markFollowingDeleted(local, 2, 40_000);
const deleted = mergeDocumentIntoState(local, remote);
assert.equal(local.following.some((item) => item.id === 2), false);
assert.equal(deleted.remoteChanged, true);

local.following.push({ id: 2, title: { romaji: 'Two' }, displayTitle: 'Two again', followedAt: 50, syncUpdatedAt: 50_000 });
markFollowingChanged(local, 2, 50_000);
assert.equal(documentFromState(local).followingDeletedAt['2'], undefined);

local.tasks.push({ id: '2-1', animeId: 2, animeTitle: 'Two again', episode: 1, airingAt: 60, status: 'pending', createdAt: 60, completedAt: null });
markTaskChanged(local, '2-1', 60_000);
assert.equal(local.tasks.find((task) => task.id === '2-1').syncUpdatedAt, 60_000);

console.log('WebDAV sync merge tests passed.');
