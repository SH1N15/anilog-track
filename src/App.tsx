import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  BellRing,
  CalendarDays,
  CalendarRange,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock3,
  Cloud,
  ExternalLink,
  Filter,
  HardDrive,
  Inbox,
  Languages,
  LayoutGrid,
  ListChecks,
  LoaderCircle,
  Minus,
  MonitorDot,
  Network,
  RefreshCw,
  Save,
  Pencil,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { api } from './api';
import type { Anime, AppState, BangumiAuthStatus, BangumiTitleMatch, BangumiUserProfile, Season, SeasonViewMode, Settings as AppSettings, UiLanguage, ViewId, WatchTask, WebDavConfig } from './types';
import { IS_ORIGINAL_EDITION, productName, titleForPreference } from './edition';
import { localizeMessage, normalizeUiLanguage, tr } from './i18n';
import { createStateRefreshController } from './state-refresh';
import { IS_TAURI_APP } from './platform/tauri';
import {
  currentSeason,
  formatAiring,
  formatLabel,
  localAiringWeekday,
  relativeTime,
  reminderTitleOf,
  SEASONS,
  seasonLabel,
  seasonMonths,
  seasonName,
  secondaryTitle,
  stripDescription,
  titleOf,
} from './utils';

const EMPTY_STATE: AppState = {
  version: 2,
  following: [],
  tasks: [],
  bangumiTitles: {},
  settings: { uiLanguage: 'zh-CN', pollIntervalMinutes: 5, launchAtLogin: false, minimizeToTray: true, showTrayIcon: true, notifyWhenAired: true, createWatchTasks: true, dailyTaskReminderEnabled: false, dailyTaskReminderTime: '20:00', bangumiApiBaseUrl: IS_ORIGINAL_EDITION ? '' : 'https://sh1n.cc.cd/v0', titlePreference: 'auto' },
  lastSyncAt: 0,
  syncMetadata: { followingDeletedAt: {} },
};

const NAV_ITEMS: Array<{ id: ViewId; label: [string, string]; icon: typeof CalendarDays }> = [
  { id: 'season', label: ['季度新番', 'Seasonal Anime'], icon: CalendarDays },
  { id: 'tasks', label: ['观看任务', 'Watch Tasks'], icon: ListChecks },
  { id: 'following', label: ['我的追番', 'Following'], icon: Bell },
  { id: 'settings', label: ['偏好设置', 'Settings'], icon: Settings },
];

const UI_STATE_KEY = IS_ORIGINAL_EDITION ? 'anilog-original-ui-state' : 'anilog-ui-state';

function loadUiState(fallback: { season: Season; year: number }): { view: ViewId; season: Season; year: number; seasonView: SeasonViewMode } {
  try {
    const saved = JSON.parse(localStorage.getItem(UI_STATE_KEY) || '{}');
    const views: ViewId[] = ['season', 'tasks', 'following', 'settings'];
    return {
      view: views.includes(saved.view) ? saved.view : 'season',
      season: SEASONS.some((item) => item.value === saved.season) ? saved.season : fallback.season,
      year: Number.isInteger(saved.year) && saved.year >= 2000 && saved.year <= 2100 ? saved.year : fallback.year,
      seasonView: saved.seasonView === 'all' ? 'all' : 'weekday',
    };
  } catch {
    return { view: 'season', ...fallback, seasonView: 'weekday' };
  }
}

function App() {
  const nowSeason = currentSeason();
  const initialUi = useMemo(() => loadUiState(nowSeason), [nowSeason.season, nowSeason.year]);
  const [view, setView] = useState<ViewId>(initialUi.view);
  const [state, setState] = useState<AppState>(EMPTY_STATE);
  const [season, setSeason] = useState<Season>(initialUi.season);
  const [year, setYear] = useState(initialUi.year);
  const [seasonView, setSeasonView] = useState<SeasonViewMode>(initialUi.seasonView);
  const [anime, setAnime] = useState<Anime[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [lastSyncMessage, setLastSyncMessage] = useState('');
  const seasonRequest = useRef(0);
  const language = normalizeUiLanguage(state.settings.uiLanguage);
  const t = (chinese: string, english: string) => tr(language, chinese, english);
  const navItems = NAV_ITEMS.map((item) => ({ ...item, text: t(...item.label) }));

  useEffect(() => {
    document.title = productName(language);
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    const openTasks = () => setView('tasks');
    window.addEventListener('anilog:open-tasks', openTasks);
    const unsubscribeDesktop = api.onOpenTasks?.(openTasks);
    return () => {
      window.removeEventListener('anilog:open-tasks', openTasks);
      unsubscribeDesktop?.();
    };
  }, []);

  useEffect(() => {
    const controller = createStateRefreshController({
      getState: api.getState,
      subscribe: api.onStateChanged,
      applyState: setState,
      onError: (reason) => {
        setError(reason instanceof Error ? localizeMessage(reason.message, language) : t('无法读取本地状态', 'Could not read local data'));
      },
    });

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void controller.refresh();
    };
    const refreshWhenFocused = () => { void controller.refresh(); };

    void controller.refresh(true);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('focus', refreshWhenFocused);
    return () => {
      controller.dispose();
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.removeEventListener('focus', refreshWhenFocused);
    };
  }, [language]);

  useEffect(() => {
    localStorage.setItem(UI_STATE_KEY, JSON.stringify({ view, season, year, seasonView }));
  }, [view, season, year, seasonView]);

  const loadSeason = useCallback(async () => {
    const requestId = ++seasonRequest.current;
    setLoading(true);
    setError('');
    try {
      const nextAnime = await api.fetchSeason({ season, year });
      if (requestId === seasonRequest.current) setAnime(nextAnime);
    } catch (reason) {
      if (requestId === seasonRequest.current) setError(reason instanceof Error ? localizeMessage(reason.message, language) : t('无法读取本季番剧', 'Could not load this season'));
    } finally {
      if (requestId === seasonRequest.current) setLoading(false);
    }
  }, [season, year, language]);

  useEffect(() => {
    void loadSeason();
  }, [loadSeason]);

  useEffect(() => api.onSeasonUpdated((update) => {
    if (update.season === season && update.year === year) {
      setAnime(update.anime);
      setError('');
      setLoading(false);
    }
  }), [season, year]);

  const syncNow = async () => {
    setSyncing(true);
    setLastSyncMessage('');
    try {
      const result = await api.syncNow();
      setState(await api.getState());
      setLastSyncMessage(result.created ? t(`新增 ${result.created} 个观看任务`, `${result.created} watch task${result.created === 1 ? '' : 's'} added`) : t('已是最新状态', 'Already up to date'));
    } catch (reason) {
      setLastSyncMessage(reason instanceof Error ? localizeMessage(reason.message, language) : t('同步失败', 'Sync failed'));
    } finally {
      setSyncing(false);
    }
  };

  const pendingCount = state.tasks.filter((task) => task.status === 'pending').length;
  const isAndroid = state.runtime?.platform === 'android';

  return (
    <div className={`app-shell ${isAndroid ? 'android-app' : ''}`}>
      <aside className="sidebar">
        <button className="brand" onClick={() => setView('season')} aria-label={t('返回季度新番', 'Back to seasonal anime')}>
          <span className="brand-mark">A</span>
          <span>
            <strong>AniLog</strong>
            <small>追番日程</small>
          </span>
        </button>

        <nav className="main-nav" aria-label={t('主导航', 'Main navigation')}>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={view === item.id ? 'active' : ''}
                onClick={() => setView(item.id)}
                aria-label={item.text}
                title={item.text}
              >
                <Icon size={19} strokeWidth={1.8} />
                <span>{item.text}</span>
                {item.id === 'tasks' && pendingCount > 0 && <span className="nav-count">{pendingCount}</span>}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-status">
          <span className={`status-dot ${state.runtime?.isDesktop || isAndroid ? 'online' : ''}`} />
          <div>
            <strong>{state.runtime?.isDesktop ? t('后台提醒已就绪', 'Background alerts ready') : isAndroid ? t('Android 后台同步已就绪', 'Android background sync ready') : t('浏览器预览模式', 'Browser preview mode')}</strong>
            <small>{t(`${state.following.length} 部追番 · ${pendingCount} 项待看`, `${state.following.length} following · ${pendingCount} to watch`)}</small>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <p>{view === 'season' ? t('发现与安排', 'Discover and plan') : view === 'tasks' ? t('本地观看清单', 'Local watch list') : view === 'following' ? t('追番管理', 'Manage following') : t('应用设置', 'App preferences')}</p>
            <h1>{navItems.find((item) => item.id === view)?.text}</h1>
          </div>
          <div className="topbar-actions">
            {lastSyncMessage && <span className="sync-message">{lastSyncMessage}</span>}
            <button className="icon-button" title={t('立即同步更新', 'Sync now')} onClick={syncNow} disabled={syncing}>
              <RefreshCw size={18} className={syncing ? 'spin' : ''} />
            </button>
            <button className="inbox-button" onClick={() => setView('tasks')} aria-label={t(`${pendingCount} 项待看`, `${pendingCount} to watch`)}>
              <Inbox size={18} />
              <span>{t(`${pendingCount} 项待看`, `${pendingCount} to watch`)}</span>
            </button>
          </div>
        </header>

        <div className="view-container">
          {view === 'season' && (
            <SeasonView
              anime={anime}
              loading={loading}
              error={error}
              season={season}
              year={year}
              seasonView={seasonView}
              followedIds={new Set(state.following.map((item) => item.id))}
              titleMatches={state.bangumiTitles}
              titlePreference={state.settings.titlePreference}
              language={language}
              onSeasonChange={setSeason}
              onYearChange={setYear}
              onSeasonViewChange={setSeasonView}
              onRetry={loadSeason}
              onToggleFollow={async (item) => setState(await api.toggleFollow(item))}
            />
          )}
          {view === 'tasks' && <TasksView tasks={state.tasks} language={language} onToggle={async (id) => setState(await api.toggleTask(id))} />}
          {view === 'following' && (
            <FollowingView
              items={state.following}
              language={language}
              onOpenTasks={() => setView('tasks')}
              onRename={async (id, displayTitle) => setState(await api.updateFollowTitle(id, displayTitle))}
              onUnfollow={async (id) => {
                const source = anime.find((item) => item.id === id);
                const followed = state.following.find((item) => item.id === id);
                if (!followed) return;
                const pendingTaskCount = state.tasks.filter((task) => task.animeId === id && task.status === 'pending').length;
                const taskNotice = pendingTaskCount > 0
                  ? t(`取消追番后将移除 ${pendingTaskCount} 个待看任务，已完成记录会保留。`, `Unfollowing will remove ${pendingTaskCount} pending task${pendingTaskCount === 1 ? '' : 's'}. Completed history will be kept.`)
                  : t('取消追番后，已完成记录会保留。', 'Completed history will be kept after unfollowing.');
                if (!window.confirm(t(`确认取消追番《${followed.displayTitle}》吗？\n\n${taskNotice}`, `Unfollow “${followed.displayTitle}”?\n\n${taskNotice}`))) return;
                if (source) setState(await api.toggleFollow(source));
                else setState(await api.toggleFollow({ ...followed, coverImage: { medium: followed.coverImage } }));
              }}
            />
          )}
          {view === 'settings' && (
            <SettingsView state={state} language={language} onChange={async (patch) => setState(await api.updateSettings(patch))} />
          )}
        </div>
      </main>
    </div>
  );
}

