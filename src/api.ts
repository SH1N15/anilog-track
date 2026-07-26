import type { Anime, AppState, BangumiTitleMatch, DesktopApi, Season, Settings } from './types';
import { IS_ORIGINAL_EDITION, normalizeTitlePreference, titleForPreference } from './edition';
import { reminderTitleOf } from './utils';
import { removeOrphanedPendingTasks, removePendingTasksForAnime } from '../electron/task-retention.cjs';

const STORAGE_KEY = IS_ORIGINAL_EDITION ? 'anilog-original-browser-state' : 'anilog-browser-state';
const BANGUMI_RESOLVER_VERSION = 4;
const initialState = (): AppState => ({
  version: 2,
  following: [],
  tasks: [],
  bangumiTitles: {},
  settings: {
    pollIntervalMinutes: 5,
    launchAtLogin: false,
    minimizeToTray: true,
    notifyWhenAired: true,
    bangumiApiBaseUrl: IS_ORIGINAL_EDITION ? '' : 'https://bgmapi.anibt.net/v0',
    titlePreference: 'auto',
  },
  lastSyncAt: Math.floor(Date.now() / 1000),
  runtime: { isDesktop: false, notificationsSupported: 'Notification' in window, platform: 'browser', edition: IS_ORIGINAL_EDITION ? 'original' : 'standard' },
});

let browserState: AppState;
try {
  browserState = { ...initialState(), ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
} catch {
  browserState = initialState();
}
browserState.bangumiTitles = IS_ORIGINAL_EDITION ? {} : Object.fromEntries(
  Object.entries(browserState.bangumiTitles || {}).filter(([, match]) => match.status === 'matched' || match.resolverVersion === BANGUMI_RESOLVER_VERSION),
);
browserState.version = 2;
browserState.settings = { ...initialState().settings, ...(browserState.settings || {}) };
browserState.settings.titlePreference = normalizeTitlePreference(browserState.settings.titlePreference);
browserState.following = (browserState.following || []).map((item) => {
  const generatedTitles = [item.title?.native, item.title?.english, item.title?.romaji].filter(Boolean);
  const titleSource = item.titleSource || (generatedTitles.includes(item.displayTitle) || !item.displayTitle ? 'anilist' : 'custom');
  const cached = browserState.bangumiTitles[String(item.id)];
  const useBangumi = !IS_ORIGINAL_EDITION && titleSource !== 'custom' && cached?.status === 'matched' && cached.nameCn;
  const usePreferredTitle = IS_ORIGINAL_EDITION && titleSource !== 'custom';
  return {
    ...item,
    titleSource: useBangumi ? 'bangumi' : usePreferredTitle ? 'anilist' : titleSource,
    bangumiId: useBangumi ? cached.subjectId : IS_ORIGINAL_EDITION ? null : item.bangumiId || null,
    displayTitle: useBangumi ? cached.nameCn! : usePreferredTitle ? titleForPreference(item.title, browserState.settings.titlePreference) : (item.displayTitle || reminderTitleOf(item.title)),
  };
});
const browserFollowedById = new Map(browserState.following.map((item) => [item.id, item]));
browserState.tasks = (browserState.tasks || []).map((task) => {
  const followed = browserFollowedById.get(task.animeId);
  return followed ? { ...task, animeTitle: followed.displayTitle } : task;
});
browserState.tasks = removeOrphanedPendingTasks(browserState.tasks, browserFollowedById.keys());
const listeners = new Set<(state: AppState) => void>();
const seasonListeners = new Set<(update: { season: Season; year: number; anime: Anime[]; fetchedAt: number }) => void>();

function saveBrowserState() {
  browserState = {
    ...browserState,
    following: [...browserState.following],
    tasks: [...browserState.tasks],
    bangumiTitles: { ...browserState.bangumiTitles },
    settings: { ...browserState.settings },
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(browserState));
  listeners.forEach((listener) => listener(browserState));
}

const query = `
  query SeasonAnime($season: MediaSeason, $year: Int, $page: Int) {
    Page(page: $page, perPage: 50) {
      pageInfo { hasNextPage lastPage }
      media(type: ANIME, season: $season, seasonYear: $year, status_not: CANCELLED, isAdult: false, sort: [POPULARITY_DESC]) {
        id title { native romaji english }
        coverImage { extraLarge medium color }
        bannerImage description(asHtml: false) format episodes duration status season seasonYear
        startDate { year month day }
        studios(isMain: true) { nodes { name } }
        genres averageScore popularity
        nextAiringEpisode { episode airingAt timeUntilAiring }
        airingSchedule(notYetAired: true, perPage: 50) { nodes { episode airingAt } }
        siteUrl
      }
    }
  }
`;

async function browserFetchSeasonFromNetwork(params: { season: Season; year: number }): Promise<Anime[]> {
  const fetchPage = async (page: number) => {
    const response = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables: { ...params, page } }),
    });
    if (!response.ok) throw new Error(`AniList 暂时不可用（${response.status}）`);
    const payload = await response.json();
    if (payload.errors?.length) throw new Error(payload.errors[0].message);
    return payload.data.Page as { pageInfo: { lastPage: number }; media: Anime[] };
  };

  const first = await fetchPage(1);
  const lastPage = Math.min(5, Math.max(1, Number(first.pageInfo.lastPage) || 1));
  if (lastPage === 1) return first.media;
  const pages: Anime[][] = new Array(lastPage);
  pages[0] = first.media;
  let nextPage = 2;
  const worker = async () => {
    while (nextPage <= lastPage) {
      const page = nextPage;
      nextPage += 1;
      pages[page - 1] = (await fetchPage(page)).media;
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, lastPage - 1) }, worker));
  return pages.flat();
}

