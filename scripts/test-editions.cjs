const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { editionFromEnvironment, productName, titleForPreference } = require('../electron/edition.cjs');
const { normalizeUiLanguage, tr } = require('../electron/i18n.cjs');

const root = path.join(__dirname, '..');

assert.equal(editionFromEnvironment({}).id, 'standard');
assert.equal(editionFromEnvironment({ ANILOG_EDITION: 'original' }).id, 'original');
assert.equal(editionFromEnvironment({ ANILOG_EDITION: 'original' }).usesBangumi, false);
assert.equal(titleForPreference({ english: 'English', romaji: 'Romaji', native: '日本語' }, 'auto'), 'English');
assert.equal(titleForPreference({ english: 'English', romaji: 'Romaji', native: '日本語' }, 'romaji'), 'Romaji');
assert.equal(titleForPreference({ romaji: 'Romaji', native: '日本語' }, 'english'), 'Romaji');
assert.equal(titleForPreference({ native: '日本語' }, 'native'), '日本語');
assert.equal(titleForPreference({}, 'auto', 'en-US'), 'Untitled anime');
assert.equal(normalizeUiLanguage('zh-Hans', true), 'zh-CN');
assert.equal(normalizeUiLanguage('en-GB', true), 'en-US');
assert.equal(normalizeUiLanguage('en-US', false), 'zh-CN');
assert.equal(tr('en-US', '中文', 'English'), 'English');
assert.equal(productName(editionFromEnvironment({ ANILOG_EDITION: 'original' }), 'zh-CN'), 'AniLog 原名版');
assert.equal(productName(editionFromEnvironment({ ANILOG_EDITION: 'original' }), 'en-US'), 'AniLog Original');

const originalConfig = fs.readFileSync(path.join(root, 'electron-builder.original.yml'), 'utf8');
assert.match(originalConfig, /appId: io\.anilog\.desktop\.original/);
assert.match(originalConfig, /main: electron\/main-original\.cjs/);
assert.match(originalConfig, /name: anilog-original/);
assert.match(originalConfig, /afterPack: build\/after-pack-original\.cjs/);
assert.match(originalConfig, /!electron\/bangumi\.cjs/);
assert.equal(originalConfig.includes('!node_modules/bangumi-data/**/*'), true);
assert.match(originalConfig, /displayLanguageSelector: true/);
assert.match(originalConfig, /installerLanguages:[\s\S]*en_US[\s\S]*zh_CN/);
assert.match(originalConfig, /include: build\/installer-original\.nsh/);

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(packageJson.scripts['build:android-original'].includes('android-original'), true);
assert.equal(packageJson.scripts['android:sync:original'].includes('ANILOG_ANDROID_EDITION=original'), true);
const androidConfig = fs.readFileSync(path.join(root, 'android', 'app', 'build.gradle'), 'utf8');
assert.match(androidConfig, /original\s*\{[\s\S]*applicationId "io\.anilog\.android\.original"/);

const originalBundleDirectory = path.join(root, 'dist', 'original', 'assets');
for (const bundleDirectory of [originalBundleDirectory, path.join(root, 'dist', 'android-original', 'assets')]) {
  if (fs.existsSync(bundleDirectory)) {
    const bundle = fs.readdirSync(bundleDirectory)
      .filter((name) => name.endsWith('.js'))
      .map((name) => fs.readFileSync(path.join(bundleDirectory, name), 'utf8'))
      .join('\n');
    for (const forbidden of ['bgmapi.anibt.net', 'api.bgm.tv', 'search/subjects', 'bangumi:resolve-title', 'bangumi:test-connection']) {
      assert.equal(bundle.includes(forbidden), false, `Original renderer contains ${forbidden}`);
    }
    assert.equal(bundle.includes('Seasonal Anime'), true, 'Original renderer does not contain English UI strings');
  }
}

console.log('Edition separation tests passed.');