function SeasonView({
  anime,
  loading,
  error,
  season,
  year,
  seasonView,
  followedIds,
  titleMatches,
  titlePreference,
  language,
  onSeasonChange,
  onYearChange,
  onSeasonViewChange,
  onRetry,
  onToggleFollow,
}: {
  anime: Anime[];
  loading: boolean;
  error: string;
  season: Season;
  year: number;
  seasonView: SeasonViewMode;
  followedIds: Set<number>;
  titleMatches: Record<string, BangumiTitleMatch>;
  titlePreference: AppSettings['titlePreference'];
  language: UiLanguage;
  onSeasonChange: (season: Season) => void;
  onYearChange: (year: number) => void;
  onSeasonViewChange: (view: SeasonViewMode) => void;
  onRetry: () => void;
  onToggleFollow: (anime: Anime) => Promise<void>;
}) {
  const t = (chinese: string, english: string) => tr(language, chinese, english);
  const [query, setQuery] = useState('');
  const [format, setFormat] = useState('ALL');
  const [onlyFollowing, setOnlyFollowing] = useState(false);
  const [selected, setSelected] = useState<Anime | null>(null);
  const requestedTitles = useRef(new Set<number>());

  useEffect(() => {
    requestedTitles.current.clear();
  }, [season, year]);

  const requestChineseTitle = useCallback((item: Anime) => {
    if (IS_ORIGINAL_EDITION || !api.resolveBangumiTitle) return;
    if (requestedTitles.current.has(item.id)) return;
    requestedTitles.current.add(item.id);
    void api.resolveBangumiTitle(item).catch(() => {});
  }, []);

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return anime.filter((item) => {
      const matchesQuery = !normalized || [IS_ORIGINAL_EDITION ? undefined : titleMatches[String(item.id)]?.nameCn, item.title.native, item.title.english, item.title.romaji, item.studios?.nodes[0]?.name]
        .some((value) => value?.toLowerCase().includes(normalized));
      const matchesFormat = format === 'ALL' || item.format === format;
      const matchesFollowing = !onlyFollowing || followedIds.has(item.id);
      return matchesQuery && matchesFormat && matchesFollowing;
    });
  }, [anime, query, format, onlyFollowing, followedIds, titleMatches]);

  const weekdayGroups = useMemo(() => {
    const groups = Array.from({ length: 8 }, () => [] as Anime[]);
    visible.forEach((item) => groups[localAiringWeekday(item)].push(item));
    return groups;
  }, [visible]);

  const weekdayLabels: Array<[string, string]> = [
    ['周一', 'Monday'], ['周二', 'Tuesday'], ['周三', 'Wednesday'], ['周四', 'Thursday'],
    ['周五', 'Friday'], ['周六', 'Saturday'], ['周日', 'Sunday'], ['播出日待定', 'TBA'],
  ];

  const renderAnimeCard = (item: Anime) => (
    <AnimeCard
      key={item.id}
      anime={item}
      titleMatch={titleMatches[String(item.id)]}
      titlePreference={titlePreference}
      language={language}
      followed={followedIds.has(item.id)}
      onVisible={requestChineseTitle}
      onOpen={() => setSelected(item)}
      onToggle={() => onToggleFollow(item)}
    />
  );

  const shiftYear = (delta: number) => onYearChange(Math.max(2000, Math.min(2100, year + delta)));

  return (
    <>
      <section className="season-toolbar" aria-label={t('季度选择', 'Season selection')}>
        <div className="year-stepper">
          <button title={t('上一年', 'Previous year')} onClick={() => shiftYear(-1)}><ChevronLeft size={18} /></button>
          <strong>{year}</strong>
          <button title={t('下一年', 'Next year')} onClick={() => shiftYear(1)}><ChevronRight size={18} /></button>
        </div>
        <div className="segmented-control">
          {SEASONS.map((item) => (
            <button key={item.value} className={season === item.value ? 'selected' : ''} onClick={() => onSeasonChange(item.value)}>
              {language === 'en-US' ? seasonName(item.value, language) : `${seasonName(item.value, language)}季`} <small>{seasonMonths(item.value, language)}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="section-heading">
        <div>
          <div className="eyebrow"><Sparkles size={14} /> {seasonLabel(season, year, language)}</div>
          <h2>{t('新番更新时间表', 'Seasonal release schedule')}</h2>
          <p>{loading ? t('正在读取 AniList…', 'Loading AniList…') : t(`${anime.length} 部作品 · 时间按本机时区显示`, `${anime.length} titles · Times shown in your local time zone`)}</p>
        </div>
        <div className="filter-row">
          <label className="search-field">
            <Search size={17} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索番剧或制作公司', 'Search anime or studio')} />
            {query && <button title={t('清空搜索', 'Clear search')} onClick={() => setQuery('')}><X size={15} /></button>}
          </label>
          <label className="select-field">
            <Filter size={16} />
            <select value={format} onChange={(event) => setFormat(event.target.value)}>
              <option value="ALL">{t('全部类型', 'All formats')}</option>
              <option value="TV">{t('TV 动画', 'TV')}</option>
              <option value="ONA">{t('网络动画', 'ONA')}</option>
              <option value="MOVIE">{t('电影', 'Movie')}</option>
              <option value="OVA">OVA</option>
              <option value="SPECIAL">{t('特别篇', 'Special')}</option>
            </select>
          </label>
          <label className="check-filter">
            <input type="checkbox" checked={onlyFollowing} onChange={(event) => setOnlyFollowing(event.target.checked)} />
            {t('只看已追', 'Following only')}
          </label>
          <div className="segmented-control view-mode-control" role="group" aria-label={t('新番排列方式', 'Season layout')}>
            <button className={seasonView === 'weekday' ? 'selected' : ''} aria-pressed={seasonView === 'weekday'} onClick={() => onSeasonViewChange('weekday')}>
              <CalendarRange size={14} /> <span>{t('星期', 'Weekday')}</span>
            </button>
            <button className={seasonView === 'all' ? 'selected' : ''} aria-pressed={seasonView === 'all'} onClick={() => onSeasonViewChange('all')}>
              <LayoutGrid size={14} /> <span>{t('全部', 'All')}</span>
            </button>
          </div>
        </div>
      </section>

      {error ? (
        <EmptyState icon={MonitorDot} title={t('暂时无法读取新番', 'Could not load seasonal anime')} body={error} action={t('重新载入', 'Reload')} onAction={onRetry} />
      ) : loading ? (
        <div className="anime-grid" aria-label={t('正在载入', 'Loading')}>
          {Array.from({ length: 10 }, (_, index) => <div className="anime-skeleton" key={index}><span /><i /><i /></div>)}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState icon={Search} title={t('没有符合条件的番剧', 'No matching anime')} body={t('调整搜索或筛选条件后再试。', 'Try changing the search or filters.')} />
      ) : (
        seasonView === 'all' ? (
          <div className="anime-grid">{visible.map(renderAnimeCard)}</div>
        ) : (
          <div className="weekday-sections">
            {weekdayGroups.map((items, index) => items.length > 0 && (
              <section className="weekday-section" key={index} aria-labelledby={`weekday-${index}`}>
                <header className="weekday-heading">
                  <h3 id={`weekday-${index}`}>{t(...weekdayLabels[index])}</h3>
                  <span>{t(`${items.length} 部`, `${items.length} title${items.length === 1 ? '' : 's'}`)}</span>
                </header>
                <div className="anime-grid">{items.map(renderAnimeCard)}</div>
              </section>
            ))}
          </div>
        )
      )}

      {selected && (
        <AnimeDetail
          anime={selected}
          titleMatch={titleMatches[String(selected.id)]}
          titlePreference={titlePreference}
          language={language}
          followed={followedIds.has(selected.id)}
          onClose={() => setSelected(null)}
          onToggle={() => onToggleFollow(selected)}
        />
      )}
    </>
  );
}

function localizedTitle(anime: Anime, match?: BangumiTitleMatch, preference: AppSettings['titlePreference'] = 'auto', language: UiLanguage = 'zh-CN'): string {
  if (IS_ORIGINAL_EDITION) return titleForPreference(anime.title, preference, language);
  return match?.status === 'matched' && match.nameCn ? match.nameCn : reminderTitleOf(anime.title);
}

function AnimeCard({
  anime,
  titleMatch,
  titlePreference,
  language,
  followed,
  onOpen,
  onToggle,
  onVisible,
}: {
  anime: Anime;
  titleMatch?: BangumiTitleMatch;
  titlePreference: AppSettings['titlePreference'];
  language: UiLanguage;
  followed: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onVisible: (anime: Anime) => void;
}) {
  const t = (chinese: string, english: string) => tr(language, chinese, english);
  const next = anime.nextAiringEpisode;
  const cardRef = useRef<HTMLElement>(null);
  const displayTitle = localizedTitle(anime, titleMatch, titlePreference, language);
  const originalTitle = titleOf(anime.title, language);

  useEffect(() => {
    if (IS_ORIGINAL_EDITION || titleMatch || !cardRef.current) return;
    if (!('IntersectionObserver' in window)) {
      onVisible(anime);
      return;
    }
    const root = document.querySelector('.view-container');
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onVisible(anime);
        observer.disconnect();
      }
    }, { root, rootMargin: '700px 0px' });
    observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, [anime.id, titleMatch, onVisible]);

  return (
    <article className="anime-card" ref={cardRef}>
      <button className="poster-button" onClick={onOpen} aria-label={t(`查看 ${displayTitle} 详情`, `View details for ${displayTitle}`)}>
        <img src={anime.coverImage?.extraLarge || anime.coverImage?.medium} alt="" loading="lazy" />
        <span className="score">{anime.averageScore ? `${anime.averageScore}%` : 'NEW'}</span>
      </button>
      <div className="anime-card-body">
        <div className="anime-meta"><span>{formatLabel(anime.format, language)}</span><span>{anime.episodes ? t(`${anime.episodes} 集`, `${anime.episodes} episodes`) : t('集数待定', 'Episodes TBA')}</span></div>
        <button className="anime-title" onClick={onOpen}>{displayTitle}</button>
        <p className="anime-subtitle">{originalTitle !== displayTitle ? originalTitle : secondaryTitle(anime.title, language) || anime.studios?.nodes[0]?.name || t('制作信息待定', 'Studio TBA')}</p>
        <div className="airing-line">
          <Clock3 size={15} />
          <span>{next ? t(`第 ${next.episode} 集 · ${formatAiring(next.airingAt, true, language)}`, `Episode ${next.episode} · ${formatAiring(next.airingAt, true, language)}`) : anime.status === 'FINISHED' ? t('本季已完结', 'Finished') : t('更新时间待定', 'Schedule TBA')}</span>
        </div>
        <button className={`follow-button ${followed ? 'followed' : ''}`} onClick={onToggle}>
          {followed ? <Check size={17} /> : <Bell size={17} />}
          {followed ? t('已加入追番', 'Following') : t('加入追番', 'Follow')}
        </button>
      </div>
    </article>
  );
}

