import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  BellRing,
  CalendarDays,
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
  X,
} from 'lucide-react';
import { api } from './api';
import type { Anime, AppState, BangumiTitleMatch, Season, Settings as AppSettings, ViewId, WatchTask, WebDavConfig } from './types';
import { IS_ORIGINAL_EDITION, PRODUCT_NAME, titleForPreference } from './edition';
import { createStateRefreshController } from './state-refresh';
import {
  currentSeason,
  formatAiring,
  formatLabel,
  relativeTime,
  reminderTitleOf,
  SEASONS,
  seasonLabel,
  secondaryTitle,
  stripDescription,
  titleOf,
} from './utils';

const EMPTY_STATE: AppState = {
  version: 2,
  following: [],
  tasks: [],
  bangumiTitles: {},
  settings: { pollIntervalMinutes: 5, launchAtLogin: false, minimizeToTray: true, notifyWhenAired: true, createWatchTasks: true, bangumiApiBaseUrl: IS_ORIGINAL_EDITION ? '' : 'https://bgmapi.anibt.net/v0', titlePreference: 'auto' },
  lastSyncAt: 0,
  syncMetadata: { followingDeletedAt: {} },
};

const NAV_ITEMS: Array<{ id: ViewId; label: string; icon: typeof CalendarDays }> = [
  { id: 'season', label: '季度新番', icon: CalendarDays },
  { id: 'tasks', label: '观看任务', icon: ListChecks },
  { id: 'following', label: '我的追番', icon: Bell },
  { id: 'settings', label: '偏好设置', icon: Settings },
];

const UI_STATE_KEY = IS_ORIGINAL_EDITION ? 'anilog-original-ui-state' : 'anilog-ui-state';

function loadUiState(fallback: { season: Season; year: number }): { view: ViewId; season: Season; year: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(UI_STATE_KEY) || '{}');
    const views: ViewId[] = ['season', 'tasks', 'following', 'settings'];
    return {
      view: views.includes(saved.view) ? saved.view : 'season',
      season: SEASONS.includes(saved.season) ? saved.season : fallback.season,
      year: Number.isInteger(saved.year) && saved.year >= 2000 && saved.year <= 2100 ? saved.year : fallback.year,
    };
  } catch {
    return { view: 'season', ...fallback };
  }
}

