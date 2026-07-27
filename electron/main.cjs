const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, Notification, powerMonitor, safeStorage, session, shell, Tray } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { editionFromEnvironment, normalizeTitlePreference, productName, titleForPreference } = require('./edition.cjs');
const { normalizeUiLanguage, systemUiLanguage, tr } = require('./i18n.cjs');
const { configurePackagedDataPaths } = require('./data-path.cjs');
const { createSeasonCache } = require('./season-cache.cjs');
const { createWindowLifecycle, isHiddenLaunch } = require('./window-lifecycle.cjs');
const { createCacheStorage } = require('./cache-storage.cjs');
const { removeOrphanedPendingTasks, removePendingTasksForAnime } = require('./task-retention.cjs');
const {
  localDateKey,
  nextReminderAt,
  normalizeReminderTime,
  shouldSendMissedReminder,
} = require('./daily-task-reminder.cjs');
const { createWebDavService } = require('./webdav-service.cjs');
const {
  ensureSyncMetadata,
  markFollowingChanged,
  markFollowingDeleted,
  markTaskChanged,
} = require('./webdav-sync.cjs');

const EDITION = editionFromEnvironment();
const bangumiResolver = EDITION.usesBangumi ? require('./bangumi.cjs') : null;
const BANGUMI_RESOLVER_VERSION = bangumiResolver?.BANGUMI_RESOLVER_VERSION || 0;
const bangumiSearchKeywords = bangumiResolver?.bangumiSearchKeywords || (() => []);
const matchBangumiCandidates = bangumiResolver?.matchBangumiCandidates || (() => ({ status: 'unavailable' }));
const matchOfflineBangumi = bangumiResolver?.matchOfflineBangumi || (() => null);

let dataLocation;
const fallbackLanguage = systemUiLanguage(!EDITION.usesBangumi);
try {
  dataLocation = configurePackagedDataPaths(app);
  if (!dataLocation.legacyRemoved) console.warn('旧版 C 盘数据未能删除，请确认应用退出后手动清理。');
} catch (error) {
  const name = productName(EDITION, fallbackLanguage);
  dialog.showErrorBox(tr(fallbackLanguage, `${name} 无法初始化数据目录`, `${name} could not initialize its data folder`), `${error.message}\n\n${tr(fallbackLanguage, `请确认安装目录可写，并重新启动 ${name}。`, `Make sure the installation folder is writable, then restart ${name}.`)}`);
  throw error;
}

const ANILIST_API = 'https://graphql.anilist.co';
const OFFICIAL_BANGUMI_API = 'https://api.bgm.tv/v0';
const DEFAULT_BANGUMI_PROXY = 'https://sh1n.cc.cd/v0';
const LEGACY_DEFAULT_BANGUMI_PROXY = 'https://bgmapi.anibt.net/v0';
const STATE_VERSION = 2;
function installedUiLanguage() {
  if (EDITION.usesBangumi) return 'zh-CN';
  try {
    const marker = path.join(path.dirname(process.execPath), 'original-locale.txt');
    if (fs.existsSync(marker)) return normalizeUiLanguage(fs.readFileSync(marker, 'utf8'), true);
  } catch {}
  return fallbackLanguage;
}

const DEFAULT_STATE = {
  version: STATE_VERSION,
  following: [],
  tasks: [],
  bangumiTitles: {},
  settings: {
    uiLanguage: installedUiLanguage(),
    pollIntervalMinutes: 5,
    launchAtLogin: false,
    minimizeToTray: true,
    notifyWhenAired: true,
    createWatchTasks: true,
    dailyTaskReminderEnabled: false,
    dailyTaskReminderTime: '20:00',
    bangumiApiBaseUrl: EDITION.usesBangumi ? DEFAULT_BANGUMI_PROXY : '',
    titlePreference: 'auto',
  },
  lastSyncAt: Math.floor(Date.now() / 1000),
  lastTaskReminderDate: '',
  syncMetadata: { followingDeletedAt: {} },
};