function AnimeDetail({ anime, titleMatch, titlePreference, language, followed, onClose, onToggle }: { anime: Anime; titleMatch?: BangumiTitleMatch; titlePreference: AppSettings['titlePreference']; language: UiLanguage; followed: boolean; onClose: () => void; onToggle: () => void }) {
  const t = (chinese: string, english: string) => tr(language, chinese, english);
  const displayTitle = localizedTitle(anime, titleMatch, titlePreference, language);
  const originalTitle = titleOf(anime.title, language);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="detail-panel" onMouseDown={(event) => event.stopPropagation()} aria-modal="true" role="dialog">
        <button className="close-button" onClick={onClose} title={t('关闭', 'Close')}><X size={20} /></button>
        <div className="detail-banner" style={anime.bannerImage ? { backgroundImage: `url(${anime.bannerImage})` } : undefined} />
        <div className="detail-content">
          <img className="detail-cover" src={anime.coverImage?.extraLarge || anime.coverImage?.medium} alt="" />
          <div className="detail-main">
            <div className="eyebrow">{formatLabel(anime.format, language)} · {anime.episodes ? t(`${anime.episodes} 集`, `${anime.episodes} episodes`) : t('集数待定', 'Episodes TBA')}</div>
            <h2>{displayTitle}</h2>
            {originalTitle !== displayTitle && <p className="detail-alt-title">{originalTitle}</p>}
            <div className="detail-stats">
              <span><strong>{anime.averageScore || '—'}</strong> {t('评分', 'score')}</span>
              <span><strong>{anime.duration || '—'}</strong> {t('分钟', 'min')}</span>
              <span><strong>{anime.studios?.nodes[0]?.name || t('待定', 'TBA')}</strong> {t('制作', 'studio')}</span>
            </div>
            <p className="description">{stripDescription(anime.description, language)}</p>
            <div className="genre-list">{anime.genres?.map((genre) => <span key={genre}>{genre}</span>)}</div>
            {anime.nextAiringEpisode && (
              <div className="next-airing">
                <Clock3 size={19} />
                <div><strong>{t(`第 ${anime.nextAiringEpisode.episode} 集`, `Episode ${anime.nextAiringEpisode.episode}`)}</strong><span>{formatAiring(anime.nextAiringEpisode.airingAt, true, language)} · {relativeTime(anime.nextAiringEpisode.airingAt, language)}</span></div>
              </div>
            )}
            <div className="detail-actions">
              <button className={`primary-button ${followed ? 'subtle' : ''}`} onClick={onToggle}>
                {followed ? <Check size={18} /> : <Bell size={18} />}{followed ? t('已加入追番', 'Following') : t('加入追番', 'Follow')}
              </button>
              {anime.siteUrl && <button className="secondary-button" onClick={() => api.openExternal(anime.siteUrl!)}><ExternalLink size={17} /> {t('AniList 页面', 'Open on AniList')}</button>}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function TasksView({ tasks, language, onToggle }: { tasks: WatchTask[]; language: UiLanguage; onToggle: (id: string) => Promise<void> }) {
  const t = (chinese: string, english: string) => tr(language, chinese, english);
  const [filter, setFilter] = useState<'pending' | 'completed' | 'all'>('pending');
  const visible = tasks.filter((task) => filter === 'all' || task.status === filter);
  const pending = tasks.filter((task) => task.status === 'pending').length;
  const completed = tasks.filter((task) => task.status === 'completed').length;

  return (
    <>
      <section className="task-summary">
        <div><span>{t('待观看', 'To watch')}</span><strong>{pending}</strong><small>{t('播出后自动加入', 'Added after airing')}</small></div>
        <div><span>{t('已看完', 'Completed')}</span><strong>{completed}</strong><small>{t('保留观看记录', 'Watch history kept')}</small></div>
        <div><span>{t('完成率', 'Completion')}</span><strong>{tasks.length ? Math.round((completed / tasks.length) * 100) : 0}%</strong><small>{t('当前任务清单', 'Current task list')}</small></div>
      </section>
      <section className="section-heading compact">
        <div><div className="eyebrow"><ListChecks size={14} /> {t('每集任务', 'Episode tasks')}</div><h2>{t('观看清单', 'Watch list')}</h2><p>{t('勾选一集，任务即归档到已完成。', 'Check off an episode to archive it as completed.')}</p></div>
        <div className="segmented-control task-tabs">
          <button className={filter === 'pending' ? 'selected' : ''} onClick={() => setFilter('pending')}>{t('待看', 'Pending')} {pending}</button>
          <button className={filter === 'completed' ? 'selected' : ''} onClick={() => setFilter('completed')}>{t('已看', 'Completed')} {completed}</button>
          <button className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}>{t('全部', 'All')}</button>
        </div>
      </section>
      {visible.length === 0 ? (
        <EmptyState icon={CheckCircle2} title={filter === 'pending' ? t('待看清单已清空', 'No pending tasks') : t('这里还没有观看记录', 'No watch history yet')} body={filter === 'pending' ? t('追番更新后，每集会自动出现在这里。', 'New episodes will appear here after they air.') : t('看完一集并勾选后会保存在这里。', 'Completed episodes will be kept here.')} />
      ) : (
        <div className="task-list">
          {visible.map((task) => <TaskRow key={task.id} task={task} language={language} onToggle={() => onToggle(task.id)} />)}
        </div>
      )}
    </>
  );
}

