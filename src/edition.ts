import type { AnimeTitle, TitlePreference, UiLanguage } from './types';

export type AppEdition = 'standard' | 'original';

export const APP_EDITION: AppEdition = import.meta.env.VITE_ANILOG_EDITION === 'original' ? 'original' : 'standard';
export const IS_ORIGINAL_EDITION = APP_EDITION === 'original';
export const PRODUCT_NAME = IS_ORIGINAL_EDITION ? 'AniLog Original' : 'AniLog';

export function productName(language: UiLanguage): string {
  return IS_ORIGINAL_EDITION && language === 'zh-CN' ? 'AniLog 原名版' : PRODUCT_NAME;
}

export function normalizeTitlePreference(value?: string): TitlePreference {
  return value === 'english' || value === 'romaji' || value === 'native' ? value : 'auto';
}

export function titleForPreference(title?: AnimeTitle | null, preference: TitlePreference = 'auto', language: UiLanguage = 'zh-CN'): string {
  const orders: Record<TitlePreference, Array<keyof AnimeTitle>> = {
    auto: ['english', 'romaji', 'native'],
    english: ['english', 'romaji', 'native'],
    romaji: ['romaji', 'english', 'native'],
    native: ['native', 'romaji', 'english'],
  };
  return orders[normalizeTitlePreference(preference)]
    .map((key) => title?.[key])
    .find(Boolean) || (language === 'en-US' ? 'Untitled anime' : '未命名番剧');
}
