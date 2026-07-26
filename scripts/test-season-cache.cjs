const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ACTIVE_TTL_MS,
  FAILURE_BACKOFF_MS,
  PAST_TTL_MS,
  createSeasonCache,
  seasonCacheTtl,
} = require('../electron/season-cache.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anilog-season-cache-test-'));
let clock = Date.UTC(2026, 6, 26);
const params = { season: 'FALL', year: 2026 };

async function run() {
  try {
    assert.equal(seasonCacheTtl(params, clock), ACTIVE_TTL_MS);
    assert.equal(seasonCacheTtl({ season: 'SPRING', year: 2025 }, clock), PAST_TTL_MS);

    let fetches = 0;
    const updates = [];
    const cache = createSeasonCache({
      directory: root,
      now: () => clock,
      fetchSeason: async () => [{ id: ++fetches }],
      onUpdated: (update) => updates.push(update),
    });

    assert.deepEqual(await cache.get(params), [{ id: 1 }]);
    assert.deepEqual(await cache.get(params), [{ id: 1 }]);
    assert.equal(fetches, 1);
    assert.equal(updates.length, 1);
    assert.equal(fs.existsSync(path.join(root, '2026-FALL.json')), true);

    let restartedFetches = 0;
    const restarted = createSeasonCache({
      directory: root,
      now: () => clock,
      fetchSeason: async () => [{ id: 100 + ++restartedFetches }],
    });
    assert.deepEqual(await restarted.get(params), [{ id: 1 }]);
    assert.equal(restartedFetches, 0);

    clock += ACTIVE_TTL_MS + 1;
    assert.deepEqual(await restarted.get(params), [{ id: 1 }]);
    assert.deepEqual(await restarted.refresh(params), [{ id: 101 }]);
    assert.equal(restartedFetches, 1);

    const concurrentDirectory = path.join(root, 'concurrent');
    let releaseFetch;
    let concurrentFetches = 0;
    const concurrent = createSeasonCache({
      directory: concurrentDirectory,
      now: () => clock,
      fetchSeason: () => {
        concurrentFetches += 1;
        return new Promise((resolve) => { releaseFetch = () => resolve([{ id: 2 }]); });
      },
    });
    const first = concurrent.get(params);
    const second = concurrent.get(params);
    await Promise.resolve();
    assert.equal(concurrentFetches, 1);
    releaseFetch();
    assert.deepEqual(await Promise.all([first, second]), [[{ id: 2 }], [{ id: 2 }]]);

    let activeFetches = 0;
    let maximumFetches = 0;
    const limited = createSeasonCache({
      directory: path.join(root, 'limited'),
      now: () => clock,
      fetchSeason: async ({ year }) => {
        activeFetches += 1;
        maximumFetches = Math.max(maximumFetches, activeFetches);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeFetches -= 1;
        return [{ id: year }];
      },
    });
    await Promise.all([
      limited.get({ season: 'FALL', year: 2026 }),
      limited.get({ season: 'WINTER', year: 2027 }),
      limited.get({ season: 'SPRING', year: 2027 }),
    ]);
    assert.equal(maximumFetches, 1);

    let failedFetches = 0;
    const failed = createSeasonCache({
      directory: path.join(root, 'failed'),
      now: () => clock,
      fetchSeason: async () => { failedFetches += 1; throw new Error('offline'); },
    });
    await assert.rejects(failed.get(params), /offline/);
    await assert.rejects(failed.get(params), /退避/);
    assert.equal(failedFetches, 1);
    clock += FAILURE_BACKOFF_MS + 1;
    await assert.rejects(failed.get(params), /offline/);
    assert.equal(failedFetches, 2);

    console.log('Season cache tests passed.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
