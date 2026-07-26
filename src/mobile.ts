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

interface AniLogMobilePlugin {
  configure(options: { following: MobileFollowSchedule[]; notificationsEnabled: boolean; createTasksEnabled: boolean }): Promise<MobileStatus>;
  consumeEvents(): Promise<MobileStatus>;
  syncNow(): Promise<MobileStatus>;
  requestNotificationPermission(): Promise<{ granted: boolean }>;
  requestExactScheduling(): Promise<{ granted: boolean; exactSchedulingGranted: boolean }>;
}

export const IS_ANDROID_APP = import.meta.env.VITE_ANILOG_PLATFORM === 'android' && Capacitor.getPlatform() === 'android';
export const mobilePlugin = registerPlugin<AniLogMobilePlugin>('AniLogMobile');