function App() {
  const nowSeason = currentSeason();
  const initialUi = useMemo(() => loadUiState(nowSeason), [nowSeason.season, nowSeason.year]);
  const [view, setView] = useState<ViewId>(initialUi.view);
  const [state, setState] = useState<AppState>(EMPTY_STATE);
  const [season, setSeason] = useState<Season>(initialUi.season);
  const [year, setYear] = useState(initialUi.year);
  const [anime, setAnime] = useState<Anime[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [lastSyncMessage, setLastSyncMessage] = useState('');
  const seasonRequest = useRef(0);

  useEffect(() => {
    document.title = PRODUCT_NAME;
  }, []);

  useEffect(() => {
    const openTasks = () => setView('tasks');
    window.addEventListener('anilog:open-tasks', openTasks);
    return () => window.removeEventListener('anilog:open-tasks', openTasks);
  }, []);

  useEffect(() => {
    const controller = createStateRefreshController({
      getState: api.getState,
      subscribe: api.onStateChanged,
      applyState: setState,
      onError: (reason) => {
        setError(reason instanceof Error ? reason.message : '无法读取本地状态');
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
  }, []);

  useEffect(() => {
    localStorage.setItem(UI_STATE_KEY, JSON.stringify({ view, season, year }));
  }, [view, season, year]);

  const loadSeason = useCallback(async () => {
    const requestId = ++seasonRequest.current;
    setLoading(true);
    setError('');
    try {
      const nextAnime = await api.fetchSeason({ season, year });
      if (requestId === seasonRequest.current) setAnime(nextAnime);
    } catch (reason) {
      if (requestId === seasonRequest.current) setError(reason instanceof Error ? reason.message : '无法读取本季番剧');
    } finally {
      if (requestId === seasonRequest.current) setLoading(false);
    }
  }, [season, year]);

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
      setLastSyncMessage(result.created ? `新增 ${result.created} 个观看任务` : '已是最新状态');
    } catch (reason) {
      setLastSyncMessage(reason instanceof Error ? reason.message : '同步失败');
    } finally {
      setSyncing(false);
    }
  };

  const pendingCount = state.tasks.filter((task) => task.status === 'pending').length;
  const isAndroid = state.runtime?.platform === 'android';

  return (
    <div className={`app-shell ${isAndroid ? 'android-app' : ''}`}>
      <aside className="sidebar">
        <button className="brand" onClick={() => setView('season')} aria-label="返回季度新番">
          <span className="brand-mark">A</span>
          <span>
            <strong>{PRODUCT_NAME}</strong>
            <small>{IS_ORIGINAL_EDITION ? '原名追番日程' : '追番日程'}</small>
          </span>
        </button>

        <nav className="main-nav" aria-label="主导航">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={view === item.id ? 'active' : ''}
                onClick={() => setView(item.id)}
                aria-label={item.label}
                title={item.label}
              >
                <Icon size={19} strokeWidth={1.8} />
                <span>{item.label}</span>
                {item.id === 'tasks' && pendingCount > 0 && <span className="nav-count">{pendingCount}</span>}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-status">
          <span className={`status-dot ${state.runtime?.isDesktop || isAndroid ? 'online' : ''}`} />
          <div>
            <strong>{state.runtime?.isDesktop ? '后台提醒已就绪' : isAndroid ? 'Android 后台同步已就绪' : '浏览器预览模式'}</strong>
            <small>{state.following.length} 部追番 · {pendingCount} 项待看</small>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <p>{view === 'season' ? '发现与安排' : view === 'tasks' ? '本地观看清单' : view === 'following' ? '追番管理' : '应用设置'}</p>
            <h1>{NAV_ITEMS.find((item) => item.id === view)?.label}</h1>
          </div>
          <div className="topbar-actions">
            {lastSyncMessage && <span className="sync-message">{lastSyncMessage}</span>}
            <button className="icon-button" title="立即同步更新" onClick={syncNow} disabled={syncing}>
              <RefreshCw size={18} className={syncing ? 'spin' : ''} />
            </button>
            <button className="inbox-button" onClick={() => setView('tasks')} aria-label={`${pendingCount} 项待看`}>
              <Inbox size={18} />
              <span>{pendingCount} 项待看</span>
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
              followedIds={new Set(state.following.map((item) => item.id))}
              titleMatches={state.bangumiTitles}
              titlePreference={state.settings.titlePreference}
              onSeasonChange={setSeason}
              onYearChange={setYear}
              onRetry={loadSeason}
              onToggleFollow={async (item) => setState(await api.toggleFollow(item))}
            />
          )}
          {view === 'tasks' && <TasksView tasks={state.tasks} onToggle={async (id) => setState(await api.toggleTask(id))} />}
          {view === 'following' && (
            <FollowingView
              items={state.following}
              onOpenTasks={() => setView('tasks')}
              onRename={async (id, displayTitle) => setState(await api.updateFollowTitle(id, displayTitle))}
              onUnfollow={async (id) => {
                const source = anime.find((item) => item.id === id);
                const followed = state.following.find((item) => item.id === id);
                if (!followed) return;
                const pendingTaskCount = state.tasks.filter((task) => task.animeId === id && task.status === 'pending').length;
                const taskNotice = pendingTaskCount > 0
                  ? `取消追番后将移除 ${pendingTaskCount} 个待看任务，已完成记录会保留。`
                  : '取消追番后，已完成记录会保留。';
                if (!window.confirm(`确认取消追番《${followed.displayTitle}》吗？\n\n${taskNotice}`)) return;
                if (source) setState(await api.toggleFollow(source));
                else setState(await api.toggleFollow({ ...followed, coverImage: { medium: followed.coverImage } }));
              }}
            />
          )}
          {view === 'settings' && (
            <SettingsView state={state} onChange={async (patch) => setState(await api.updateSettings(patch))} />
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
  followedIds,
  titleMatches,
  titlePreference,
  onSeasonChange,
  onYearChange,
  onRetry,
  onToggleFollow,
}: {
  anime: Anime[];
  loading: boolean;
  error: string;
  season: Season;
  year: number;
  followedIds: Set<number>;
  titleMatches: Record<string, BangumiTitleMatch>;
  titlePreference: AppSettings['titlePreference'];
  onSeasonChange: (season: Season) => void;
  onYearChange: (year: number) => void;
  onRetry: () => void;
  onToggleFollow: (anime: Anime) => Promise<void>;
}) {
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

  const shiftYear = (delta: number) => onYearChange(Math.max(2000, Math.min(2100, year + delta)));

  return (
    <>
      <section className="season-toolbar" aria-label="季度选择">
        <div className="year-stepper">
          <button title="上一年" onClick={() => shiftYear(-1)}><ChevronLeft size={18} /></button>
          <strong>{year}</strong>
          <button title="下一年" onClick={() => shiftYear(1)}><ChevronRight size={18} /></button>
        </div>
        <div className="segmented-control">
          {SEASONS.map((item) => (
            <button key={item.value} className={season === item.value ? 'selected' : ''} onClick={() => onSeasonChange(item.value)}>
              {item.label}季 <small>{item.months}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="section-heading">
        <div>
          <div className="eyebrow"><Sparkles size={14} /> {seasonLabel(season, year)}</div>
          <h2>新番更新时间表</h2>
          <p>{loading ? '正在读取 AniList…' : `${anime.length} 部作品 · 时间按本机时区显示`}</p>
        </div>
        <div className="filter-row">
          <label className="search-field">
            <Search size={17} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索番剧或制作公司" />
            {query && <button title="清空搜索" onClick={() => setQuery('')}><X size={15} /></button>}
          </label>
          <label className="select-field">
            <Filter size={16} />
            <select value={format} onChange={(event) => setFormat(event.target.value)}>
              <option value="ALL">全部类型</option>
              <option value="TV">TV 动画</option>
              <option value="ONA">网络动画</option>
              <option value="MOVIE">电影</option>
              <option value="OVA">OVA</option>
              <option value="SPECIAL">特别篇</option>
            </select>
          </label>
          <label className="check-filter">
            <input type="checkbox" checked={onlyFollowing} onChange={(event) => setOnlyFollowing(event.target.checked)} />
            只看已追
          </label>
        </div>
      </section>

      {error ? (
        <EmptyState icon={MonitorDot} title="暂时无法读取新番" body={error} action="重新载入" onAction={onRetry} />
      ) : loading ? (
        <div className="anime-grid" aria-label="正在载入">
          {Array.from({ length: 10 }, (_, index) => <div className="anime-skeleton" key={index}><span /><i /><i /></div>)}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState icon={Search} title="没有符合条件的番剧" body="调整搜索或筛选条件后再试。" />
      ) : (
        <div className="anime-grid">
          {visible.map((item) => (
            <AnimeCard
              key={item.id}
              anime={item}
              titleMatch={titleMatches[String(item.id)]}
              titlePreference={titlePreference}
              followed={followedIds.has(item.id)}
              onVisible={requestChineseTitle}
              onOpen={() => setSelected(item)}
              onToggle={() => onToggleFollow(item)}
            />
          ))}
        </div>
      )}

      {selected && (
        <AnimeDetail
          anime={selected}
          titleMatch={titleMatches[String(selected.id)]}
          titlePreference={titlePreference}
          followed={followedIds.has(selected.id)}
          onClose={() => setSelected(null)}
          onToggle={() => onToggleFollow(selected)}
        />
      )}
    </>
  );
}

function localizedTitle(anime: Anime, match?: BangumiTitleMatch, preference: AppSettings['titlePreference'] = 'auto'): string {
  if (IS_ORIGINAL_EDITION) return titleForPreference(anime.title, preference);
  return match?.status === 'matched' && match.nameCn ? match.nameCn : reminderTitleOf(anime.title);
}

function AnimeCard({
  anime,
  titleMatch,
  titlePreference,
  followed,
  onOpen,
  onToggle,
  onVisible,
}: {
  anime: Anime;
  titleMatch?: BangumiTitleMatch;
  titlePreference: AppSettings['titlePreference'];
  followed: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onVisible: (anime: Anime) => void;
}) {
  const next = anime.nextAiringEpisode;
  const cardRef = useRef<HTMLElement>(null);
  const displayTitle = localizedTitle(anime, titleMatch, titlePreference);
  const originalTitle = titleOf(anime.title);

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
      <button className="poster-button" onClick={onOpen} aria-label={`查看 ${displayTitle} 详情`}>
        <img src={anime.coverImage?.extraLarge || anime.coverImage?.medium} alt="" loading="lazy" />
        <span className="score">{anime.averageScore ? `${anime.averageScore}%` : 'NEW'}</span>
      </button>
      <div className="anime-card-body">
        <div className="anime-meta"><span>{formatLabel(anime.format)}</span><span>{anime.episodes ? `${anime.episodes} 集` : '集数待定'}</span></div>
        <button className="anime-title" onClick={onOpen}>{displayTitle}</button>
        <p className="anime-subtitle">{originalTitle !== displayTitle ? originalTitle : secondaryTitle(anime.title) || anime.studios?.nodes[0]?.name || '制作信息待定'}</p>
        <div className="airing-line">
          <Clock3 size={15} />
          <span>{next ? `第 ${next.episode} 集 · ${formatAiring(next.airingAt)}` : anime.status === 'FINISHED' ? '本季已完结' : '更新时间待定'}</span>
        </div>
        <button className={`follow-button ${followed ? 'followed' : ''}`} onClick={onToggle}>
          {followed ? <Check size={17} /> : <Bell size={17} />}
          {followed ? '已加入追番' : '加入追番'}
        </button>
      </div>
    </article>
  );
}

function AnimeDetail({ anime, titleMatch, titlePreference, followed, onClose, onToggle }: { anime: Anime; titleMatch?: BangumiTitleMatch; titlePreference: AppSettings['titlePreference']; followed: boolean; onClose: () => void; onToggle: () => void }) {
  const displayTitle = localizedTitle(anime, titleMatch, titlePreference);
  const originalTitle = titleOf(anime.title);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="detail-panel" onMouseDown={(event) => event.stopPropagation()} aria-modal="true" role="dialog">
        <button className="close-button" onClick={onClose} title="关闭"><X size={20} /></button>
        <div className="detail-banner" style={anime.bannerImage ? { backgroundImage: `url(${anime.bannerImage})` } : undefined} />
        <div className="detail-content">
          <img className="detail-cover" src={anime.coverImage?.extraLarge || anime.coverImage?.medium} alt="" />
          <div className="detail-main">
            <div className="eyebrow">{formatLabel(anime.format)} · {anime.episodes ? `${anime.episodes} 集` : '集数待定'}</div>
            <h2>{displayTitle}</h2>
            {originalTitle !== displayTitle && <p className="detail-alt-title">{originalTitle}</p>}
            <div className="detail-stats">
              <span><strong>{anime.averageScore || '—'}</strong> 评分</span>
              <span><strong>{anime.duration || '—'}</strong> 分钟</span>
              <span><strong>{anime.studios?.nodes[0]?.name || '待定'}</strong> 制作</span>
            </div>
            <p className="description">{stripDescription(anime.description)}</p>
            <div className="genre-list">{anime.genres?.map((genre) => <span key={genre}>{genre}</span>)}</div>
            {anime.nextAiringEpisode && (
              <div className="next-airing">
                <Clock3 size={19} />
                <div><strong>第 {anime.nextAiringEpisode.episode} 集</strong><span>{formatAiring(anime.nextAiringEpisode.airingAt)} · {relativeTime(anime.nextAiringEpisode.airingAt)}</span></div>
              </div>
            )}
            <div className="detail-actions">
              <button className={`primary-button ${followed ? 'subtle' : ''}`} onClick={onToggle}>
                {followed ? <Check size={18} /> : <Bell size={18} />}{followed ? '已加入追番' : '加入追番'}
              </button>
              {anime.siteUrl && <button className="secondary-button" onClick={() => api.openExternal(anime.siteUrl!)}><ExternalLink size={17} /> AniList 页面</button>}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function TasksView({ tasks, onToggle }: { tasks: WatchTask[]; onToggle: (id: string) => Promise<void> }) {
  const [filter, setFilter] = useState<'pending' | 'completed' | 'all'>('pending');
  const visible = tasks.filter((task) => filter === 'all' || task.status === filter);
  const pending = tasks.filter((task) => task.status === 'pending').length;
  const completed = tasks.filter((task) => task.status === 'completed').length;

  return (
    <>
      <section className="task-summary">
        <div><span>待观看</span><strong>{pending}</strong><small>播出后自动加入</small></div>
        <div><span>已看完</span><strong>{completed}</strong><small>保留观看记录</small></div>
        <div><span>完成率</span><strong>{tasks.length ? Math.round((completed / tasks.length) * 100) : 0}%</strong><small>当前任务清单</small></div>
      </section>
      <section className="section-heading compact">
        <div><div className="eyebrow"><ListChecks size={14} /> 每集任务</div><h2>观看清单</h2><p>勾选一集，任务即归档到已完成。</p></div>
        <div className="segmented-control task-tabs">
          <button className={filter === 'pending' ? 'selected' : ''} onClick={() => setFilter('pending')}>待看 {pending}</button>
          <button className={filter === 'completed' ? 'selected' : ''} onClick={() => setFilter('completed')}>已看 {completed}</button>
          <button className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}>全部</button>
        </div>
      </section>
      {visible.length === 0 ? (
        <EmptyState icon={CheckCircle2} title={filter === 'pending' ? '待看清单已清空' : '这里还没有观看记录'} body={filter === 'pending' ? '追番更新后，每集会自动出现在这里。' : '看完一集并勾选后会保存在这里。'} />
      ) : (
        <div className="task-list">
          {visible.map((task) => <TaskRow key={task.id} task={task} onToggle={() => onToggle(task.id)} />)}
        </div>
      )}
    </>
  );
}

function TaskRow({ task, onToggle }: { task: WatchTask; onToggle: () => void }) {
  return (
    <article className={`task-row ${task.status === 'completed' ? 'completed' : ''}`}>
      <button className="task-check" title={task.status === 'completed' ? '恢复为待看' : '标记为已看'} onClick={onToggle}>
        {task.status === 'completed' ? <CheckCircle2 size={23} /> : <Circle size={23} />}
      </button>
      {task.coverImage ? <img src={task.coverImage} alt="" /> : <span className="cover-placeholder" />}
      <div className="task-copy"><strong>{task.animeTitle}</strong><span>第 {task.episode} 集</span></div>
      <div className="task-time"><Clock3 size={15} /><span>{formatAiring(task.airingAt)}</span></div>
      <span className="task-state">{task.status === 'completed' ? '已看完' : '待观看'}</span>
    </article>
  );
}

function FollowingView({
  items,
  onUnfollow,
  onOpenTasks,
  onRename,
}: {
  items: AppState['following'];
  onUnfollow: (id: number) => void;
  onOpenTasks: () => void;
  onRename: (id: number, displayTitle: string) => Promise<void>;
}) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const sorted = [...items].sort((a, b) => (a.nextAiringEpisode?.airingAt || Infinity) - (b.nextAiringEpisode?.airingAt || Infinity));
  return (
    <>
      <section className="section-heading compact">
        <div><div className="eyebrow"><BellRing size={14} /> 自动跟踪</div><h2>正在追的番剧</h2><p>{items.length} 部作品会在播出后自动创建观看任务。</p></div>
        <button className="secondary-button" onClick={onOpenTasks}><ListChecks size={17} /> 查看任务</button>
      </section>
      {items.length === 0 ? (
        <EmptyState icon={Bell} title="还没有添加追番" body="到季度新番中选择作品，更新提醒会自动开启。" />
      ) : (
        <div className="following-list">
          {sorted.map((item) => (
            <article className="following-row" key={item.id}>
              <img src={item.coverImage} alt="" />
              <div className="following-copy">
                <span>{formatLabel(item.format)} · 通知与任务标题</span>
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
                      aria-label={`${item.displayTitle} 的提醒标题`}
                      placeholder="输入提醒标题"
                      autoFocus
                    />
                    <button
                      title="保存提醒名"
                      disabled={!draftTitle.trim()}
                      onClick={() => void onRename(item.id, draftTitle).then(() => setEditingId(null))}
                    ><Check size={16} /></button>
                    <button title="取消修改" onClick={() => setEditingId(null)}><X size={16} /></button>
                  </div>
                ) : (
                  <div className="following-name">
                    <strong>{item.displayTitle}</strong>
                    <button
                      title="修改提醒标题"
                      onClick={() => { setEditingId(item.id); setDraftTitle(item.displayTitle); }}
                    ><Pencil size={14} /></button>
                  </div>
                )}
                <small>{titleOf(item.title) !== item.displayTitle ? `${titleOf(item.title)} · ` : ''}{item.episodes ? `全 ${item.episodes} 集` : '总集数待定'}</small>
              </div>
              <div className="following-next">
                <small>下次更新</small>
                <strong>{item.nextAiringEpisode ? `第 ${item.nextAiringEpisode.episode} 集` : '暂无日程'}</strong>
                <span>{item.nextAiringEpisode ? `${formatAiring(item.nextAiringEpisode.airingAt)} · ${relativeTime(item.nextAiringEpisode.airingAt)}` : '等待 AniList 公布'}</span>
              </div>
              <button className="icon-button danger" title="取消追番" aria-label={`取消追番 ${item.displayTitle}`} onClick={() => onUnfollow(item.id)}><Minus size={19} /></button>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

function SettingsView({ state, onChange }: { state: AppState; onChange: (patch: Partial<AppSettings>) => Promise<void> }) {
  const isAndroid = state.runtime?.platform === 'android';
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

  useEffect(() => setProxyUrl(state.settings.bangumiApiBaseUrl), [state.settings.bangumiApiBaseUrl]);

  useEffect(() => {
    let active = true;
    api.getCacheInfo()
      .then((info) => {
        if (!active) return;
        setCacheSupported(info.supported);
        setCacheBytes(info.supported ? info.bytes : null);
      })
      .catch((reason) => { if (active) setCacheStatus(reason instanceof Error ? reason.message : '无法读取缓存大小'); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    api.getWebDavConfig()
      .then((config) => {
        if (!active) return;
        setWebDavConfig(config);
        setWebDavUrl(config.baseUrl);
        setWebDavUsername(config.username);
        setWebDavStatus(config.lastError || '');
      })
      .catch((reason) => { if (active) setWebDavStatus(reason instanceof Error ? reason.message : '无法读取 WebDAV 设置'); });
    return () => { active = false; };
  }, []);

  const webDavPayload = (enabled: boolean) => ({
    enabled,
    baseUrl: webDavUrl,
    username: webDavUsername,
    ...(webDavPassword ? { password: webDavPassword } : {}),
  });

  const saveWebDav = async (enabled = webDavConfig?.enabled || false) => {
    setWebDavBusy(true);
    setWebDavStatus('正在保存…');
    try {
      const saved = await api.saveWebDavConfig(webDavPayload(enabled));
      setWebDavConfig(saved);
      setWebDavPassword('');
      setWebDavStatus('WebDAV 设置已保存');
      return saved;
    } catch (reason) {
      setWebDavStatus(reason instanceof Error ? reason.message : 'WebDAV 设置保存失败');
      return null;
    } finally {
      setWebDavBusy(false);
    }
  };

  const testWebDav = async () => {
    setWebDavBusy(true);
    setWebDavStatus('正在测试连接…');
    try {
      const saved = await api.saveWebDavConfig(webDavPayload(webDavConfig?.enabled || false));
      setWebDavConfig(saved);
      setWebDavPassword('');
      const result = await api.testWebDavConnection();
      setWebDavStatus(result.message);
    } catch (reason) {
      setWebDavStatus(reason instanceof Error ? reason.message : 'WebDAV 连接失败');
    } finally {
      setWebDavBusy(false);
    }
  };

  const syncWebDav = async () => {
    setWebDavBusy(true);
    setWebDavStatus('正在同步…');
    try {
      const result = await api.syncWebDav();
      setWebDavConfig(await api.getWebDavConfig());
      setWebDavStatus(result.message);
    } catch (reason) {
      setWebDavStatus(reason instanceof Error ? reason.message : 'WebDAV 同步失败');
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
      setCacheStatus(before > info.bytes ? `已清理 ${formatStorageSize(before - info.bytes)}` : '当前没有可清理缓存');
    } catch (reason) {
      setCacheStatus(reason instanceof Error ? reason.message : '清理缓存失败');
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
        <div className="settings-title"><BellRing size={20} /><div><h2>更新提醒</h2><p>新一集播出时发送系统通知。</p></div></div>
        <SettingRow title="播出通知" description={state.runtime?.notificationsSupported === false ? '当前系统不支持通知' : isAndroid ? state.runtime?.notificationPermissionGranted === false ? '需要在系统设置中允许 AniLog 通知' : '使用 Android 系统通知显示更新' : '使用 Windows 通知中心显示更新'}>
          <Toggle checked={state.settings.notifyWhenAired} disabled={state.runtime?.notificationsSupported === false} onChange={(value) => onChange({ notifyWhenAired: value })} />
        </SettingRow>
        {isAndroid && <SettingRow title="自动创建待看任务" description="关闭后只发送通知，不再新增手机端任务">
          <Toggle checked={state.settings.createWatchTasks} onChange={(value) => onChange({ createWatchTasks: value })} />
        </SettingRow>}
        <SettingRow title="同步间隔" description="AniList 数据的后台检查频率">
          {isAndroid ? <span className="fixed-setting-value">约每 6 小时</span> : <label className="number-select"><select value={state.settings.pollIntervalMinutes} onChange={(event) => onChange({ pollIntervalMinutes: Number(event.target.value) })}><option value={1}>每 1 分钟</option><option value={5}>每 5 分钟</option><option value={10}>每 10 分钟</option><option value={15}>每 15 分钟</option></select></label>}
        </SettingRow>
        {isAndroid && <SettingRow title="准时通知" description={state.runtime?.exactSchedulingGranted ? '已允许按播出时间准时发送通知' : '未授权时，系统可能延迟发送通知'}>
          {state.runtime?.exactSchedulingGranted
            ? <span className="fixed-setting-value">已授权</span>
            : <button className="secondary-button" onClick={() => void api.requestExactScheduling?.()}>去授权</button>}
        </SettingRow>}
      </section>
      <section className="settings-section">
        <div className="settings-title"><Cloud size={20} /><div><h2>跨设备同步</h2><p>使用你自己的 WebDAV 账户同步追番和观看任务。</p></div></div>
        <SettingRow title="启用 WebDAV" description={webDavConfig?.supported === false ? '浏览器预览模式不支持此功能' : '设备设置、缓存和通知开关不会同步'}>
          <Toggle
            checked={Boolean(webDavConfig?.enabled)}
            disabled={webDavBusy || !webDavConfig?.supported}
            onChange={(enabled) => { void saveWebDav(enabled); }}
          />
        </SettingRow>
        <div className="webdav-setting">
          <div className="webdav-fields">
            <label><span>服务器地址</span><input type="url" value={webDavUrl} disabled={!webDavConfig?.supported} onChange={(event) => { setWebDavUrl(event.target.value); setWebDavStatus(''); }} placeholder="https://dav.example.com/" /></label>
            <label><span>用户名</span><input value={webDavUsername} disabled={!webDavConfig?.supported} onChange={(event) => { setWebDavUsername(event.target.value); setWebDavStatus(''); }} autoComplete="username" /></label>
            <label><span>应用密码</span><input type="password" value={webDavPassword} disabled={!webDavConfig?.supported} onChange={(event) => { setWebDavPassword(event.target.value); setWebDavStatus(''); }} placeholder={webDavConfig?.hasPassword ? '已保存，留空则不修改' : '输入 WebDAV 应用密码'} autoComplete="new-password" /></label>
          </div>
          <div className="webdav-actions">
            <button className="secondary-button" disabled={webDavBusy || !webDavConfig?.supported} onClick={() => void saveWebDav()}><Save size={15} /><span>保存</span></button>
            <button className="secondary-button" disabled={webDavBusy || !webDavConfig?.supported} onClick={testWebDav}><Network size={15} /><span>测试连接</span></button>
            <button className="secondary-button" disabled={webDavBusy || !webDavConfig?.enabled} onClick={syncWebDav}>{webDavBusy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}<span>立即同步</span></button>
          </div>
          <p className={/成功|已同步|已保存|已合并/.test(webDavStatus) ? 'proxy-status success' : 'proxy-status'}>
            {webDavStatus || (webDavConfig?.lastSyncAt ? `上次同步：${formatAiring(webDavConfig.lastSyncAt)}` : '密码保存在系统安全存储中，不会写入追番数据文件。')}
          </p>
        </div>
      </section>
      {IS_ORIGINAL_EDITION ? (
        <section className="settings-section">
          <div className="settings-title"><Languages size={20} /><div><h2>番名显示</h2><p>界面保持中文，番剧标题直接使用 AniList 提供的原始名称。</p></div></div>
          <SettingRow title="首选标题" description="首选语言缺失时会自动使用其他可用标题">
            <label className="number-select">
              <select value={state.settings.titlePreference} onChange={(event) => onChange({ titlePreference: event.target.value as AppSettings['titlePreference'] })}>
                <option value="auto">自动（英文优先）</option>
                <option value="english">英文</option>
                <option value="romaji">罗马字</option>
                <option value="native">日本語</option>
              </select>
            </label>
          </SettingRow>
        </section>
      ) : (
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
      )}
      {isAndroid ? (
        <section className="settings-section">
          <div className="settings-title"><MonitorDot size={20} /><div><h2>Android 后台</h2><p>系统定期校正日程，播出时发送普通通知。</p></div></div>
          <SettingRow title="后台方式" description="不常驻进程，不创建系统闹钟条目">
            <span className="fixed-setting-value">系统调度</span>
          </SettingRow>
        </section>
      ) : (
        <section className="settings-section">
          <div className="settings-title"><MonitorDot size={20} /><div><h2>桌面行为</h2><p>控制应用启动与后台驻留方式。</p></div></div>
          <SettingRow title="开机后启动" description={state.runtime?.isDesktop ? '登录 Windows 后自动运行 AniLog' : '仅桌面应用支持此设置'}>
            <Toggle checked={state.settings.launchAtLogin} disabled={!state.runtime?.isDesktop} onChange={(value) => onChange({ launchAtLogin: value })} />
          </SettingRow>
          <SettingRow title="关闭时驻留托盘" description="继续在后台同步并发送更新提醒">
            <Toggle checked={state.settings.minimizeToTray} disabled={!state.runtime?.isDesktop} onChange={(value) => onChange({ minimizeToTray: value })} />
          </SettingRow>
        </section>
      )}
      {!isAndroid && <section className="settings-section">
        <div className="settings-title"><HardDrive size={20} /><div><h2>缓存空间</h2><p>封面与网络数据可按需重新下载，不包含追番记录和观看任务。</p></div></div>
        <SettingRow title="图片与网络缓存" description={cacheStatus || (IS_ORIGINAL_EDITION ? '季度列表和本地记录会保留' : '季度列表、中文标题和本地记录会保留')}>
          <div className="cache-actions">
            <strong>{cacheSupported === false ? '仅桌面端' : cacheBytes === null ? '正在计算' : formatStorageSize(cacheBytes)}</strong>
            <button className="secondary-button" disabled={clearingCache || cacheBytes === null || cacheSupported === false} onClick={clearCache}>
              {clearingCache ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}
              <span>清理缓存</span>
            </button>
          </div>
        </SettingRow>
      </section>}
      <section className="settings-section source-note">
        <SlidersHorizontal size={20} />
        <div><h2>数据与隐私</h2><p>{IS_ORIGINAL_EDITION ? '番剧、标题与播出日程均来自 AniList，不连接 Bangumi 或第三方 Bangumi 反代。默认仅保存在本机；启用 WebDAV 后，只向你配置的服务器同步追番和观看任务。' : '番剧与播出日程来自 AniList，中文标题来自 Bangumi。默认仅保存在本机；启用 WebDAV 后，只向你配置的服务器同步追番和观看任务。'}</p><small>AniList 上次同步：{state.lastSyncAt ? formatAiring(state.lastSyncAt) : '尚未同步'}</small></div>
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

function Toggle({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <button className={`toggle ${checked ? 'on' : ''}`} disabled={disabled} role="switch" aria-checked={checked} onClick={() => onChange(!checked)}><span /></button>;
}

function EmptyState({ icon: Icon, title, body, action, onAction }: { icon: typeof Search; title: string; body: string; action?: string; onAction?: () => void }) {
  return (
    <div className="empty-state"><span><Icon size={27} /></span><h3>{title}</h3><p>{body}</p>{action && <button className="secondary-button" onClick={onAction}>{action}</button>}</div>
  );
}

export default App;