let windowLifecycle = null;
let tray = null;
let isQuitting = false;
let syncTimer = null;
let taskReminderTimer = null;
let syncInFlight = null;
let state = null;
const bangumiQueue = [];
const bangumiPending = new Map();
let bangumiActive = 0;
let bangumiUnavailableUntil = 0;
let lastBangumiRequestAt = 0;
let seasonCache = null;
let cacheStorage = null;
let webDavService = null;
const START_HIDDEN = isHiddenLaunch(process.argv);

function normalizeBangumiApiBaseUrl(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return '';
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('请输入有效的 HTTPS 地址');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('反代地址必须是无账号、参数或片段的 HTTPS 地址');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/v0') ? pathname : `${pathname}/v0`;
  return url.toString().replace(/\/$/, '');
}

function migrateBangumiApiBaseUrl(value) {
  if (!EDITION.usesBangumi) return '';
  const configured = typeof value === 'string' ? value.trim().replace(/\/$/, '') : '';
  if (!configured) return value === '' ? '' : DEFAULT_BANGUMI_PROXY;
  return configured === LEGACY_DEFAULT_BANGUMI_PROXY || configured === 'https://bgmapi.anibt.net'
    ? DEFAULT_BANGUMI_PROXY
    : value;
}

function bangumiEndpoints() {
  const configured = normalizeBangumiApiBaseUrl(state.settings.bangumiApiBaseUrl);
  return configured && configured !== OFFICIAL_BANGUMI_API
    ? [configured, OFFICIAL_BANGUMI_API]
    : [OFFICIAL_BANGUMI_API];
}

function statePath() {
  return path.join(app.getPath('userData'), 'anilog-state.json');
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    const loaded = {
      ...DEFAULT_STATE,
      ...parsed,
      following: Array.isArray(parsed.following) ? parsed.following : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      bangumiTitles: EDITION.usesBangumi && parsed.bangumiTitles && typeof parsed.bangumiTitles === 'object'
        ? Object.fromEntries(Object.entries(parsed.bangumiTitles).filter(([, match]) => match?.status === 'matched' || match?.resolverVersion === BANGUMI_RESOLVER_VERSION))
        : {},
      settings: {
        ...DEFAULT_STATE.settings,
        ...(parsed.settings || {}),
        uiLanguage: normalizeUiLanguage(parsed.settings?.uiLanguage || DEFAULT_STATE.settings.uiLanguage, !EDITION.usesBangumi),
        titlePreference: normalizeTitlePreference(parsed.settings?.titlePreference),
        dailyTaskReminderTime: normalizeReminderTime(parsed.settings?.dailyTaskReminderTime),
        bangumiApiBaseUrl: migrateBangumiApiBaseUrl(parsed.settings?.bangumiApiBaseUrl),
      },
      version: STATE_VERSION,
    };
    loaded.following = loaded.following.map((item) => {
      const generatedTitles = [item.title?.native, item.title?.english, item.title?.romaji].filter(Boolean);
      const titleSource = item.titleSource || (generatedTitles.includes(item.displayTitle) || !item.displayTitle ? 'anilist' : 'custom');
      const cached = loaded.bangumiTitles[String(item.id)];
      const useBangumi = EDITION.usesBangumi && titleSource !== 'custom' && cached?.status === 'matched' && cached.nameCn;
      const usePreferredTitle = !EDITION.usesBangumi && titleSource !== 'custom';
      return {
        ...item,
        titleSource: useBangumi ? 'bangumi' : usePreferredTitle ? 'anilist' : titleSource,
        bangumiId: useBangumi ? cached.subjectId : EDITION.usesBangumi ? item.bangumiId || null : null,
        displayTitle: useBangumi ? cached.nameCn : usePreferredTitle ? titleForPreference(item.title, loaded.settings.titlePreference, loaded.settings.uiLanguage) : (item.displayTitle || displayTitle(item.title)),
      };
    });
    const followedById = new Map(loaded.following.map((item) => [item.id, item]));
    loaded.tasks = loaded.tasks.map((task) => {
      const followed = followedById.get(task.animeId);
      return followed ? { ...task, animeTitle: followed.displayTitle } : task;
    });
    loaded.tasks = removeOrphanedPendingTasks(loaded.tasks, followedById.keys());
    ensureSyncMetadata(loaded);
    return loaded;
  } catch {
    const fresh = structuredClone(DEFAULT_STATE);
    ensureSyncMetadata(fresh);
    return fresh;
  }
}

