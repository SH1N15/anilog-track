import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  Anime,
  AppState,
  BangumiTitleMatch,
  CacheInfo,
  ConnectionTestResult,
  DesktopApi,
  Season,
  Settings,
  WebDavConfig,
  WebDavSyncResult,
} from '../types';

export const IS_TAURI_APP = import.meta.env.VITE_ANILOG_PLATFORM === 'tauri' && isTauri();

function subscribe<T>(event: string, callback: (payload: T) => void): () => void {
  let active = true;
  let unlisten: UnlistenFn | undefined;
  void listen<T>(event, ({ payload }) => {
    if (active) callback(payload);
  }).then((dispose) => {
    if (active) unlisten = dispose;
    else dispose();
  });
  return () => {
    active = false;
    unlisten?.();
  };
}

export const tauriApi: DesktopApi = {
  getState: () => invoke<AppState>('get_state'),
  fetchSeason: (params: { season: Season; year: number }) => invoke<Anime[]>('fetch_season', { params }),
  toggleFollow: (anime: Anime) => invoke<AppState>('toggle_follow', { anime }),
  updateFollowTitle: (animeId: number, displayTitle: string) => invoke<AppState>('update_follow_title', { animeId, displayTitle }),
  resolveBangumiTitle: (anime: Anime) => invoke<BangumiTitleMatch>('resolve_bangumi_title', { anime }),
  testBangumiConnection: (baseUrl: string) => invoke<ConnectionTestResult>('test_bangumi_connection', { baseUrl }),
  toggleTask: (taskId: string) => invoke<AppState>('toggle_task', { taskId }),
  updateSettings: (settings: Partial<Settings>) => invoke<AppState>('update_settings', { settings }),
  syncNow: () => invoke<{ created: number; syncedAt: number }>('sync_now'),
  getCacheInfo: () => invoke<CacheInfo>('get_cache_info'),
  clearCache: () => invoke<CacheInfo>('clear_cache'),
  getWebDavConfig: () => invoke<WebDavConfig>('get_webdav_config'),
  saveWebDavConfig: (config) => invoke<WebDavConfig>('save_webdav_config', { config }),
  testWebDavConnection: () => invoke<{ ok: boolean; message: string }>('test_webdav_connection'),
  syncWebDav: () => invoke<WebDavSyncResult>('sync_webdav'),
  requestExactScheduling: () => invoke<void>('request_exact_scheduling'),
  openExternal: (url: string) => invoke<void>('open_external', { url }),
  onStateChanged: (callback) => subscribe<AppState>('state-changed', callback),
  onSeasonUpdated: (callback) => subscribe<{ season: Season; year: number; anime: Anime[]; fetchedAt: number }>('season-updated', callback),
  onOpenTasks: (callback) => subscribe<void>('open-tasks', callback),
};
