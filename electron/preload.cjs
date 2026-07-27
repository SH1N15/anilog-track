const { contextBridge, ipcRenderer } = require('electron');

const isOriginalEdition = process.argv.includes('--anilog-edition=original');
const openTasksListeners = new Set();
let openTasksPending = false;
ipcRenderer.on('tasks:open', () => {
  if (openTasksListeners.size === 0) openTasksPending = true;
  openTasksListeners.forEach((listener) => listener());
});
const desktopApi = {
  getState: () => ipcRenderer.invoke('state:get'),
  fetchSeason: (params) => ipcRenderer.invoke('season:fetch', params),
  toggleFollow: (anime) => ipcRenderer.invoke('follow:toggle', anime),
  updateFollowTitle: (animeId, displayTitle) => ipcRenderer.invoke('follow:title', { animeId, displayTitle }),
  toggleTask: (taskId) => ipcRenderer.invoke('task:toggle', taskId),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  getCacheInfo: () => ipcRenderer.invoke('cache:get'),
  clearCache: () => ipcRenderer.invoke('cache:clear'),
  getWebDavConfig: () => ipcRenderer.invoke('webdav:get-config'),
  saveWebDavConfig: (config) => ipcRenderer.invoke('webdav:save-config', config),
  testWebDavConnection: () => ipcRenderer.invoke('webdav:test'),
  syncWebDav: () => ipcRenderer.invoke('webdav:sync'),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  onStateChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('state:changed', listener);
    return () => ipcRenderer.removeListener('state:changed', listener);
  },
  onSeasonUpdated: (callback) => {
    const listener = (_event, update) => callback(update);
    ipcRenderer.on('season:updated', listener);
    return () => ipcRenderer.removeListener('season:updated', listener);
  },
  onOpenTasks: (callback) => {
    openTasksListeners.add(callback);
    if (openTasksPending) {
      openTasksPending = false;
      queueMicrotask(callback);
    }
    return () => openTasksListeners.delete(callback);
  },
};

if (!isOriginalEdition) {
  desktopApi.resolveBangumiTitle = (anime) => ipcRenderer.invoke('bangumi:resolve-title', anime);
  desktopApi.testBangumiConnection = (baseUrl) => ipcRenderer.invoke('bangumi:test-connection', baseUrl);
}

contextBridge.exposeInMainWorld('animeTracker', desktopApi);