function saveState() {
  const target = statePath();
  const temporary = `${target}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, target);
}

function publicState() {
  return {
    ...state,
    runtime: {
      isDesktop: true,
      notificationsSupported: Notification.isSupported(),
      platform: process.platform,
      edition: EDITION.id,
    },
  };
}

function broadcastState() {
  const mainWindow = windowLifecycle?.getWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:changed', publicState());
  }
}

async function aniListRequest(query, variables) {
  const response = await fetch(ANILIST_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`AniList 暂时不可用（${response.status}）`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors[0].message || 'AniList 返回了无效数据');
  }
  return payload.data;
}

function cachedBangumiTitle(anime) {
  const cached = state.bangumiTitles[String(anime.id)];
  if (!cached) return null;
  if (cached.status !== 'matched' && cached.resolverVersion !== BANGUMI_RESOLVER_VERSION) return null;
  const { year, month, day } = anime.startDate || {};
  const premiere = year ? Date.UTC(year, (month || 12) - 1, day || 1) : 0;
  const maxAge = cached.status === 'matched' ? 180 * 86400 : premiere > Date.now() ? 86400 : 7 * 86400;
  return Math.floor(Date.now() / 1000) - cached.checkedAt < maxAge ? cached : null;
}

function applyBangumiMatch(anime, result) {
  const match = {
    ...result,
    animeId: anime.id,
    checkedAt: Math.floor(Date.now() / 1000),
    resolverVersion: BANGUMI_RESOLVER_VERSION,
  };
  if (match.status !== 'unavailable') {
    state.bangumiTitles[String(anime.id)] = match;
  }

  if (match.status === 'matched' && match.nameCn) {
    const followed = state.following.find((item) => item.id === anime.id);
    if (followed && followed.titleSource !== 'custom') {
      followed.displayTitle = match.nameCn;
      followed.titleSource = 'bangumi';
      followed.bangumiId = match.subjectId;
      state.tasks.forEach((task) => {
        if (task.animeId === anime.id) task.animeTitle = match.nameCn;
      });
    }
  }

  if (match.status !== 'unavailable') {
    saveState();
    broadcastState();
  }
  return match;
}

async function fetchBangumiMatch(anime) {
  const keywords = bangumiSearchKeywords(anime);
  if (keywords.length === 0) return { status: 'unmatched', confidence: 0, candidates: [] };

  let lastError;
  let receivedResponse = false;
  const candidates = new Map();
  for (const keyword of keywords) {
    for (const endpoint of bangumiEndpoints()) {
      try {
        const wait = Math.max(0, 450 - (Date.now() - lastBangumiRequestAt));
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        lastBangumiRequestAt = Date.now();
        const response = await net.fetch(`${endpoint}/search/subjects?limit=12&offset=0`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': `AniLog/${app.getVersion()} (local desktop anime tracker)`,
          },
          body: JSON.stringify({ keyword, sort: 'match', filter: { type: [2] } }),
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        receivedResponse = true;
        (payload.data || []).forEach((candidate) => candidates.set(candidate.id, candidate));
        break;
      } catch (error) {
        lastError = error;
        console.warn(`Bangumi endpoint failed (${endpoint}):`, error.message);
      }
    }

    const result = matchBangumiCandidates(anime, [...candidates.values()]);
    if (result.status === 'matched') return result;
  }

  if (receivedResponse) return matchBangumiCandidates(anime, [...candidates.values()]);
  throw lastError || new Error('Bangumi API unavailable');
}

async function testBangumiConnection(requestedBaseUrl) {
  const baseUrl = normalizeBangumiApiBaseUrl(requestedBaseUrl) || OFFICIAL_BANGUMI_API;
  try {
    const response = await net.fetch(`${baseUrl}/search/subjects?limit=1&offset=0`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': `AniLog/${app.getVersion()} (connection test)`,
      },
      body: JSON.stringify({ keyword: 'CLANNAD', sort: 'match', filter: { type: [2] } }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return { ok: false, message: `连接失败（HTTP ${response.status}）`, baseUrl };
    const payload = await response.json();
    const ok = Array.isArray(payload.data);
    return { ok, message: ok ? '连接成功' : '返回的数据格式不正确', baseUrl };
  } catch (error) {
    return { ok: false, message: error.name === 'TimeoutError' ? '连接超时' : `连接失败：${error.message}`, baseUrl };
  }
}

function pumpBangumiQueue() {
  if (bangumiActive >= 1 || bangumiQueue.length === 0) return;
  const job = bangumiQueue.shift();

  if (Date.now() < bangumiUnavailableUntil) {
    bangumiPending.delete(job.anime.id);
    job.resolve(applyBangumiMatch(job.anime, { status: 'unavailable' }));
    queueMicrotask(pumpBangumiQueue);
    return;
  }

  bangumiActive += 1;
  fetchBangumiMatch(job.anime)
    .then((result) => job.resolve(applyBangumiMatch(job.anime, result)))
    .catch((error) => {
      bangumiUnavailableUntil = Date.now() + 10 * 60_000;
      console.warn('Bangumi title lookup paused:', error.message);
      job.resolve(applyBangumiMatch(job.anime, { status: 'unavailable' }));
    })
    .finally(() => {
      bangumiActive -= 1;
      bangumiPending.delete(job.anime.id);
      pumpBangumiQueue();
    });
}

function resolveBangumiTitle(anime) {
  const cached = cachedBangumiTitle(anime);
  if (cached?.status === 'matched') return Promise.resolve(cached);
  const offline = matchOfflineBangumi(anime);
  if (offline?.status === 'matched') return Promise.resolve(applyBangumiMatch(anime, offline));
  if (cached) return Promise.resolve(cached);
  if (bangumiPending.has(anime.id)) return bangumiPending.get(anime.id);

  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  bangumiPending.set(anime.id, pending);
  bangumiQueue.push({ anime, resolve: complete });
  pumpBangumiQueue();
  return pending;
}

const SEASON_QUERY = `
  query SeasonAnime($season: MediaSeason, $year: Int, $page: Int) {
    Page(page: $page, perPage: 50) {
      pageInfo { hasNextPage lastPage }
      media(
        type: ANIME
        season: $season
        seasonYear: $year
        status_not: CANCELLED
        isAdult: false
        sort: [POPULARITY_DESC]
      ) {
        id
        title { native romaji english }
        coverImage { extraLarge medium color }
        bannerImage
        description(asHtml: false)
        format
        episodes
        duration
        status
        season
        seasonYear
        startDate { year month day }
        studios(isMain: true) { nodes { name } }
        genres
        averageScore
        popularity
        nextAiringEpisode { episode airingAt timeUntilAiring }
        airingSchedule(notYetAired: true, perPage: 50) {
          nodes { episode airingAt }
        }
        siteUrl
      }
    }
  }
`;

async function fetchSeasonFromNetwork({ season, year }) {
  const first = await aniListRequest(SEASON_QUERY, { season, year, page: 1 });
  const lastPage = Math.min(5, Math.max(1, Number(first.Page.pageInfo.lastPage) || 1));
  if (lastPage === 1) return first.Page.media;

  const pages = new Array(lastPage);
  pages[0] = first.Page.media;
  let nextPage = 2;
  const worker = async () => {
    while (nextPage <= lastPage) {
      const page = nextPage;
      nextPage += 1;
      const data = await aniListRequest(SEASON_QUERY, { season, year, page });
      pages[page - 1] = data.Page.media;
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, lastPage - 1) }, worker));
  return pages.flat();
}

function broadcastSeasonUpdate(update) {
  const mainWindow = windowLifecycle?.getWindow();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('season:updated', update);
}

const AIRING_QUERY = `
  query AiredEpisodes($ids: [Int], $from: Int, $to: Int, $page: Int) {
    Page(page: $page, perPage: 50) {
      pageInfo { hasNextPage }
      airingSchedules(
        mediaId_in: $ids
        airingAt_greater: $from
        airingAt_lesser: $to
        sort: TIME
      ) {
        id
        mediaId
        episode
        airingAt
        media {
          id
          title { native romaji english }
          coverImage { medium }
          episodes
          nextAiringEpisode { episode airingAt timeUntilAiring }
        }
      }
    }
  }
`;

function displayTitle(title) {
  return titleForPreference(title, EDITION.usesBangumi ? 'auto' : state?.settings?.titlePreference, state?.settings?.uiLanguage);
}

function notifyTasks(created) {
  if (!state.settings.notifyWhenAired || !Notification.isSupported() || created.length === 0) return;

  if (created.length > 3) {
    const language = state.settings.uiLanguage;
    const notification = new Notification({
      title: tr(language, '新番已更新', 'Anime updates are available'),
      body: tr(language, `${created.length} 集新内容已经加入待看任务。`, `${created.length} new episodes were added to your watch tasks.`),
      silent: false,
    });
    notification.on('click', showWindow);
    notification.show();
    return;
  }

  created.forEach((task) => {
    const language = state.settings.uiLanguage;
    const notification = new Notification({
      title: tr(language, `${task.animeTitle} 更新了`, `${task.animeTitle} has a new episode`),
      body: tr(language, `第 ${task.episode} 集已播出，已加入待看任务。`, `Episode ${task.episode} has aired and was added to your watch tasks.`),
      silent: false,
    });
    notification.on('click', showWindow);
    notification.show();
  });
}

function openTasksWindow() {
  if (isQuitting) return;
  const mainWindow = windowLifecycle?.show();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const send = () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('tasks:open');
  };
  if (mainWindow.webContents.isLoading()) mainWindow.webContents.once('did-finish-load', send);
  else send();
}

function notifyDailyTasks(now = new Date()) {
  if (!state.settings.dailyTaskReminderEnabled || !Notification.isSupported()) return false;
  const pending = state.tasks.filter((task) => task.status === 'pending');
  if (pending.length === 0) return false;

  const language = state.settings.uiLanguage;
  const preview = pending.slice(0, 3).map((task) => tr(
    language,
    `${task.animeTitle} 第 ${task.episode} 集`,
    `${task.animeTitle} Episode ${task.episode}`,
  ));
  const remaining = pending.length - preview.length;
  const body = `${preview.join(tr(language, '；', '; '))}${remaining > 0
    ? tr(language, `；另有 ${remaining} 集`, `; ${remaining} more`)
    : ''}`;
  const notification = new Notification({
    title: tr(language, `今日还有 ${pending.length} 集待看`, `${pending.length} episode${pending.length === 1 ? '' : 's'} to watch`),
    body,
    silent: false,
  });
  notification.on('click', openTasksWindow);
  notification.show();
  state.lastTaskReminderDate = localDateKey(now);
  saveState();
  return true;
}

function scheduleTaskReminder({ checkMissed = false } = {}) {
  if (taskReminderTimer) clearTimeout(taskReminderTimer);
  taskReminderTimer = null;
  if (isQuitting || !state?.settings?.dailyTaskReminderEnabled) return;

  const now = new Date();
  if (checkMissed && shouldSendMissedReminder(
    now,
    state.settings.dailyTaskReminderTime,
    state.lastTaskReminderDate,
  )) notifyDailyTasks(now);

  const delay = Math.max(1_000, nextReminderAt(new Date(), state.settings.dailyTaskReminderTime).getTime() - Date.now());
  taskReminderTimer = setTimeout(() => {
    taskReminderTimer = null;
    notifyDailyTasks(new Date());
    scheduleTaskReminder();
  }, delay);
}

async function syncAiredEpisodes({ silent = false } = {}) {
  if (isQuitting) return { created: 0, syncedAt: Math.floor(Date.now() / 1000) };
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    const now = Math.floor(Date.now() / 1000);
    const ids = state.following.map((item) => item.id);
    if (ids.length === 0) {
      state.lastSyncAt = now;
      saveState();
      broadcastState();
      return { created: 0, syncedAt: now };
    }

    const from = Math.min(state.lastSyncAt || now, now - 60);
    const schedules = [];
    let page = 1;
    let hasNextPage = true;
    while (hasNextPage && page <= 10) {
      const data = await aniListRequest(AIRING_QUERY, { ids, from, to: now + 1, page });
      schedules.push(...data.Page.airingSchedules);
      hasNextPage = data.Page.pageInfo.hasNextPage;
      page += 1;
    }

    const known = new Set(state.tasks.map((task) => task.id));
    const followedById = new Map(state.following.map((item) => [item.id, item]));
    const created = [];
    for (const airing of schedules) {
      const followed = followedById.get(airing.mediaId);
      if (!followed || airing.airingAt < followed.followedAt) continue;
      followed.nextAiringEpisode = airing.media.nextAiringEpisode || null;
      const id = `${airing.mediaId}-${airing.episode}`;
      if (known.has(id)) continue;
      const task = {
        id,
        animeId: airing.mediaId,
        animeTitle: followed.displayTitle || displayTitle(airing.media.title),
        coverImage: airing.media.coverImage?.medium || followed.coverImage,
        episode: airing.episode,
        airingAt: airing.airingAt,
        status: 'pending',
        createdAt: now,
        completedAt: null,
        syncUpdatedAt: Date.now(),
      };
      state.tasks.push(task);
      known.add(id);
      created.push(task);
    }

    state.lastSyncAt = now;
    state.tasks.sort((a, b) => b.airingAt - a.airingAt);
    saveState();
    broadcastState();
    if (created.length > 0) webDavService?.schedule();
    if (!silent) notifyTasks(created);
    return { created: created.length, syncedAt: now };
  })().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

function scheduleSync() {
  if (syncTimer) clearInterval(syncTimer);
  if (isQuitting) return;
  const minutes = Math.max(1, Number(state.settings.pollIntervalMinutes) || 5);
  syncTimer = setInterval(() => {
    syncAiredEpisodes().catch((error) => console.error('Background sync failed:', error));
  }, minutes * 60_000);
}

function imageAsset(name) {
  return path.join(__dirname, '..', 'assets', name);
}

function loadImageAsset(name) {
  const image = nativeImage.createFromPath(imageAsset(name));
  if (image.isEmpty()) throw new Error(`Unable to load image asset: ${name}`);
  return image;
}

function showWindow() {
  if (isQuitting) return;
  windowLifecycle?.show();
}

function beginShutdown() {
  if (isQuitting) return;
  isQuitting = true;
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
  if (taskReminderTimer) clearTimeout(taskReminderTimer);
  taskReminderTimer = null;
  webDavService?.stop();
}

function updateLoginItemSettings(enabled) {
  app.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    args: enabled ? ['--hidden'] : [],
  });
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: '#f7f8f6',
    icon: imageAsset('app-icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--anilog-edition=${EDITION.id}`],
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) mainWindow.loadURL(devUrl);
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', EDITION.id, 'index.html'));

  // Showing an existing or recreated tray window always publishes the latest
  // task state, even if the renderer missed the original background event.
  mainWindow.on('show', broadcastState);
  // Windows does not guarantee before-quit during logoff or shutdown.
  mainWindow.on('query-session-end', beginShutdown);
  mainWindow.on('session-end', beginShutdown);

  return mainWindow;
}

