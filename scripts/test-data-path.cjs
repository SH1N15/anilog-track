const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configurePackagedDataPaths, migrateLegacyUserData } = require('../electron/data-path.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anilog-data-test-'));

try {
  const legacy = path.join(root, 'legacy');
  const target = path.join(root, 'installed', 'data');
  fs.mkdirSync(path.join(legacy, 'Cache'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'anilog-state.json'), JSON.stringify({ following: [{ id: 1 }], tasks: [] }));
  fs.writeFileSync(path.join(legacy, 'Cache', 'entry'), 'cached');

  const migrated = migrateLegacyUserData(legacy, target);
  assert.equal(migrated.status, 'migrated');
  assert.equal(migrated.legacyRemoved, true);
  assert.equal(fs.existsSync(legacy), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'anilog-state.json'), 'utf8')).following, [{ id: 1 }]);
  assert.equal(fs.readFileSync(path.join(target, 'Cache', 'entry'), 'utf8'), 'cached');

  const staleLegacy = path.join(root, 'stale-legacy');
  fs.mkdirSync(staleLegacy);
  fs.writeFileSync(path.join(staleLegacy, 'anilog-state.json'), JSON.stringify({ following: [{ id: 2 }] }));
  const existing = migrateLegacyUserData(staleLegacy, target);
  assert.equal(existing.status, 'existing');
  assert.equal(existing.legacyRemoved, false);
  assert.equal(fs.existsSync(staleLegacy), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'anilog-state.json'), 'utf8')).following, [{ id: 1 }]);

  const corruptLegacy = path.join(root, 'corrupt-legacy');
  const corruptTarget = path.join(root, 'corrupt-target');
  fs.mkdirSync(corruptLegacy);
  fs.writeFileSync(path.join(corruptLegacy, 'anilog-state.json'), '{broken');
  assert.throws(() => migrateLegacyUserData(corruptLegacy, corruptTarget));
  assert.equal(fs.existsSync(corruptLegacy), true);
  assert.equal(fs.existsSync(corruptTarget), false);

  const appLegacy = path.join(root, 'app-legacy');
  const executable = path.join(root, 'portable', 'AniLog.exe');
  fs.mkdirSync(appLegacy);
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(path.join(appLegacy, 'anilog-state.json'), JSON.stringify({ following: [], tasks: [] }));
  const configured = {};
  const fakeApp = {
    isPackaged: true,
    getPath(name) { assert.equal(name, 'userData'); return appLegacy; },
    setPath(name, value) { configured[name] = value; },
    setAppLogsPath(value) { configured.logs = value; },
  };
  const location = configurePackagedDataPaths(fakeApp, executable);
  assert.equal(location.dataDirectory, path.join(path.dirname(executable), 'data'));
  assert.equal(configured.userData, location.dataDirectory);
  assert.equal(configured.sessionData, path.join(location.dataDirectory, 'Session Data'));
  assert.equal(configured.crashDumps, path.join(location.dataDirectory, 'Crashpad'));
  assert.equal(configured.logs, path.join(location.dataDirectory, 'logs'));

  console.log('Install-directory data migration tests passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