type BrowserSeasonCacheEntry = { anime: Anime[]; fetchedAt: number };
const browserSeasonCache = new Map<string, BrowserSeasonCacheEntry>();
const browserSeasonPending = new Map<string, Promise<Anime[]>>();
const browserSeasonFailures = new Map<string, number>();
let browserSeasonChain: Promise<unknown> = Promise.resolve();

function browserSeasonKey({ season, year }: { season: Season; year: number }): string {
  return `${year}-${season}`;
}

function browserSeasonTtl({ season, year }: { season: Season; year: number }): number {
  const startMonths: Record<Season, number> = { WINTER: 0, SPRING: 3, SUMMER: 6, FALL: 9 };
  const endYear = season === 'FALL' ? year + 1 : year;
  const endMonth = season === 'FALL' ? 0 : startMonths[season] + 3;
  return Date.now() >= Date.UTC(endYear, endMonth, 1) ? 30 * 86400_000 : 6 * 3600_000;
}

function refreshBrowserSeason(params: { season: Season; year: number }): Promise<Anime[]> {
  const key = browserSeasonKey(params);
  const existing = browserSeasonPending.get(key);
  if (existing) return existing;
  if (Date.now() - (browserSeasonFailures.get(key) || 0) < 5 * 60_000) {
    return Promise.reject(new Error('AniList 刷新暂时退避中，请稍后再试'));
  }
  const networkRequest = browserSeasonChain.then(() => browserFetchSeasonFromNetwork(params));
  browserSeasonChain = networkRequest.then(() => undefined, () => undefined);
  const request = networkRequest
    .then((anime) => {
      const fetchedAt = Date.now();
      browserSeasonFailures.delete(key);
      browserSeasonCache.set(key, { anime, fetchedAt });
      seasonListeners.forEach((listener) => listener({ ...params, anime, fetchedAt }));
      return anime;
    })
    .catch((error) => {
      browserSeasonFailures.set(key, Date.now());
      throw error;
    })
    .finally(() => browserSeasonPending.delete(key));
  browserSeasonPending.set(key, request);
  return request;
}

