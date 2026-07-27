const fs = require('node:fs');
const path = require('node:path');
const {
  documentFromState,
  documentsEqual,
  mergeDocumentIntoState,
  normalizeDocument,
} = require('./webdav-sync.cjs');

const CONFIG_FILE = 'webdav-config.json';
const COLLECTION_NAME = 'AniLog';
const SYNC_FILE_NAME = 'anilog-sync.json';
const MAX_SYNC_FILE_BYTES = 5 * 1024 * 1024;

function normalizeBaseUrl(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return '';
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('请输入有效的 WebDAV HTTPS 地址');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('WebDAV 地址必须是无账号、参数或片段的 HTTPS 地址');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.toString();
}

function defaultConfig() {
  return {
    version: 1,
    enabled: false,
    baseUrl: '',
    username: '',
    encryptedPassword: '',
    lastSyncAt: 0,
    lastError: '',
  };
}

function createWebDavService({
  userDataDirectory,
  safeStorage,
  fetchImpl,
  getState,
  saveState,
  broadcastState,
  onStateMerged = () => {},
  userAgent = 'AniLog WebDAV sync',
}) {
  const configPath = path.join(userDataDirectory, CONFIG_FILE);
  let config = loadConfig();
  let inFlight = null;
  let pendingTimer = null;
  let intervalTimer = null;
  let stopping = false;

  function loadConfig() {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return {
        ...defaultConfig(),
        ...parsed,
        baseUrl: normalizeBaseUrl(parsed.baseUrl),
        username: typeof parsed.username === 'string' ? parsed.username.trim() : '',
        encryptedPassword: typeof parsed.encryptedPassword === 'string' ? parsed.encryptedPassword : '',
      };
    } catch {
      return defaultConfig();
    }
  }

  function persistConfig() {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const temporary = `${configPath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2));
    fs.renameSync(temporary, configPath);
  }

  function hasPassword() {
    return Boolean(config.encryptedPassword);
  }

  function publicConfig() {
    return {
      supported: true,
      enabled: Boolean(config.enabled),
      baseUrl: config.baseUrl,
      username: config.username,
      hasPassword: hasPassword(),
      lastSyncAt: Number(config.lastSyncAt) || 0,
      lastError: config.lastError || '',
    };
  }

  function decryptPassword() {
    if (!config.encryptedPassword) return '';
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储当前不可用');
    try {
      return safeStorage.decryptString(Buffer.from(config.encryptedPassword, 'base64'));
    } catch {
      throw new Error('WebDAV 密码无法解密，请重新输入密码');
    }
  }

  function credentials() {
    if (!config.baseUrl || !config.username || !hasPassword()) throw new Error('请先完整填写 WebDAV 地址、用户名和密码');
    return { username: config.username, password: decryptPassword() };
  }

  function endpoint(name = '') {
    return new URL(`${COLLECTION_NAME}/${name}`, config.baseUrl).toString();
  }

  async function request(url, options = {}) {
    if (stopping) throw new Error('应用正在退出');
    const auth = credentials();
    const headers = {
      Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}`,
      'User-Agent': userAgent,
      ...(options.headers || {}),
    };
    return fetchImpl(url, {
      ...options,
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  }

  async function ensureCollection() {
    const response = await request(endpoint(), { method: 'MKCOL' });
    if (response.ok || response.status === 405) return;
    if (response.status === 401 || response.status === 403) throw new Error('WebDAV 认证失败，请检查账号和应用密码');
    throw new Error(`无法创建 AniLog 同步目录（HTTP ${response.status}）`);
  }

  async function download() {
    const response = await request(endpoint(SYNC_FILE_NAME), { method: 'GET', headers: { Accept: 'application/json' } });
    if (response.status === 404) return { found: false, etag: '', document: null };
    if (response.status === 401 || response.status === 403) throw new Error('WebDAV 认证失败，请检查账号和应用密码');
    if (!response.ok) throw new Error(`读取 WebDAV 同步文件失败（HTTP ${response.status}）`);
    const contentLength = Number(response.headers.get('content-length')) || 0;
    if (contentLength > MAX_SYNC_FILE_BYTES) throw new Error('WebDAV 同步文件超过 5 MB，已停止读取');
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_SYNC_FILE_BYTES) throw new Error('WebDAV 同步文件超过 5 MB，已停止读取');
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error('WebDAV 同步文件不是有效的 JSON');
    }
    return { found: true, etag: response.headers.get('etag') || '', document: normalizeDocument(parsed) };
  }

  async function upload(document, remote) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (remote.found) {
      if (remote.etag) headers['If-Match'] = remote.etag;
    } else {
      headers['If-None-Match'] = '*';
    }
    const response = await request(endpoint(SYNC_FILE_NAME), {
      method: 'PUT',
      headers,
      body: JSON.stringify(document, null, 2),
    });
    if (response.status === 409 || response.status === 412) return false;
    if (response.status === 401 || response.status === 403) throw new Error('WebDAV 认证失败，请检查账号和应用密码');
    if (!response.ok) throw new Error(`写入 WebDAV 同步文件失败（HTTP ${response.status}）`);
    return true;
  }

  async function performSync() {
    if (!config.enabled) throw new Error('请先启用 WebDAV 同步');
    credentials();
    await ensureCollection();
    let localChanged = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const remote = await download();
      const current = documentFromState(getState());
      let merged = current;
      let remoteChanged = !remote.found;
      if (remote.found) {
        const result = mergeDocumentIntoState(getState(), remote.document);
        merged = result.document;
        remoteChanged = result.remoteChanged;
        if (result.changed) {
          localChanged = true;
          saveState();
          broadcastState();
          onStateMerged();
        }
      }
      if (!remoteChanged || (remote.found && documentsEqual(remote.document, merged))) break;
      if (await upload(merged, remote)) break;
      if (attempt === 2) throw new Error('WebDAV 文件在同步期间反复变化，请稍后重试');
    }
    config.lastSyncAt = Math.floor(Date.now() / 1000);
    config.lastError = '';
    persistConfig();
    return { ok: true, changed: localChanged, syncedAt: config.lastSyncAt, message: localChanged ? '已合并另一台设备的更新' : '两端数据已同步' };
  }

  async function syncNow() {
    if (inFlight) return inFlight;
    inFlight = performSync()
      .catch((error) => {
        config.lastError = error instanceof Error ? error.message : 'WebDAV 同步失败';
        persistConfig();
        throw error;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  function schedule(delay = 5_000) {
    if (stopping || !config.enabled) return;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      syncNow().catch((error) => console.warn('WebDAV background sync failed:', error.message));
    }, delay);
  }

  function start() {
    if (intervalTimer) clearInterval(intervalTimer);
    intervalTimer = setInterval(() => schedule(0), 15 * 60_000);
    if (config.enabled) schedule(8_000);
  }

  function stop() {
    stopping = true;
    if (pendingTimer) clearTimeout(pendingTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    pendingTimer = null;
    intervalTimer = null;
  }

  function savePublicConfig(input) {
    const baseUrl = normalizeBaseUrl(input?.baseUrl);
    const username = typeof input?.username === 'string' ? input.username.trim() : '';
    if (typeof input?.password === 'string') {
      if (input.password && !safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储当前不可用');
      config.encryptedPassword = input.password ? safeStorage.encryptString(input.password).toString('base64') : '';
    }
    const enabled = Boolean(input?.enabled);
    if (enabled && (!baseUrl || !username || !config.encryptedPassword)) throw new Error('启用同步前请完整填写地址、用户名和密码');
    config = {
      ...config,
      enabled,
      baseUrl,
      username,
      lastError: '',
    };
    persistConfig();
    if (enabled) schedule(0);
    else if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    return publicConfig();
  }

  async function testConnection() {
    credentials();
    let response = await request(config.baseUrl, {
      method: 'PROPFIND',
      headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
      body: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>',
    });
    if (response.status === 405 || response.status === 501) response = await request(config.baseUrl, { method: 'GET' });
    if (response.status === 401 || response.status === 403) throw new Error('WebDAV 认证失败，请检查账号和应用密码');
    if (!response.ok && response.status !== 207) throw new Error(`WebDAV 连接失败（HTTP ${response.status}）`);
    return { ok: true, message: 'WebDAV 连接成功' };
  }

  return {
    getConfig: publicConfig,
    saveConfig: savePublicConfig,
    testConnection,
    syncNow,
    schedule,
    start,
    stop,
  };
}

module.exports = { createWebDavService, normalizeBaseUrl };
