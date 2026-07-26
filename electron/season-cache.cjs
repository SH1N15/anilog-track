const fs = require('node:fs');
const path = require('node:path');

const CACHE_VERSION = 1;
const ACTIVE_TTL_MS = 6 * 60 * 60 * 1000;
const PAST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const SEASON_START_MONTH = { WINTER: 0, SPRING: 3, SUMMER: 6, FALL: 9 };

function cacheKey({ season, year }) {
  return `${year}-${season}`;
}

function seasonCacheTtl({ season, year }, now = Date.now()) {
  const startMonth = SEASON_START_MONTH[season];
  if (!Number.isInteger(year) || startMonth === undefined) throw new Error('无效的季度缓存参数');
  const endYear = season === 'FALL' ? year + 1 : year;
  const endMonth = season === 'FALL' ? 0 : startMonth + 3;
  return now >= Date.UTC(endYear, endMonth, 1) ? PAST_TTL_MS : ACTIVE_TTL_MS;
}

function createSeasonCache({ directory, fetchSeason, onUpdated = () => {}, now = () => Date.now(), maxConcurrent = 1 }) {
  const memory = new Map();
  const loaded = new Set();
  const pending = new Map();
  const failures = new Map();
  const queue = [];
  let active = 0;

  function schedule(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pump();
    });
  }

  function pump() {
    while (active < Math.max(1, maxConcurrent) && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }

  function cacheFile(params) {
    return path.join(directory, `${cacheKey(params)}.json`);
  }

  function read(params) {
    const key = cacheKey(params);
    if (loaded.has(key)) return memory.get(key) || null;
    loaded.add(key);
    try {
      const parsed = JSON.parse(fs.readFileSync(cacheFile(params), 'utf8'));
      if (parsed.version !== CACHE_VERSION || parsed.season !== params.season || parsed.year !== params.year || !Number.isFinite(parsed.fetchedAt) || !Array.isArray(parsed.anime)) {
        return null;
      }
      memory.set(key, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  function write(params, anime) {
    const entry = { version: CACHE_VERSION, season: params.season, year: params.year, fetchedAt: now(), anime };
    const target = cacheFile(params);
    const temporary = `${target}.tmp`;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(entry));
    fs.renameSync(temporary, target);
    memory.set(cacheKey(params), entry);
    loaded.add(cacheKey(params));
    return entry;
  }

  function refresh(params) {
    const key = cacheKey(params);
    if (pending.has(key)) return pending.get(key);
    const failedAt = failures.get(key) || 0;
    if (now() - failedAt < FAILURE_BACKOFF_MS) {
      return Promise.reject(new Error('AniList 刷新暂时退避中，请稍后再试'));
    }

    const request = schedule(() => fetchSeason(params))
      .then((anime) => {
        if (!Array.isArray(anime)) throw new Error('AniList 返回了无效的季度数据');
        failures.delete(key);
        const entry = write(params, anime);
        onUpdated({ season: params.season, year: params.year, anime: entry.anime, fetchedAt: entry.fetchedAt });
        return entry.anime;
      })
      .catch((error) => {
        failures.set(key, now());
        throw error;
      })
      .finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  }

  async function get(params) {
    const entry = read(params);
    if (!entry) return refresh(params);
    if (now() - entry.fetchedAt < seasonCacheTtl(params, now())) return entry.anime;
    void refresh(params).catch((error) => console.warn(`Season refresh failed (${cacheKey(params)}):`, error.message));
    return entry.anime;
  }

  return { get, read, refresh };
}

module.exports = {
  ACTIVE_TTL_MS,
  FAILURE_BACKOFF_MS,
  PAST_TTL_MS,
  createSeasonCache,
  seasonCacheTtl,
};