async function browserFetchSeason(params: { season: Season; year: number }): Promise<Anime[]> {
  const cached = browserSeasonCache.get(browserSeasonKey(params));
  if (!cached) return refreshBrowserSeason(params);
  if (Date.now() - cached.fetchedAt < browserSeasonTtl(params)) return cached.anime;
  void refreshBrowserSeason(params).catch(() => {});
  return cached.anime;
}

let browserBangumiUnavailableUntil = 0;
let browserBangumiChain: Promise<unknown> = Promise.resolve();
const browserBangumiPending = new Map<number, Promise<BangumiTitleMatch>>();

function normalizeBangumiApiBaseUrl(value: string): string {
  const input = value.trim();
  if (!input) return '';
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('反代地址必须是无账号、参数或片段的 HTTPS 地址');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/v0') ? pathname : `${pathname}/v0`;
  return url.toString().replace(/\/$/, '');
}

function browserBangumiEndpoints(): string[] {
  const official = 'https://api.bgm.tv/v0';
  const configured = normalizeBangumiApiBaseUrl(browserState.settings.bangumiApiBaseUrl);
  return configured && configured !== official ? [configured, official] : [official];
}

async function requestBrowserBangumi(baseUrl: string, keyword: string, limit: number): Promise<Response> {
  return fetch(`${baseUrl}/search/subjects?limit=${limit}&offset=0`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ keyword, sort: 'match', filter: { type: [2] } }),
    signal: AbortSignal.timeout(8_000),
  });
}

function normalizedTitle(value?: string | null): string {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\bfirst\s+season\b/gi, 'season1')
    .replace(/\bsecond\s+season\b/gi, 'season2')
    .replace(/\bthird\s+season\b/gi, 'season3')
    .replace(/\bfourth\s+season\b/gi, 'season4')
    .replace(/第\s*(\d+)\s*[季期]/gi, 'season$1')
    .replace(/シーズン\s*(\d+)/gi, 'season$1')
    .replace(/(\d+)(?:st|nd|rd|th)\s*season/gi, 'season$1')
    .replace(/season\s*(\d+)/gi, 'season$1')
    .replace(/(\d+)\s*期/gi, 'season$1')
    .replace(/第?\s*(\d+)\s*クール/gi, 'part$1')
    .replace(/(?:part|cour)\s*(\d+)/gi, 'part$1')
    .replace(/(\d+)(?:st|nd|rd|th)/gi, '$1')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function browserBangumiSearchKeywords(anime: Anime): string[] {
  const keywords: string[] = [];
  const add = (value?: string | null) => {
    const keyword = String(value || '').trim();
    if (keyword && !keywords.includes(keyword)) keywords.push(keyword);
  };

  const titles = [anime.title.native, anime.title.romaji, anime.title.english].filter(Boolean) as string[];
  for (const title of titles) {
    const withoutYear = title.replace(/\s*[（(]\s*(?:19|20)\d{2}\s*[)）]/gu, '').trim();
    const releaseMarker = withoutYear.match(/\s*(?:[-–—:：]\s*)?(?:第\s*\d+\s*[季期]|シーズン\s*\d+|第?\s*\d+\s*クール|(?:\d+(?:st|nd|rd|th)\s*|first\s+|second\s+|third\s+|fourth\s+)?season(?:\s*\d+)?|(?:part|cour)\s*\d+)/iu);
    const baseTitle = releaseMarker?.index ? withoutYear.slice(0, releaseMarker.index).trim() : withoutYear;
    add(title);
    add(withoutYear);
    add(baseTitle);
  }

  return keywords.slice(0, 4);
}

