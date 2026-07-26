const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { editionFromEnvironment, titleForPreference } = require('../electron/edition.cjs');

const root = path.join(__dirname, '..');

assert.equal(editionFromEnvironment({}).id, 'standard');
assert.equal(editionFromEnvironment({ ANILOG_EDITION: 'original' }).id, 'original');
assert.equal(editionFromEnvironment({ ANILOG_EDITION: 'original' }).usesBangumi, false);
assert.equal(titleForPreference({ english: 'English', romaji: 'Romaji', native: '日本語' }, 'auto'), 'English');
assert.equal(titleForPreference({ english: 'English', romaji: 'Romaji', native: '日本語' }, 'romaji'), 'Romaji');
assert.equal(titleForPreference({ romaji: 'Romaji', native: '日本語' }, 'english'), 'Romaji');
assert.equal(titleForPreference({ native: '日本語' }, 'native'), '日本語');

const originalConfig = fs.readFileSync(path.join(root, 'electron-builder.original.yml'), 'utf8');
assert.match(originalConfig, /appId: io\.anilog\.desktop\.original/);
assert.match(originalConfig, /main: electron\/main-original\.cjs/);
assert.match(originalConfig, /name: anilog-original/);
assert.match(originalConfig, /afterPack: build\/after-pack-original\.cjs/);
assert.match(originalConfig, /!electron\/bangumi\.cjs/);
assert.equal(originalConfig.includes('!node_modules/bangumi-data/**/*'), true);

const originalBundleDirectory = path.join(root, 'dist', 'original', 'assets');
if (fs.existsSync(originalBundleDirectory)) {
  const bundle = fs.readdirSync(originalBundleDirectory)
    .filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(path.join(originalBundleDirectory, name), 'utf8'))
    .join('\n');
  for (const forbidden of ['bgmapi.anibt.net', 'api.bgm.tv', 'search/subjects', 'bangumi:resolve-title', 'bangumi:test-connection']) {
    assert.equal(bundle.includes(forbidden), false, `Original renderer contains ${forbidden}`);
  }
}

console.log('Edition separation tests passed.');
