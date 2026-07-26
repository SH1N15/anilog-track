export type Season = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';
export type ViewId = 'season' | 'tasks' | 'following' | 'settings';
export type TitlePreference = 'auto' | 'english' | 'romaji' | 'native';

export interface AnimeTitle {
  native?: string | null;
  romaji?: string | null;
  english?: string | null;
}

export interface Anime {
  id: number;
  title: AnimeTitle;
  coverImage?: { extraLarge?: string; medium?: string; color?: string | null };
  bannerImage?: string | null;
  description?: string | null;
  format?: string | null;
  episodes?: number | null;
  duration?: number | null;
  status?: string | null;
  season?: Season | null;
  seasonYear?: number | null;
  startDate?: { year?: number; month?: number; day?: number };
  studios?: { nodes: Array<{ name: string }> };
  genres?: string[];
  averageScore?: number | null;
  popularity?: number;
  nextAiringEpisode?: AiringEpisode | null;
  airingSchedule?: { nodes: AiringEpisode[] };
  siteUrl?: string;
}

export interface AiringEpisode {
  episode: number;
  airingAt: number;
  timeUntilAiring?: number;
}

export interface FollowedAnime {
  id: number;
  title: AnimeTitle;
  displayTitle: string;
  titleSource?: 'anilist' | 'bangumi' | 'custom';
  bangumiId?: number | null;
  coverImage: string;
  format?: string | null;
  episodes?: number | null;
  nextAiringEpisode?: AiringEpisode | null;
  siteUrl?: string;
  followedAt: number;
}

export interface WatchTask {
  id: string;
  animeId: number;
  animeTitle: string;
  coverImage?: string;
  episode: number;
  airingAt: number;
  status: 'pending' | 'completed';
  createdAt: number;
  completedAt: number | null;
}

export interface Settings {
  pollIntervalMinutes: number;
  launchAtLogin: boolean;
  minimizeToTray: boolean;
  notifyWhenAired: boolean;
  bangumiApiBaseUrl: string;
  titlePreference: TitlePreference;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  baseUrl: string;
}

export interface CacheInfo {
  bytes: number;
  sessionBytes: number;
  legacyBytes: number;
  supported: boolean;
}

export interface BangumiCandidate {
  subjectId: number;
  name: string;
  nameCn: string;
  date?: string | null;
  platform?: string | null;
  score: number;
}

export interface BangumiTitleMatch {
  animeId: number;
  status: 'matched' | 'unmatched' | 'ambiguous' | 'unavailable';
  subjectId?: number;
  subjectIds?: number[];
  name?: string;
  nameCn?: string;
  confidence?: number;
  source?: string;
  resolverVersion?: number;
  checkedAt: number;
  candidates?: BangumiCandidate[];
}

export interface AppState {
  version: number;
  following: FollowedAnime[];
  tasks: WatchTask[];
  settings: Settings;
  bangumiTitles: Record<string, BangumiTitleMatch>;
  lastSyncAt: number;
  runtime?: {
    isDesktop: boolean;
    notificationsSupported: boolean;
    platform: string;
    edition: 'standard' | 'original';
  };
}

export interface DesktopApi {
  getState(): Promise<AppState>;
  fetchSeason(params: { season: Season; year: number }): Promise<Anime[]>;
  toggleFollow(anime: Anime): Promise<AppState>;
  updateFollowTitle(animeId: number, displayTitle: string): Promise<AppState>;
  resolveBangumiTitle?(anime: Anime): Promise<BangumiTitleMatch>;
  testBangumiConnection?(baseUrl: string): Promise<ConnectionTestResult>;
  toggleTask(taskId: string): Promise<AppState>;
  updateSettings(settings: Partial<Settings>): Promise<AppState>;
  syncNow(): Promise<{ created: number; syncedAt: number }>;
  getCacheInfo(): Promise<CacheInfo>;
  clearCache(): Promise<CacheInfo>;
  openExternal(url: string): Promise<void>;
  onStateChanged(callback: (state: AppState) => void): () => void;
  onSeasonUpdated(callback: (update: { season: Season; year: number; anime: Anime[]; fetchedAt: number }) => void): () => void;
}

declare global {
  interface Window {
    animeTracker?: DesktopApi;
  }
}