function browserBigramSimilarity(left: string, right: string): number {
  const leftChars = [...left];
  const rightChars = [...right];
  if (leftChars.length < 4 || rightChars.length < 4) return 0;
  const leftPairs = new Set(leftChars.slice(0, -1).map((char, index) => char + leftChars[index + 1]));
  const rightPairs = new Set(rightChars.slice(0, -1).map((char, index) => char + rightChars[index + 1]));
  let overlap = 0;
  leftPairs.forEach((pair) => { if (rightPairs.has(pair)) overlap += 1; });
  return (2 * overlap) / (leftPairs.size + rightPairs.size);
}

function browserDate(anime: Anime): string | null {
  const { year, month, day } = anime.startDate || {};
  return year && month && day ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
}

function browserStageNumbers(value: string): number[] {
  const text = value.normalize('NFKC').toLowerCase();
  if (!text.includes('stage')) return [];
  return [...new Set([...text.matchAll(/(\d+)(?:st|nd|rd|th)?/g)].map((match) => Number(match[1])))].sort((a, b) => a - b);
}

function browserSameNumberSet(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((number, index) => number === right[index]);
}

function browserSeasonNumber(value: string): number | null {
  const text = value.normalize('NFKC').toLowerCase();
  const numeric = text.match(/(?:season\s*(\d+)|シーズン\s*(\d+)|第\s*(\d+)\s*[季期]|(\d+)(?:st|nd|rd|th)\s*season|(\d+)\s*期)/i);
  if (numeric) return Number(numeric.slice(1).find(Boolean));
  const ordinal = text.match(/\b(first|second|third|fourth)\s+season\b/i)?.[1];
  return ordinal ? ({ first: 1, second: 2, third: 3, fourth: 4 } as Record<string, number>)[ordinal] ?? null : null;
}

function browserPartNumber(value: string): number | null {
  const match = value.normalize('NFKC').toLowerCase().match(/(?:第?\s*(\d+)\s*クール|(?:part|cour)\s*(\d+))/i);
  return match ? Number(match.slice(1).find(Boolean)) : null;
}