function TaskRow({ task, language, onToggle }: { task: WatchTask; language: UiLanguage; onToggle: () => void }) {
  const t = (chinese: string, english: string) => tr(language, chinese, english);
  return (
    <article className={`task-row ${task.status === 'completed' ? 'completed' : ''}`}>
      <button className="task-check" title={task.status === 'completed' ? t('恢复为待看', 'Restore as pending') : t('标记为已看', 'Mark as watched')} onClick={onToggle}>
        {task.status === 'completed' ? <CheckCircle2 size={23} /> : <Circle size={23} />}
      </button>
      {task.coverImage ? <img src={task.coverImage} alt="" /> : <span className="cover-placeholder" />}
      <div className="task-copy"><strong>{task.animeTitle}</strong><span>{t(`第 ${task.episode} 集`, `Episode ${task.episode}`)}</span></div>
      <div className="task-time"><Clock3 size={15} /><span>{formatAiring(task.airingAt, true, language)}</span></div>
      <span className="task-state">{task.status === 'completed' ? t('已看完', 'Completed') : t('待观看', 'To watch')}</span>
    </article>
  );
}

function FollowingView({
  items,
  language,
  onUnfollow,
  onOpenTasks,
  onRename,
}: {
  items: AppState['following'];
  language: UiLanguage;
  onUnfollow: (id: number) => void;
  onOpenTasks: () => void;
  onRename: (id: number, displayTitle: string) => Promise<void>;
}) {
  const t = (chinese: string, english: string) => tr(language, chinese, english);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const sorted = [...items].sort((a, b) => (a.nextAiringEpisode?.airingAt || Infinity) - (b.nextAiringEpisode?.airingAt || Infinity));
  return (
    <>
      <section className="section-heading compact">
        <div><div className="eyebrow"><BellRing size={14} /> {t('自动跟踪', 'Automatic tracking')}</div><h2>{t('正在追的番剧', 'Currently following')}</h2><p>{t(`${items.length} 部作品会在播出后自动创建观看任务。`, `${items.length} title${items.length === 1 ? '' : 's'} will create watch tasks after airing.`)}</p></div>
        <button className="secondary-button" onClick={onOpenTasks}><ListChecks size={17} /> {t('查看任务', 'View tasks')}</button>
      </section>
      {items.length === 0 ? (
        <EmptyState icon={Bell} title={t('还没有添加追番', 'Nothing followed yet')} body={t('到季度新番中选择作品，更新提醒会自动开启。', 'Choose a title from Seasonal Anime to enable update alerts.')} />
      ) : (
        <div className="following-list">
          {sorted.map((item) => (
            <article className="following-row" key={item.id}>
              <img src={item.coverImage} alt="" />
              <div className="following-copy">
                <span>{formatLabel(item.format, language)} · {t('通知与任务标题', 'Notification and task title')}</span>
                {editingId === item.id ? (
                  <div className="title-editor">
                    <input
                      value={draftTitle}
                      onChange={(event) => setDraftTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setEditingId(null);
                        if (event.key === 'Enter' && draftTitle.trim()) {
                          void onRename(item.id, draftTitle).then(() => setEditingId(null));
                        }
                      }}
                      aria-label={t(`${item.displayTitle} 的提醒标题`, `Alert title for ${item.displayTitle}`)}
                      placeholder={t('输入提醒标题', 'Enter alert title')}
                      autoFocus
                    />
                    <button
                      title={t('保存提醒名', 'Save alert title')}
                      disabled={!draftTitle.trim()}
                      onClick={() => void onRename(item.id, draftTitle).then(() => setEditingId(null))}
                    ><Check size={16} /></button>
                    <button title={t('取消修改', 'Cancel editing')} onClick={() => setEditingId(null)}><X size={16} /></button>
                  </div>
                ) : (
                  <div className="following-name">
                    <strong>{item.displayTitle}</strong>
                    <button
                      title={t('修改提醒标题', 'Edit alert title')}
                      onClick={() => { setEditingId(item.id); setDraftTitle(item.displayTitle); }}
                    ><Pencil size={14} /></button>
                  </div>
                )}
                <small>{titleOf(item.title, language) !== item.displayTitle ? `${titleOf(item.title, language)} · ` : ''}{item.episodes ? t(`全 ${item.episodes} 集`, `${item.episodes} episodes`) : t('总集数待定', 'Episode count TBA')}</small>
              </div>
              <div className="following-next">
                <small>{t('下次更新', 'Next episode')}</small>
                <strong>{item.nextAiringEpisode ? t(`第 ${item.nextAiringEpisode.episode} 集`, `Episode ${item.nextAiringEpisode.episode}`) : t('暂无日程', 'No schedule')}</strong>
                <span>{item.nextAiringEpisode ? `${formatAiring(item.nextAiringEpisode.airingAt, true, language)} · ${relativeTime(item.nextAiringEpisode.airingAt, language)}` : t('等待 AniList 公布', 'Waiting for AniList')}</span>
              </div>
              <button className="icon-button danger" title={t('取消追番', 'Unfollow')} aria-label={t(`取消追番 ${item.displayTitle}`, `Unfollow ${item.displayTitle}`)} onClick={() => onUnfollow(item.id)}><Minus size={19} /></button>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

function SettingsView({ state, language, onChange }: { state: AppState; language: UiLanguage; onChange: (patch: Partial<AppSettings>) => Promise<void> }) {
  const t = (chinese: string, english: string) => tr(language, chinese, english);
  const message = (reason: unknown, chinese: string, english: string) => reason instanceof Error ? localizeMessage(reason.message, language) : t(chinese, english);
  const isAndroid = state.runtime?.platform === 'android';
  const isTauriDesktop = IS_TAURI_APP && state.runtime?.isDesktop === true && !isAndroid;
  const [proxyUrl, setProxyUrl] = useState(state.settings.bangumiApiBaseUrl);
  const [proxyStatus, setProxyStatus] = useState('');
  const [testingProxy, setTestingProxy] = useState(false);
  const [cacheBytes, setCacheBytes] = useState<number | null>(null);
  const [cacheSupported, setCacheSupported] = useState<boolean | null>(null);
  const [cacheStatus, setCacheStatus] = useState('');
  const [clearingCache, setClearingCache] = useState(false);
  const [webDavConfig, setWebDavConfig] = useState<WebDavConfig | null>(null);
  const [webDavUrl, setWebDavUrl] = useState('');
  const [webDavUsername, setWebDavUsername] = useState('');
  const [webDavPassword, setWebDavPassword] = useState('');
  const [webDavStatus, setWebDavStatus] = useState('');
  const [webDavBusy, setWebDavBusy] = useState(false);
  const [bangumiAuth, setBangumiAuth] = useState<BangumiAuthStatus | null>(null);
  const [bangumiProfile, setBangumiProfile] = useState<BangumiUserProfile | null>(null);
  const [bangumiToken, setBangumiToken] = useState('');
  const [bangumiApiUrl, setBangumiApiUrl] = useState(state.bangumiSyncSettings?.apiBaseUrl || state.settings.bangumiApiBaseUrl);
  const [bangumiStatus, setBangumiStatus] = useState('');
  const [bangumiBusy, setBangumiBusy] = useState(false);

  useEffect(() => setProxyUrl(state.settings.bangumiApiBaseUrl), [state.settings.bangumiApiBaseUrl]);
  useEffect(() => setBangumiApiUrl(state.bangumiSyncSettings?.apiBaseUrl || state.settings.bangumiApiBaseUrl), [state.bangumiSyncSettings?.apiBaseUrl, state.settings.bangumiApiBaseUrl]);

  useEffect(() => {
    let active = true;
    api.getCacheInfo()
      .then((info) => {
        if (!active) return;
        setCacheSupported(info.supported);
        setCacheBytes(info.supported ? info.bytes : null);
      })
      .catch((reason) => { if (active) setCacheStatus(message(reason, '无法读取缓存大小', 'Could not calculate cache size')); });
    return () => { active = false; };
  }, [language]);

  useEffect(() => {
    let active = true;
    api.getWebDavConfig()
      .then((config) => {
        if (!active) return;
        setWebDavConfig(config);
        setWebDavUrl(config.baseUrl);
        setWebDavUsername(config.username);
        setWebDavStatus(config.lastError ? localizeMessage(config.lastError, language) : '');
      })
      .catch((reason) => { if (active) setWebDavStatus(message(reason, '无法读取 WebDAV 设置', 'Could not read WebDAV settings')); });
    return () => { active = false; };
  }, [language]);

  const loadBangumiStatus = async () => {
    if (!api.bangumiAuthStatus) return;
    const status = await api.bangumiAuthStatus();
    setBangumiAuth(status);
    setBangumiProfile(status.hasToken && api.bangumiGetUserProfile ? await api.bangumiGetUserProfile() : null);
  };

  useEffect(() => {
    if (!api.bangumiAuthStatus) return;
    let active = true;
    loadBangumiStatus().catch((reason) => { if (active) setBangumiStatus(message(reason, '无法读取 Bangumi 连接状态', 'Could not read Bangumi connection status')); });
    return () => { active = false; };
  }, [language]);

  const saveBangumiToken = async () => {
    if (!api.bangumiSaveToken || !api.bangumiTestConnection) return;
    setBangumiBusy(true);
    setBangumiStatus(t('正在保存…', 'Saving…'));
    try {
      const saved = await api.bangumiSaveToken({ token: bangumiToken.trim() });
      if (!saved.ok) {
        setBangumiStatus(localizeMessage(saved.message, language));
        return;
      }
      setBangumiToken('');
      const result = await api.bangumiTestConnection({ baseUrl: bangumiApiUrl.trim() || null });
      setBangumiStatus(localizeMessage(result.message, language));
      await loadBangumiStatus();
    } catch (reason) {
      setBangumiStatus(message(reason, 'Bangumi 连接失败', 'Bangumi connection failed'));
    } finally {
      setBangumiBusy(false);
    }
  };

  const saveBangumiApiUrl = async () => {
    const next = bangumiApiUrl.trim();
    const current = state.bangumiSyncSettings?.apiBaseUrl || state.settings.bangumiApiBaseUrl || '';
    if (next === current.trim()) return;
    try {
      await onChange({ bangumiApiBaseUrl: next });
      setBangumiStatus(next ? t('API 地址已保存', 'API address saved') : t('已恢复使用官方 API', 'Restored to the official API'));
    } catch (reason) {
      setBangumiStatus(message(reason, 'API 地址无效', 'Invalid API address'));
    }
  };

  const disconnectBangumi = async () => {
    if (!api.bangumiDisconnect) return;
    if (!window.confirm(t('确认断开 Bangumi 账户连接吗？\n\n本地观看记录与追番清单会保留。', 'Disconnect the Bangumi account?\n\nLocal watch history and the following list are kept.'))) return;
    setBangumiBusy(true);
    setBangumiStatus(t('正在断开…', 'Disconnecting…'));
    try {
      const result = await api.bangumiDisconnect();
      setBangumiStatus(localizeMessage(result.message, language));
      await loadBangumiStatus();
    } catch (reason) {
      setBangumiStatus(message(reason, 'Bangumi 断开失败', 'Could not disconnect Bangumi'));
    } finally {
      setBangumiBusy(false);
    }
  };

  const webDavPayload = (enabled: boolean) => ({    enabled,
    baseUrl: webDavUrl,
    username: webDavUsername,
    ...(webDavPassword ? { password: webDavPassword } : {}),
  });

  const saveWebDav = async (enabled = webDavConfig?.enabled || false) => {
    setWebDavBusy(true);
    setWebDavStatus(t('正在保存…', 'Saving…'));
    try {
      const saved = await api.saveWebDavConfig(webDavPayload(enabled));
      setWebDavConfig(saved);
      setWebDavPassword('');
      setWebDavStatus(t('WebDAV 设置已保存', 'WebDAV settings saved'));
      return saved;
    } catch (reason) {
      setWebDavStatus(message(reason, 'WebDAV 设置保存失败', 'Could not save WebDAV settings'));
      return null;
    } finally {
      setWebDavBusy(false);
    }
  };

  const testWebDav = async () => {
    setWebDavBusy(true);
    setWebDavStatus(t('正在测试连接…', 'Testing connection…'));
    try {
      const saved = await api.saveWebDavConfig(webDavPayload(webDavConfig?.enabled || false));
      setWebDavConfig(saved);
      setWebDavPassword('');
      const result = await api.testWebDavConnection();
      setWebDavStatus(localizeMessage(result.message, language));
    } catch (reason) {
      setWebDavStatus(message(reason, 'WebDAV 连接失败', 'WebDAV connection failed'));
    } finally {
      setWebDavBusy(false);
    }
  };

  const syncWebDav = async () => {
    setWebDavBusy(true);
    setWebDavStatus(t('正在同步…', 'Syncing…'));
    try {
      const result = await api.syncWebDav();
      setWebDavConfig(await api.getWebDavConfig());
      setWebDavStatus(localizeMessage(result.message, language));
    } catch (reason) {
      setWebDavStatus(message(reason, 'WebDAV 同步失败', 'WebDAV sync failed'));
    } finally {
      setWebDavBusy(false);
    }
  };

  const clearCache = async () => {
    setClearingCache(true);
    setCacheStatus('');
    try {
      const before = cacheBytes || 0;
      const info = await api.clearCache();
      setCacheSupported(info.supported);
      setCacheBytes(info.supported ? info.bytes : null);
      setCacheStatus(before > info.bytes ? t(`已清理 ${formatStorageSize(before - info.bytes)}`, `Cleared ${formatStorageSize(before - info.bytes)}`) : t('当前没有可清理缓存', 'No cache to clear'));
    } catch (reason) {
      setCacheStatus(message(reason, '清理缓存失败', 'Could not clear cache'));
    } finally {
      setClearingCache(false);
    }
  };

  const saveAndTestProxy = async () => {
    setTestingProxy(true);
    setProxyStatus('正在测试…');
    try {
      if (!proxyUrl.trim()) {
        await onChange({ bangumiApiBaseUrl: '' });
        setProxyStatus('已恢复使用官方 API');
        return;
      }
      if (!api.testBangumiConnection) throw new Error('当前版本不提供 Bangumi 网络功能');
      const result = await api.testBangumiConnection(proxyUrl);
      setProxyStatus(result.message);
      if (result.ok) {
        await onChange({ bangumiApiBaseUrl: proxyUrl });
      }
    } catch (reason) {
      setProxyStatus(reason instanceof Error ? reason.message : '地址无效');
    } finally {
      setTestingProxy(false);
    }
  };

  return (
    <div className="settings-layout">
      <section className="settings-section">
        <div className="settings-title"><BellRing size={20} /><div><h2>{t('更新提醒', 'Update alerts')}</h2><p>{t('新一集播出时发送系统通知。', 'Send a system notification when a new episode airs.')}</p></div></div>
        <SettingRow title={t('播出通知', 'Episode notifications')} description={state.runtime?.notificationsSupported === false ? t('当前系统不支持通知', 'Notifications are not supported on this system') : isAndroid ? state.runtime?.notificationPermissionGranted === false ? t('需要在系统设置中允许 AniLog 通知', 'Allow AniLog notifications in system settings') : t('使用 Android 系统通知显示更新', 'Show updates using Android notifications') : t('使用 Windows 通知中心显示更新', 'Show updates in Windows Notification Center')}>
          <Toggle checked={state.settings.notifyWhenAired} disabled={state.runtime?.notificationsSupported === false} onChange={(value) => onChange({ notifyWhenAired: value })} />
        </SettingRow>
        {isAndroid && <SettingRow title={t('自动创建待看任务', 'Create watch tasks automatically')} description={t('关闭后只发送通知，不再新增手机端任务', 'When off, updates only send notifications and do not add mobile tasks')}>
          <Toggle checked={state.settings.createWatchTasks} onChange={(value) => onChange({ createWatchTasks: value })} />
        </SettingRow>}
        <SettingRow title={t('每日待看提醒', 'Daily watch reminder')} description={t('仅在存在待看任务时发送一次汇总通知', 'Send one summary notification only when tasks are pending')}>
          <Toggle checked={state.settings.dailyTaskReminderEnabled} disabled={state.runtime?.notificationsSupported === false} onChange={(value) => onChange({ dailyTaskReminderEnabled: value })} />
        </SettingRow>
        <SettingRow title={t('提醒时间', 'Reminder time')} description={t('错过时间后，将在设备或应用下次启动时补发', 'If missed, it will be delivered after the device or app next starts')}>
          <input
            className="time-input"
            type="time"
            value={state.settings.dailyTaskReminderTime}
            disabled={!state.settings.dailyTaskReminderEnabled}
            aria-label={t('每日待看提醒时间', 'Daily watch reminder time')}
            onChange={(event) => onChange({ dailyTaskReminderTime: event.target.value })}
          />
        </SettingRow>
        <SettingRow title={t('同步间隔', 'Sync interval')} description={t('AniList 数据的后台检查频率', 'How often AniList is checked in the background')}>
          {isAndroid ? <span className="fixed-setting-value">{t('约每 6 小时', 'About every 6 hours')}</span> : <label className="number-select"><select value={state.settings.pollIntervalMinutes} onChange={(event) => onChange({ pollIntervalMinutes: Number(event.target.value) })}><option value={1}>{t('每 1 分钟', 'Every minute')}</option><option value={5}>{t('每 5 分钟', 'Every 5 minutes')}</option><option value={10}>{t('每 10 分钟', 'Every 10 minutes')}</option><option value={15}>{t('每 15 分钟', 'Every 15 minutes')}</option></select></label>}
        </SettingRow>
        {isAndroid && <SettingRow title={t('准时通知', 'On-time notifications')} description={state.runtime?.exactSchedulingGranted ? t('已允许按播出时间准时发送通知', 'Notifications can be sent at the scheduled airing time') : t('未授权时，系统可能延迟发送通知', 'Without permission, the system may delay notifications')}>
          {state.runtime?.exactSchedulingGranted
            ? <span className="fixed-setting-value">{t('已授权', 'Allowed')}</span>
            : <button className="secondary-button" onClick={() => void api.requestExactScheduling?.()}>{t('去授权', 'Open settings')}</button>}
        </SettingRow>}
      </section>
      <section className="settings-section">
        <div className="settings-title"><Cloud size={20} /><div><h2>{t('跨设备同步', 'Cross-device sync')}</h2><p>{t('使用你自己的 WebDAV 账户同步追番和观看任务。', 'Sync followed anime and watch tasks through your own WebDAV account.')}</p></div></div>
        <SettingRow title={t('启用 WebDAV', 'Enable WebDAV')} description={webDavConfig?.supported === false ? t('浏览器预览模式不支持此功能', 'Not available in browser preview mode') : t('设备设置、缓存和通知开关不会同步', 'Device settings, cache, and notification preferences are not synced')}>
          <Toggle
            checked={Boolean(webDavConfig?.enabled)}
            disabled={webDavBusy || !webDavConfig?.supported}
            onChange={(enabled) => { void saveWebDav(enabled); }}
          />
        </SettingRow>
        <div className="webdav-setting">
          <div className="webdav-fields">
            <label><span>{t('服务器地址', 'Server address')}</span><input type="url" value={webDavUrl} disabled={!webDavConfig?.supported} onChange={(event) => { setWebDavUrl(event.target.value); setWebDavStatus(''); }} placeholder="https://dav.example.com/" /></label>
            <label><span>{t('用户名', 'Username')}</span><input value={webDavUsername} disabled={!webDavConfig?.supported} onChange={(event) => { setWebDavUsername(event.target.value); setWebDavStatus(''); }} autoComplete="username" /></label>
            <label><span>{t('应用密码', 'App password')}</span><input type="password" value={webDavPassword} disabled={!webDavConfig?.supported} onChange={(event) => { setWebDavPassword(event.target.value); setWebDavStatus(''); }} placeholder={webDavConfig?.hasPassword ? t('已保存，留空则不修改', 'Saved; leave blank to keep it') : t('输入 WebDAV 应用密码', 'Enter WebDAV app password')} autoComplete="new-password" /></label>
          </div>
          <div className="webdav-actions">
            <button className="secondary-button" disabled={webDavBusy || !webDavConfig?.supported} onClick={() => void saveWebDav()}><Save size={15} /><span>{t('保存', 'Save')}</span></button>
            <button className="secondary-button" disabled={webDavBusy || !webDavConfig?.supported} onClick={testWebDav}><Network size={15} /><span>{t('测试连接', 'Test connection')}</span></button>
            <button className="secondary-button" disabled={webDavBusy || !webDavConfig?.enabled} onClick={syncWebDav}>{webDavBusy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}<span>{t('立即同步', 'Sync now')}</span></button>
          </div>
          <p className={/成功|已同步|已保存|已合并|succeeded|saved|in sync|merged/i.test(webDavStatus) ? 'proxy-status success' : 'proxy-status'}>
            {webDavStatus || (webDavConfig?.lastSyncAt ? t(`上次同步：${formatAiring(webDavConfig.lastSyncAt, true, language)}`, `Last synced: ${formatAiring(webDavConfig.lastSyncAt, true, language)}`) : t('密码保存在系统安全存储中，不会写入追番数据文件。', 'The password is kept in secure system storage and is not written to anime data files.'))}
          </p>
        </div>
      </section>
      {IS_ORIGINAL_EDITION ? (
        <section className="settings-section">
          <div className="settings-title"><Languages size={20} /><div><h2>{t('语言与番名', 'Language and titles')}</h2><p>{t('界面和番剧标题均可选择显示语言。', 'Choose the interface language and preferred AniList title.')}</p></div></div>
          <SettingRow title={t('界面语言', 'Interface language')} description={t('切换后立即生效，并保存在当前设备', 'Takes effect immediately and is saved on this device')}>
            <label className="number-select">
              <select value={state.settings.uiLanguage} onChange={(event) => onChange({ uiLanguage: event.target.value as UiLanguage })}>
                <option value="zh-CN">简体中文</option>
                <option value="en-US">English</option>
              </select>
            </label>
          </SettingRow>
          <SettingRow title={t('首选标题', 'Preferred title')} description={t('首选语言缺失时会自动使用其他可用标题', 'Falls back to another available title when needed')}>
            <label className="number-select">
              <select value={state.settings.titlePreference} onChange={(event) => onChange({ titlePreference: event.target.value as AppSettings['titlePreference'] })}>
                <option value="auto">{t('自动（英文优先）', 'Automatic (English first)')}</option>
                <option value="english">{t('英文', 'English')}</option>
                <option value="romaji">{t('罗马字', 'Romaji')}</option>
                <option value="native">日本語</option>
              </select>
            </label>
          </SettingRow>
        </section>
      ) : (
        <>
        <section className="settings-section">
          <div className="settings-title"><Network size={20} /><div><h2>中文标题网络</h2><p>默认使用公共反代，也可改为自建地址；清空则使用官方 API。</p></div></div>
          <div className="proxy-setting">
            <label htmlFor="bangumi-proxy">Bangumi API 反代地址</label>
            <div className="proxy-controls">
              <input id="bangumi-proxy" type="url" value={proxyUrl} onChange={(event) => { setProxyUrl(event.target.value); setProxyStatus(''); }} placeholder="https://api.example.com" />
              <button className="secondary-button" onClick={saveAndTestProxy} disabled={testingProxy}>{testingProxy ? <LoaderCircle size={15} className="spin" /> : <Network size={15} />}<span>测试并保存</span></button>
            </div>
            <p className={proxyStatus === '连接成功' ? 'proxy-status success' : 'proxy-status'}>{proxyStatus || '反代服务可见你的网络地址和搜索标题，但不会收到追番清单或账号信息。'}</p>
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-title"><User size={20} /><div><h2>Bangumi 账户</h2><p>连接 Bangumi 账户以读取资料与收藏；本阶段为只读接入。</p></div></div>
          <SettingRow title="连接状态" description="Token 保存在系统安全存储中，不会写入追番数据或同步文件。">
            {bangumiAuth?.hasToken ? (
              <span className="fixed-setting-value">
                {(() => {
                  const avatar = bangumiProfile?.avatar?.medium || bangumiProfile?.avatar?.small;
                  return avatar ? <img src={avatar} alt="" style={{ width: 20, height: 20, borderRadius: '50%', objectFit: 'cover' }} /> : null;
                })()}
                {bangumiProfile ? `${bangumiProfile.username} · ${bangumiProfile.nickname}` : '已连接'}
              </span>
            ) : (
              <span className="fixed-setting-value">{bangumiAuth?.supported === false ? '当前平台不支持' : '未连接'}</span>
            )}
          </SettingRow>
          {bangumiAuth?.hasToken && (
            <SettingRow title="账户资料" description="只读信息，来自 Bangumi 授权账户">
              <span className="fixed-setting-value">{bangumiProfile?.username || '—'}{bangumiProfile?.nickname ? ` · ${bangumiProfile.nickname}` : ''}</span>
            </SettingRow>
          )}
          <div className="webdav-setting">
            <div className="webdav-fields">
              <label><span>Access Token</span><input type="password" value={bangumiToken} placeholder="粘贴 Bangumi Access Token" autoComplete="new-password" onChange={(event) => { setBangumiToken(event.target.value); setBangumiStatus(''); }} /></label>
              <label><span>API 地址</span><input type="url" value={bangumiApiUrl} placeholder="留空使用官方 API" onChange={(event) => { setBangumiApiUrl(event.target.value); setBangumiStatus(''); }} onBlur={() => void saveBangumiApiUrl()} /></label>
            </div>
            <div className="webdav-actions">
              <button className="secondary-button" disabled={bangumiBusy} onClick={() => void saveBangumiToken()}><Save size={15} /><span>保存并测试</span></button>
              <button className="secondary-button" disabled={bangumiBusy || !bangumiAuth?.hasToken} onClick={() => void disconnectBangumi()}><X size={15} /><span>断开连接</span></button>
            </div>
            <p className={/成功|已连接|已保存|已恢复|succeeded|saved|connected|restored/i.test(bangumiStatus) ? 'proxy-status success' : 'proxy-status'}>
              {bangumiStatus || '留空 API 地址时使用官方接口；此地址与上方中文标题反代共用同一设置。'}
            </p>
          </div>
        </section>
        </>
      )}
      {isAndroid ? (
        <section className="settings-section">
          <div className="settings-title"><MonitorDot size={20} /><div><h2>{t('Android 后台', 'Android background')}</h2><p>{t('系统定期校正日程，播出时发送普通通知。', 'The system refreshes schedules periodically and sends notifications at airtime.')}</p></div></div>
          <SettingRow title={t('后台方式', 'Background mode')} description={t('不常驻进程，不创建可见的系统闹钟条目', 'Uses system scheduling without keeping a process alive or creating visible alarms')}>
            <span className="fixed-setting-value">{t('系统调度', 'System scheduler')}</span>
          </SettingRow>
        </section>
      ) : (
        <section className="settings-section">
          <div className="settings-title"><MonitorDot size={20} /><div><h2>{t('桌面行为', 'Desktop behavior')}</h2><p>{t('控制应用启动与后台驻留方式。', 'Control startup and background behavior.')}</p></div></div>
          <SettingRow title={t('开机后启动', 'Start at login')} description={state.runtime?.isDesktop ? t('登录 Windows 后自动运行 AniLog', 'Run AniLog automatically after signing in to Windows') : t('仅桌面应用支持此设置', 'Available in the desktop app only')}>
            <Toggle checked={state.settings.launchAtLogin} disabled={!state.runtime?.isDesktop} onChange={(value) => onChange({ launchAtLogin: value })} />
          </SettingRow>
          <SettingRow title={t('关闭时驻留托盘', 'Keep running in tray')} description={t('继续在后台同步并发送更新提醒', 'Continue syncing and sending alerts in the background')}>
            <Toggle checked={state.settings.minimizeToTray} disabled={!state.runtime?.isDesktop} onChange={(value) => onChange({ minimizeToTray: value })} />
          </SettingRow>
          {isTauriDesktop && <SettingRow title={t('显示托盘图标', 'Show tray icon')} description={t('隐藏图标时继续在后台同步并发送提醒', 'Keep syncing and sending alerts while the icon is hidden')}>
            <Toggle label={t('显示托盘图标', 'Show tray icon')} checked={state.settings.showTrayIcon} onChange={(value) => onChange({ showTrayIcon: value })} />
          </SettingRow>}
        </section>
      )}
      {!isAndroid && <section className="settings-section">
        <div className="settings-title"><HardDrive size={20} /><div><h2>{t('缓存空间', 'Cache storage')}</h2><p>{t('封面与网络数据可按需重新下载，不包含追番记录和观看任务。', 'Covers and network data can be downloaded again. Following and tasks are not included.')}</p></div></div>
        <SettingRow title={t('图片与网络缓存', 'Images and network cache')} description={cacheStatus || (IS_ORIGINAL_EDITION ? t('季度列表和本地记录会保留', 'Season lists and local records are kept') : '季度列表、中文标题和本地记录会保留')}>
          <div className="cache-actions">
            <strong>{cacheSupported === false ? t('仅桌面端', 'Desktop only') : cacheBytes === null ? t('正在计算', 'Calculating') : formatStorageSize(cacheBytes)}</strong>
            <button className="secondary-button" disabled={clearingCache || cacheBytes === null || cacheSupported === false} onClick={clearCache}>
              {clearingCache ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}
              <span>{t('清理缓存', 'Clear cache')}</span>
            </button>
          </div>
        </SettingRow>
      </section>}
      <section className="settings-section source-note">
        <SlidersHorizontal size={20} />
        <div><h2>{t('数据与隐私', 'Data and privacy')}</h2><p>{IS_ORIGINAL_EDITION ? t('番剧、标题与播出日程均来自 AniList，不连接 Bangumi 或第三方 Bangumi 反代。默认仅保存在本机；启用 WebDAV 后，只向你配置的服务器同步追番和观看任务。', 'Anime, titles, and schedules come from AniList. This edition never connects to Bangumi or a third-party Bangumi proxy. Data stays on this device by default; WebDAV only syncs following and watch tasks to your configured server.') : '番剧与播出日程来自 AniList，中文标题来自 Bangumi。默认仅保存在本机；启用 WebDAV 后，只向你配置的服务器同步追番和观看任务。'}</p><small>{t('AniList 上次同步：', 'Last AniList sync: ')}{state.lastSyncAt ? formatAiring(state.lastSyncAt, true, language) : t('尚未同步', 'Never')}</small></div>
      </section>
    </div>
  );
}

function formatStorageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function SettingRow({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <div className="setting-row"><div><strong>{title}</strong><span>{description}</span></div>{children}</div>;
}

function Toggle({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label?: string; onChange: (checked: boolean) => void }) {
  return <button className={`toggle ${checked ? 'on' : ''}`} disabled={disabled} role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><span /></button>;
}

function EmptyState({ icon: Icon, title, body, action, onAction }: { icon: typeof Search; title: string; body: string; action?: string; onAction?: () => void }) {
  return (
    <div className="empty-state"><span><Icon size={27} /></span><h3>{title}</h3><p>{body}</p>{action && <button className="secondary-button" onClick={onAction}>{action}</button>}</div>
  );
}

export default App;
