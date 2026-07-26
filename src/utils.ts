import type { AnimeTitle, Season } from './types';

export const SEASONS: Array<{ value: Season; label: string; months: string }> = [
  { value: 'WINTER', label: '冬', months: '1–3 月' },
  { value: 'SPRING', label: '春', months: '4–6 月' },
  { value: 'SUMMER', label: '夏', months: '7–9 月' },
  { value: 'FALL', label: '秋', months: '10–12 月' },
];

export function currentSeason(date = new Date()): { season: Season; year: number } {
  const month = date.getMonth() + 1;
  const season: Season = month <= 3 ? 'WINTER' : month <= 6 ? 'SPRING' : month <= 9 ? 'SUMMER' : 'FALL';
  return { season, year: date.getFullYear() };
}

export function titleOf(title?: AnimeTitle | null): string {
  return title?.native || title?.english || title?.romaji || '未命名番剧';
}

export function reminderTitleOf(title?: AnimeTitle | null): string {
  return title?.english || title?.romaji || title?.native || '未命名番剧';
}

export function secondaryTitle(title?: AnimeTitle | null): string {
  const primary = titleOf(title);
  return [title?.english, title?.romaji].find((value) => value && value !== primary) || '';
}

export function formatLabel(format?: string | null): string {
  const labels: Record<string, string> = {
    TV: 'TV',
    TV_SHORT: '短篇',
    MOVIE: '电影',
    SPECIAL: '特别篇',
    OVA: 'OVA',
    ONA: '网络动画',
    MUSIC: '音乐',
  };
  return format ? labels[format] || format : '待定';
}

export function seasonLabel(season: Season, year: number): string {
  return `${year} ${SEASONS.find((item) => item.value === season)?.label || ''}季`;
}

export function formatAiring(timestamp?: number | null, includeDate = true): string {
  if (!timestamp) return '播出时间待定';
  return new Intl.DateTimeFormat('zh-CN', {
    ...(includeDate ? { month: 'numeric', day: 'numeric', weekday: 'short' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestamp * 1000));
}

export function relativeTime(timestamp?: number | null): string {
  if (!timestamp) return '尚未公布';
  const seconds = timestamp - Math.floor(Date.now() / 1000);
  if (seconds <= 0) return '已播出';
  const days = Math.floor(seconds / 86400);
  if (days > 0) return `${days} 天后`;
  const hours = Math.floor(seconds / 3600);
  if (hours > 0) return `${hours} 小时后`;
  return `${Math.max(1, Math.floor(seconds / 60))} 分钟后`;
}

export function stripDescription(value?: string | null): string {
  if (!value) return '暂无简介';
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
