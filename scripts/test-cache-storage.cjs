const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCacheStorage, directorySize, samePath } = require('../electron/cache-storage.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anilog-cache-storage-test-'));

async function run() {
  try {
    const userData = path.join(root, 'data');
    const sessionData = path.join(userData, 'Session Data');
    fs.mkdirSync(path.join(userData, 'Cache', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(userData, 'GPUCache'), { recursive: true });
    fs.mkdirSync(sessionData, { recursive: true });
    fs.writeFileSync(path.join(userData, 'Cache', 'entry'), '12345');
    fs.writeFileSync(path.join(userData, 'Cache', 'nested', 'entry'), '123');
    fs.writeFileSync(path.join(userData, 'GPUCache', 'entry'), '12');
    fs.writeFileSync(path.join(userData, 'anilog-state.json'), '{"following":[]}');
    fs.mkdirSync(path.join(userData, 'season-cache'));
    fs.writeFileSync(path.join(userData, 'season-cache', '2026-FALL.json'), 'season');

    assert.equal(await directorySize(path.join(userData, 'Cache')), 8);
    assert.equal(samePath(userData, `${userData}${path.sep}`), true);

    let cacheBytes = 100;
    let cacheCleared = 0;
    let codeCacheCleared = 0;
    const storage = createCacheStorage({
      electronSession: {
        getCacheSize: async () => cacheBytes,
        clearCache: async () => { cacheBytes = 0; cacheCleared += 1; },
        clearCodeCaches: async () => { codeCacheCleared += 1; },
      },
      userDataDirectory: userData,
      sessionDataDirectory: sessionData,
    });

    assert.deepEqual(await storage.getInfo(), {
      bytes: 110,
      sessionBytes: 100,
      legacyBytes: 10,
      supported: true,
    });
    assert.deepEqual(await storage.clear(), {
      bytes: 0,
      sessionBytes: 0,
      legacyBytes: 0,
      supported: true,
    });
    assert.equal(cacheCleared, 1);
    assert.equal(codeCacheCleared, 1);
    assert.equal(fs.existsSync(path.join(userData, 'Cache')), false);
    assert.equal(fs.existsSync(path.join(userData, 'GPUCache')), false);
    assert.equal(fs.existsSync(path.join(userData, 'anilog-state.json')), true);
    assert.equal(fs.existsSync(path.join(userData, 'season-cache', '2026-FALL.json')), true);

    const sharedData = path.join(root, 'shared');
    fs.mkdirSync(path.join(sharedData, 'Cache'), { recursive: true });
    fs.writeFileSync(path.join(sharedData, 'Cache', 'active'), 'active');
    const sharedStorage = createCacheStorage({
      electronSession: {
        getCacheSize: async () => 6,
        clearCache: async () => {},
      },
      userDataDirectory: sharedData,
      sessionDataDirectory: sharedData,
    });
    await sharedStorage.clear();
    assert.equal(fs.existsSync(path.join(sharedData, 'Cache', 'active')), true);

    console.log('Cache storage tests passed.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
