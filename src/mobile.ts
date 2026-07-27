import { Capacitor, registerPlugin } from '@capacitor/core';

export interface MobileFollowSchedule {
  id: number;
  displayTitle: string;
  coverImage: string;
  nextEpisode?: number;
  nextAiringAt?: number;
}

export interface MobileAiredEvent {
  id: string;
  animeId: number;
  animeTitle: string;
  coverImage?: string;
  episode: number;
  airingAt: number;
  createdAt: number;
}

export interface MobileStatus {
  granted: boolean;
  syncedAt: number;
  exactSchedulingGranted: boolean;
  openTasks?: boolean;
  updated?: number;
  events: MobileAiredEvent[];
  following: MobileFollowSchedule[];
}

export interface NativeWebDavConfig {
  supported: boolean;
  enabled: boolean;
  baseUrl: string;
  username: string;
  hasPassword: boolean;
  lastSyncAt: number;
  lastError: string;
}

interface AniLogMobilePlugin {
  configure(options: { following: MobileFollowSchedule[]; notificationsEnabled: boolean; createTasksEnabled: boolean; uiLanguage: string }): Promise<MobileStatus>;
  consumeEvents(): Promise<MobileStatus>;
  syncNow(): Promise<MobileStatus>;
  requestNotificationPermission(): Promise<{ granted: boolean }>;
  requestExactScheduling(): Promise<{ granted: boolean; exactSchedulingGranted: boolean }>;
  getWebDavConfig(): Promise<NativeWebDavConfig>;
  saveWebDavConfig(options: { enabled: boolean; baseUrl: string; username: string; password?: string }): Promise<NativeWebDavConfig>;
  testWebDavConnection(): Promise<{ ok: boolean; message: string }>;
  webDavDownload(): Promise<{ found: boolean; etag: string; body: string }>;
  webDavUpload(options: { body: string; remoteFound: boolean; etag: string }): Promise<{ ok: boolean; conflict: boolean }>;
  finishWebDavSync(options: { error?: string }): Promise<NativeWebDavConfig>;
}

export const IS_ANDROID_APP = import.meta.env.VITE_ANILOG_PLATFORM === 'android' && Capacitor.getPlatform() === 'android';
export const mobilePlugin = registerPlugin<AniLogMobilePlugin>('AniLogMobile');
