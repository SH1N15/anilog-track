const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWebDavService, normalizeBaseUrl } = require('../electron/webdav-service.cjs');

assert.equal(normalizeBaseUrl('https://dav.example.com/root'), 'https://dav.example.com/root/');
assert.throws(() => normalizeBaseUrl('http://dav.example.com/'), /HTTPS/);

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'anilog-webdav-test-'));
let remoteBody = '';
let remoteEtag = '';
const requests = [];
const state = {
  following: [{ id: 1, title: { romaji: 'One' }, displayTitle: 'One', followedAt: 10, syncUpdatedAt: 10_000 }],
  tasks: [{ id: '1-1', animeId: 1, animeTitle: 'One', episode: 1, airingAt: 20, status: 'pending', createdAt: 20, completedAt: null, syncUpdatedAt: 20_000 }],
  syncMetadata: { followingDeletedAt: {} },
};

const service = createWebDavService({
  userDataDirectory: temporaryDirectory,
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString().replace(/^encrypted:/, ''),
  },
  fetchImpl: async (url, options) => {
    requests.push({ url, method: options.method, headers: options.headers });
    if (options.method === 'PROPFIND') return new Response('', { status: 207 });
    if (options.method === 'MKCOL') return new Response('', { status: 201 });
    if (options.method === 'GET') {
      return remoteBody
        ? new Response(remoteBody, { status: 200, headers: { ETag: remoteEtag } })
        : new Response('', { status: 404 });
    }
    if (options.method === 'PUT') {
      if (remoteBody && options.headers['If-Match'] !== remoteEtag) return new Response('', { status: 412 });
      remoteBody = options.body;
      remoteEtag = '"revision-1"';
      return new Response('', { status: 201, headers: { ETag: remoteEtag } });
    }
    return new Response('', { status: 500 });
  },
  getState: () => state,
  saveState: () => {},
  broadcastState: () => {},
});

(async () => {
  service.saveConfig({ enabled: true, baseUrl: 'https://dav.example.com/root/', username: 'user', password: 'secret' });
  const configFile = fs.readFileSync(path.join(temporaryDirectory, 'webdav-config.json'), 'utf8');
  assert.equal(configFile.includes('secret'), false);
  assert.equal((await service.testConnection()).ok, true);
  assert.equal((await service.syncNow()).ok, true);
  assert.equal(JSON.parse(remoteBody).following.length, 1);
  assert.ok(requests.some((request) => request.method === 'PUT' && request.headers['If-None-Match'] === '*'));

  const remote = JSON.parse(remoteBody);
  remote.tasks[0].status = 'completed';
  remote.tasks[0].completedAt = 30;
  remote.tasks[0].syncUpdatedAt = 30_000;
  remoteBody = JSON.stringify(remote);
  remoteEtag = '"revision-2"';
  const result = await service.syncNow();
  assert.equal(result.changed, true);
  assert.equal(state.tasks[0].status, 'completed');
  assert.equal(service.getConfig().lastError, '');

  service.stop();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  console.log('WebDAV service tests passed.');
})().catch((error) => {
  service.stop();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  throw error;
});