function createTray() {
  tray = new Tray(loadImageAsset('tray.png'));
  updateTrayMenu();
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

function updateTrayMenu() {
  if (!tray) return;
  const language = state?.settings?.uiLanguage || installedUiLanguage();
  const name = productName(EDITION, language);
  tray.setToolTip(tr(language, `${name} - 追番任务`, `${name} - Anime tracker`));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: tr(language, `打开 ${name}`, `Open ${name}`), click: showWindow },
    { label: tr(language, '立即同步', 'Sync now'), click: () => syncAiredEpisodes().catch(console.error) },
    { type: 'separator' },
    { label: tr(language, '退出', 'Quit'), click: () => { beginShutdown(); app.quit(); } },
  ]));
}

function registerIpc() {
  ipcMain.handle('state:get', () => publicState());
  ipcMain.handle('season:fetch', (_event, params) => seasonCache.get(params));
  if (EDITION.usesBangumi) {
    ipcMain.handle('bangumi:resolve-title', (_event, anime) => resolveBangumiTitle(anime));
    ipcMain.handle('bangumi:test-connection', (_event, baseUrl) => testBangumiConnection(baseUrl));
  }
  ipcMain.handle('follow:toggle', async (_event, anime) => {
    const index = state.following.findIndex((item) => item.id === anime.id);
    if (index >= 0) {
      state.following.splice(index, 1);
      state.tasks = removePendingTasksForAnime(state.tasks, anime.id);
      markFollowingDeleted(state, anime.id);
    } else {
      const bangumiMatch = EDITION.usesBangumi ? state.bangumiTitles[String(anime.id)] : null;
      const hasChineseTitle = EDITION.usesBangumi && bangumiMatch?.status === 'matched' && bangumiMatch.nameCn;
      state.following.push({
        id: anime.id,
        title: anime.title,
        displayTitle: hasChineseTitle ? bangumiMatch.nameCn : displayTitle(anime.title),
        titleSource: hasChineseTitle ? 'bangumi' : 'anilist',
        bangumiId: hasChineseTitle ? bangumiMatch.subjectId : null,
        coverImage: anime.coverImage?.medium || anime.coverImage?.extraLarge || '',
        format: anime.format,
        episodes: anime.episodes,
        seasonYear: anime.seasonYear,
        startDate: anime.startDate,
        nextAiringEpisode: anime.nextAiringEpisode || null,
        siteUrl: anime.siteUrl,
        followedAt: Math.floor(Date.now() / 1000),
      });
      markFollowingChanged(state, anime.id);
    }
    saveState();
    broadcastState();
    webDavService?.schedule();
    return publicState();
  });
  ipcMain.handle('task:toggle', (_event, taskId) => {
    const task = state.tasks.find((item) => item.id === taskId);
    if (task) {
      task.status = task.status === 'completed' ? 'pending' : 'completed';
      task.completedAt = task.status === 'completed' ? Math.floor(Date.now() / 1000) : null;
      markTaskChanged(state, taskId);
      saveState();
      broadcastState();
      webDavService?.schedule();
    }
    return publicState();
  });
  ipcMain.handle('follow:title', (_event, { animeId, displayTitle: requestedTitle }) => {
    const followed = state.following.find((item) => item.id === animeId);
    const nextTitle = typeof requestedTitle === 'string' ? requestedTitle.trim() : '';
    if (followed && nextTitle) {
      followed.displayTitle = nextTitle;
      followed.titleSource = 'custom';
      state.tasks.forEach((task) => {
        if (task.animeId === animeId) task.animeTitle = nextTitle;
      });
      markFollowingChanged(state, animeId);
      saveState();
      broadcastState();
      webDavService?.schedule();
    }
    return publicState();
  });
  ipcMain.handle('settings:update', (_event, patch) => {
    if (EDITION.usesBangumi && Object.prototype.hasOwnProperty.call(patch, 'bangumiApiBaseUrl')) {
      patch = { ...patch, bangumiApiBaseUrl: normalizeBangumiApiBaseUrl(patch.bangumiApiBaseUrl) };
      bangumiUnavailableUntil = 0;
    } else if (!EDITION.usesBangumi && Object.prototype.hasOwnProperty.call(patch, 'bangumiApiBaseUrl')) {
      const { bangumiApiBaseUrl: _ignored, ...safePatch } = patch;
      patch = safePatch;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'titlePreference')) {
      patch = { ...patch, titlePreference: normalizeTitlePreference(patch.titlePreference) };
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'uiLanguage')) {
      patch = { ...patch, uiLanguage: normalizeUiLanguage(patch.uiLanguage, !EDITION.usesBangumi) };
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'dailyTaskReminderTime')) {
      patch = { ...patch, dailyTaskReminderTime: normalizeReminderTime(patch.dailyTaskReminderTime) };
    }
    state.settings = { ...state.settings, ...patch };
    if (!EDITION.usesBangumi && Object.prototype.hasOwnProperty.call(patch, 'titlePreference')) {
      state.following.forEach((item) => {
        if (item.titleSource !== 'custom') item.displayTitle = displayTitle(item.title);
      });
      const followedById = new Map(state.following.map((item) => [item.id, item]));
      state.tasks.forEach((task) => {
        const followed = followedById.get(task.animeId);
        if (followed) task.animeTitle = followed.displayTitle;
      });
    }
    updateLoginItemSettings(state.settings.launchAtLogin);
    updateTrayMenu();
    scheduleSync();
    scheduleTaskReminder();
    saveState();
    broadcastState();
    return publicState();
  });
  ipcMain.handle('sync:now', () => syncAiredEpisodes({ silent: true }));
  ipcMain.handle('cache:get', () => cacheStorage.getInfo());
  ipcMain.handle('cache:clear', () => cacheStorage.clear());
  ipcMain.handle('webdav:get-config', () => webDavService.getConfig());
  ipcMain.handle('webdav:save-config', (_event, config) => webDavService.saveConfig(config));
  ipcMain.handle('webdav:test', () => webDavService.testConnection());
  ipcMain.handle('webdav:sync', () => webDavService.syncNow());
  ipcMain.handle('external:open', (_event, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
  });
}