function browserCommonPrefix(titles: string[]): string {
  if (titles.length < 2 || titles.some((title) => !title)) return '';
  let prefix = titles[0];
  for (const title of titles.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < title.length && prefix[index] === title[index]) index += 1;
    prefix = prefix.slice(0, index);
    if (!prefix) return '';
  }
  prefix = prefix.trim().replace(/[（(【\[·・:：\-—–、/]+$/u, '').trim();
  const shortest = Math.min(...titles.map((title) => [...title].length));
  return [...prefix].length >= 4 && [...prefix].length / shortest >= 0.5 ? prefix : '';
}

function matchBrowserCandidates(anime: Anime, candidates: Array<Record<string, unknown>>): BangumiTitleMatch {
  const native = normalizedTitle(anime.title.native);
  const romaji = normalizedTitle(anime.title.romaji);
  const english = normalizedTitle(anime.title.english);
  const year = anime.startDate?.year || anime.seasonYear;
  const animeDate = browserDate(anime);
  const animeStages = browserStageNumbers([anime.title.native, anime.title.romaji, anime.title.english].filter(Boolean).join(' '));
  const ranked = candidates
    .filter((candidate) => candidate.type === 2 && typeof candidate.name_cn === 'string' && candidate.name_cn.trim())
    .map((candidate) => {
      const name = normalizedTitle(candidate.name as string);
      let score = name === native ? 72 : native && (name.includes(native) || native.includes(name)) ? 52 : 0;
      if (romaji && name === romaji) score += 45;
      if (english && name === english) score += 42;
      if (score === 0) {
        const similarity = Math.max(
          browserBigramSimilarity(name, native),
          browserBigramSimilarity(name, romaji),
          browserBigramSimilarity(name, english),
        );
        if (similarity >= 0.82) score += 42;
        else if (similarity >= 0.7) score += 30;
        else if (similarity >= 0.58) score += 18;
      }
      if (candidate.name_cn) score += 10;
      const animeSeason = browserSeasonNumber([anime.title.native, anime.title.romaji, anime.title.english].filter(Boolean).join(' '));
      const candidateSeason = browserSeasonNumber(`${String(candidate.name || '')} ${String(candidate.name_cn || '')}`);
      if (animeSeason && candidateSeason) score += animeSeason === candidateSeason ? 16 : -24;
      else if (animeSeason && !candidateSeason) score -= 16;

      const animePart = browserPartNumber([anime.title.native, anime.title.romaji, anime.title.english].filter(Boolean).join(' '));
      const candidatePart = browserPartNumber(`${String(candidate.name || '')} ${String(candidate.name_cn || '')}`);
      if (animePart && candidatePart) score += animePart === candidatePart ? 16 : -24;
      else if (animePart && !candidatePart) score -= 16;

      const candidateStages = browserStageNumbers(String(candidate.name || ''));
      if (animeStages.length && candidateStages.length) {
        score += browserSameNumberSet(animeStages, candidateStages) ? 18 : animeStages.some((number) => candidateStages.includes(number)) ? 4 : -24;
      }

      const candidateYear = Number(String(candidate.date || '').slice(0, 4));
      const candidateDate = String(candidate.date || '').slice(0, 10);
      if (animeDate && /^\d{4}-\d{2}-\d{2}$/.test(candidateDate) && animeDate === candidateDate) score += 32;
      else if (year && candidateYear) {
        const difference = Math.abs(year - candidateYear);
        const candidateMonth = Number(candidateDate.slice(5, 7));
        if (difference === 0 && anime.startDate?.month && anime.startDate.month === candidateMonth) score += 14;
        else if (difference === 0) score += 8;
        else if (difference === 1) score += 3;
        else if (difference >= 3) score -= 18;
      }
      const platform = String(candidate.platform).toUpperCase();
      if (anime.format === 'TV' && platform === 'TV') score += 7;
      if (anime.format === 'MOVIE' && /MOVIE|剧场|劇場/.test(platform)) score += 7;
      if (['ONA', 'TV_SHORT'].includes(String(anime.format)) && /WEB|ONA/.test(platform)) score += 5;
      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const base = { animeId: anime.id, checkedAt: Math.floor(Date.now() / 1000), resolverVersion: BANGUMI_RESOLVER_VERSION };
  if (!best || best.score < 68) return { ...base, status: 'unmatched', confidence: best?.score || 0 };
  if (ranked[1] && best.score - ranked[1].score < 8) {
    const nearBest = ranked.filter((entry) => best.score - entry.score < 8);
    const commonName = browserCommonPrefix(nearBest.map((entry) => String(entry.candidate.name_cn).trim()));
    if (commonName) {
      return {
        ...base,
        status: 'matched',
        subjectIds: nearBest.map((entry) => entry.candidate.id as number),
        name: anime.title.native || String(best.candidate.name),
        nameCn: commonName,
        confidence: best.score,
        source: 'api-aggregate',
      };
    }
    return { ...base, status: 'ambiguous', confidence: best.score };
  }
  return {
    ...base,
    status: 'matched',
    subjectId: best.candidate.id as number,
    name: best.candidate.name as string,
    nameCn: String(best.candidate.name_cn).trim(),
    confidence: best.score,
    source: 'api-title',
  };
}

async function fetchBrowserBangumiTitle(anime: Anime): Promise<BangumiTitleMatch> {
  const base = { animeId: anime.id, checkedAt: Math.floor(Date.now() / 1000), resolverVersion: BANGUMI_RESOLVER_VERSION };
  if (Date.now() < browserBangumiUnavailableUntil) return { ...base, status: 'unavailable' };
  const keywords = browserBangumiSearchKeywords(anime);
  if (keywords.length === 0) return { ...base, status: 'unmatched' };
  try {
    let receivedResponse = false;
    let lastError: unknown;
    const candidates = new Map<number, Record<string, unknown>>();
    let match: BangumiTitleMatch = { ...base, status: 'unmatched' };
    for (let index = 0; index < keywords.length; index += 1) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, 450));
      let payload: { data?: Array<Record<string, unknown>> } | null = null;
      for (const endpoint of browserBangumiEndpoints()) {
        try {
          const response = await requestBrowserBangumi(endpoint, keywords[index], 12);
          if (!response.ok) throw new Error(String(response.status));
          payload = await response.json();
          receivedResponse = true;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      (payload?.data || []).forEach((candidate) => candidates.set(Number(candidate.id), candidate));
      match = matchBrowserCandidates(anime, [...candidates.values()]);
      if (match.status === 'matched') break;
    }
    if (!receivedResponse) throw lastError || new Error('Bangumi API unavailable');
    browserState.bangumiTitles[String(anime.id)] = match;
    if (match.status === 'matched' && match.nameCn) {
      const followed = browserState.following.find((item) => item.id === anime.id);
      if (followed && followed.titleSource !== 'custom') {
        followed.displayTitle = match.nameCn;
        followed.titleSource = 'bangumi';
        followed.bangumiId = match.subjectId;
        browserState.tasks.forEach((task) => {
          if (task.animeId === anime.id) task.animeTitle = match.nameCn!;
        });
      }
    }
    saveBrowserState();
    return match;
  } catch {
    browserBangumiUnavailableUntil = Date.now() + 10 * 60_000;
    return { ...base, status: 'unavailable' };
  }
}

function resolveBrowserBangumiTitle(anime: Anime): Promise<BangumiTitleMatch> {
  const cached = browserState.bangumiTitles[String(anime.id)];
  if (cached) {
    const { year, month, day } = anime.startDate || {};
    const premiere = year ? Date.UTC(year, (month || 12) - 1, day || 1) : 0;
    const maxAge = cached.status === 'matched' ? 180 * 86400 : premiere > Date.now() ? 86400 : 7 * 86400;
    if (Math.floor(Date.now() / 1000) - cached.checkedAt < maxAge) return Promise.resolve(cached);
  }
  const existing = browserBangumiPending.get(anime.id);
  if (existing) return existing;
  const lookup = browserBangumiChain.then(() => fetchBrowserBangumiTitle(anime)) as Promise<BangumiTitleMatch>;
  browserBangumiChain = lookup.then(() => new Promise((resolve) => setTimeout(resolve, 450)));
  browserBangumiPending.set(anime.id, lookup);
  void lookup.finally(() => browserBangumiPending.delete(anime.id));
  return lookup;
}

const browserApi: DesktopApi = {
  async getState() { return browserState; },
  fetchSeason: browserFetchSeason,
  async toggleFollow(anime) {
    const existing = browserState.following.findIndex((item) => item.id === anime.id);
    if (existing >= 0) {
      browserState.following.splice(existing, 1);
      browserState.tasks = removePendingTasksForAnime(browserState.tasks, anime.id);
    }
    else {
      const bangumiMatch = IS_ORIGINAL_EDITION ? undefined : browserState.bangumiTitles[String(anime.id)];
      const hasChineseTitle = !IS_ORIGINAL_EDITION && bangumiMatch?.status === 'matched' && bangumiMatch.nameCn;
      browserState.following.push({
      id: anime.id,
      title: anime.title,
      displayTitle: hasChineseTitle ? bangumiMatch.nameCn! : IS_ORIGINAL_EDITION ? titleForPreference(anime.title, browserState.settings.titlePreference) : reminderTitleOf(anime.title),
      titleSource: hasChineseTitle ? 'bangumi' : 'anilist',
      bangumiId: hasChineseTitle ? bangumiMatch.subjectId : null,
      coverImage: anime.coverImage?.medium || anime.coverImage?.extraLarge || '',
      format: anime.format,
      episodes: anime.episodes,
      nextAiringEpisode: anime.nextAiringEpisode,
      siteUrl: anime.siteUrl,
      followedAt: Math.floor(Date.now() / 1000),
      });
    }
    saveBrowserState();
    return browserState;
  },
  async updateFollowTitle(animeId, displayTitle) {
    const followed = browserState.following.find((item) => item.id === animeId);
    const nextTitle = displayTitle.trim();
    if (followed && nextTitle) {
      followed.displayTitle = nextTitle;
      followed.titleSource = 'custom';
      browserState.tasks.forEach((task) => {
        if (task.animeId === animeId) task.animeTitle = nextTitle;
      });
      saveBrowserState();
    }
    return browserState;
  },
  ...(!IS_ORIGINAL_EDITION ? {
    resolveBangumiTitle: resolveBrowserBangumiTitle,
    async testBangumiConnection(requestedBaseUrl: string) {
    let baseUrl: string;
    try {
      baseUrl = normalizeBangumiApiBaseUrl(requestedBaseUrl) || 'https://api.bgm.tv/v0';
      const response = await requestBrowserBangumi(baseUrl, 'CLANNAD', 1);
      if (!response.ok) return { ok: false, message: `连接失败（HTTP ${response.status}）`, baseUrl };
      const payload = await response.json();
      const ok = Array.isArray(payload.data);
      return { ok, message: ok ? '连接成功' : '返回的数据格式不正确', baseUrl };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? `连接失败：${error.message}` : '连接失败', baseUrl: requestedBaseUrl };
    }
    },
  } : {}),
  async toggleTask(taskId) {
    const task = browserState.tasks.find((item) => item.id === taskId);
    if (task) {
      task.status = task.status === 'completed' ? 'pending' : 'completed';
      task.completedAt = task.status === 'completed' ? Math.floor(Date.now() / 1000) : null;
      saveBrowserState();
    }
    return browserState;
  },
  async updateSettings(settings: Partial<Settings>) {
    if (!IS_ORIGINAL_EDITION && typeof settings.bangumiApiBaseUrl === 'string') {
      settings = { ...settings, bangumiApiBaseUrl: normalizeBangumiApiBaseUrl(settings.bangumiApiBaseUrl) };
      browserBangumiUnavailableUntil = 0;
    } else if (IS_ORIGINAL_EDITION && Object.prototype.hasOwnProperty.call(settings, 'bangumiApiBaseUrl')) {
      const { bangumiApiBaseUrl: _ignored, ...safeSettings } = settings;
      settings = safeSettings;
    }
    if (typeof settings.titlePreference === 'string') {
      settings = { ...settings, titlePreference: normalizeTitlePreference(settings.titlePreference) };
    }
    browserState.settings = { ...browserState.settings, ...settings };
    if (IS_ORIGINAL_EDITION && Object.prototype.hasOwnProperty.call(settings, 'titlePreference')) {
      browserState.following.forEach((item) => {
        if (item.titleSource !== 'custom') item.displayTitle = titleForPreference(item.title, browserState.settings.titlePreference);
      });
      const followedById = new Map(browserState.following.map((item) => [item.id, item]));
      browserState.tasks.forEach((task) => {
        const followed = followedById.get(task.animeId);
        if (followed) task.animeTitle = followed.displayTitle;
      });
    }
    saveBrowserState();
    return browserState;
  },
  async syncNow() {
    browserState.lastSyncAt = Math.floor(Date.now() / 1000);
    saveBrowserState();
    return { created: 0, syncedAt: browserState.lastSyncAt };
  },
  async getCacheInfo() { return { bytes: 0, sessionBytes: 0, legacyBytes: 0, supported: false }; },
  async clearCache() { return { bytes: 0, sessionBytes: 0, legacyBytes: 0, supported: false }; },
  async openExternal(url) { window.open(url, '_blank', 'noopener,noreferrer'); },
  onStateChanged(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
  onSeasonUpdated(callback) {
    seasonListeners.add(callback);
    return () => seasonListeners.delete(callback);
  },
};

export const api: DesktopApi = window.animeTracker || browserApi;
