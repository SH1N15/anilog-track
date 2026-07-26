import type { AnimeTitle, TitlePreference } from './types';

export type AppEdition = 'standard' | 'original';

export const APP_EDITION: AppEdition = import.meta.env.VITE_ANILOG_EDITION === 'original' ? 'original' : 'standard';
export const IS_ORIGINAL_EDITION = APP_EDITION === 'original';
export const PRODUCT_NAME = IS_ORIGINAL_EDITION ? 'AniLog 原名版' : 'AniLog';

export function normalizeTitlePreference(value?: string): TitlePreference {
  return value === 'english' || value === 'romaji' || value === 'native' ? value : 'auto';
}

export function titleForPreference(title?: AnimeTitle | null, preference: TitlePreference = 'auto'): string {
  const orders: Record<TitlePreference, Array<keyof AnimeTitle>> = {
    auto: ['english', 'romaji', 'native'],
    english: ['english', 'romaji', 'native'],
    romaji: ['romaji', 'english', 'native'],
    native: ['native', 'romaji', 'english'],
  };
  return orders[normalizeTitlePreference(preference)]
    .map((key) => title?.[key])
    .find(Boolean) || '未命名番剧';
}