app.setAppUserModelId(EDITION.appId);
app.whenReady().then(() => {
  state = loadState();
  seasonCache = createSeasonCache({
    directory: path.join(app.getPath('userData'), 'season-cache'),
    fetchSeason: fetchSeasonFromNetwork,
    onUpdated: broadcastSeasonUpdate,
  });
  cacheStorage = createCacheStorage({
    electronSession: session.defaultSession,
    userDataDirectory: app.getPath('userData'),
    sessionDataDirectory: app.getPath('sessionData'),
  });
  webDavService = createWebDavService({
    userDataDirectory: app.getPath('userData'),
    safeStorage,
    fetchImpl: net.fetch,
    getState: () => state,
    saveState,
    broadcastState,
    onStateMerged: () => {
      scheduleSync();
      syncAiredEpisodes({ silent: true }).catch((error) => console.warn('Post-WebDAV AniList sync failed:', error.message));
    },
    userAgent: `AniLog/${app.getVersion()} (WebDAV sync)`,
  });
  registerIpc();
  windowLifecycle = createWindowLifecycle({
    createWindow,
    shouldKeepInTray: () => Boolean(state.settings.minimizeToTray),
    isQuitting: () => isQuitting,
  });
  createTray();
  updateLoginItemSettings(state.settings.launchAtLogin);
  if (!START_HIDDEN) showWindow();
  scheduleSync();
  scheduleTaskReminder({ checkMissed: true });
  powerMonitor.on('resume', () => scheduleTaskReminder({ checkMissed: true }));
  webDavService.start();
  syncAiredEpisodes().catch((error) => console.error('Initial sync failed:', error));
  if (EDITION.usesBangumi) {
    state.following
      .filter((item) => item.titleSource !== 'custom')
      .forEach((item) => resolveBangumiTitle(item).catch(() => {}));
  }
});

app.on('before-quit', beginShutdown);
app.on('will-quit', beginShutdown);
// Keep the tray, scheduler and notifications alive after the renderer is released.
app.on('window-all-closed', () => {});
app.on('activate', showWindow);
