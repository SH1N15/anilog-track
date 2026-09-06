import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  Anime,
  AppState,
  BangumiAuthStatus,
  BangumiCollectionItem,
  BangumiConnectionTestResult,
  BangumiMappingResolution,
  BangumiSubjectExtras,
  BangumiTitleMatch,
  BangumiUserProfile,
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
  bangumiAuthStatus: () => invoke<BangumiAuthStatus>('bangumi_auth_status'),
  bangumiSaveToken: (params: { token: string }) => invoke<{ ok: boolean; message: string }>('bangumi_save_token', { token: params.token }),
  bangumiDisconnect: () => invoke<{ ok: boolean; message: string }>('bangumi_disconnect'),
  bangumiTestConnection: (params: { baseUrl?: string | null }) => invoke<BangumiConnectionTestResult>('bangumi_test_connection', { baseUrl: params.baseUrl }),
  bangumiGetUserProfile: () => invoke<BangumiUserProfile | null>('bangumi_get_user_profile'),
  bangumiGetUserCollections: (params: { offset?: number; limit?: number }) => invoke<{ total: number; items: BangumiCollectionItem[] }>('bangumi_get_user_collections', { offset: params.offset, limit: params.limit }),
  bangumiResolveMapping: (params: { animeId: number }) => invoke<BangumiMappingResolution>('bangumi_resolve_mapping', { animeId: params.animeId }),
  bangumiConfirmMapping: (params: { animeId: number; subjectId: number }) => invoke<AppState>('bangumi_confirm_mapping', { animeId: params.animeId, subjectId: params.subjectId }),
  bangumiSkipMapping: (params: { animeId: number }) => invoke<AppState>('bangumi_skip_mapping', { animeId: params.animeId }),
  bangumiGetSubjectExtras: (params: { subjectId: number }) => invoke<BangumiSubjectExtras | null>('bangumi_get_subject_extras', { subjectId: params.subjectId }),
  openExternal: (url: string) => invoke<void>('open_external', { url }),
  onStateChanged: (callback) => subscribe<AppState>('state-changed', callback),
  onSeasonUpdated: (callback) => subscribe<{ season: Season; year: number; anime: Anime[]; fetchedAt: number }>('season-updated', callback),
  onOpenTasks: (callback) => subscribe<void>('open-tasks', callback),
};
