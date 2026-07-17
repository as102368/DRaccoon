const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 工具
  pathJoin: (...segments) => ipcRenderer.invoke('path:join', segments),
  pathJoinSync: (...segments) => ipcRenderer.sendSync('path:join-sync', segments),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:writeText', text),

  // 窗口控制
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  restartApp: () => ipcRenderer.invoke('app:restart'),

  // 设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),

  // 目录
  selectFolder: () => ipcRenderer.invoke('folder:select'),
  openFolder: (dirPath) => ipcRenderer.invoke('folder:open', dirPath),

  // 档案
  listArchive: (dirPath) => ipcRenderer.invoke('archive:list', dirPath),
  getArchiveStatus: (payload) => ipcRenderer.invoke('archive:status', payload),
  deleteArchive: (dirPath) => ipcRenderer.invoke('archive:delete', dirPath),
  openVideo: (filePath) => ipcRenderer.invoke('video:open', filePath),

  // 下载
  startDownload: (payload) => ipcRenderer.invoke('download:start', payload),
  cancelDownload: (taskId) => ipcRenderer.invoke('download:cancel', taskId),

  // 同步
  startSync: (payload) => ipcRenderer.invoke('sync:start', payload),
  cancelSync: (syncId) => ipcRenderer.invoke('sync:cancel', syncId),
  getSyncCache: (kind) => ipcRenderer.invoke('sync:get', kind),
  clearSyncCache: (kind) => ipcRenderer.invoke('sync:clear', kind),
  saveSyncCache: (kind, data) => ipcRenderer.invoke('sync:save', kind, data),

  // 博主作品列表
  startUserWorks: (payload) => ipcRenderer.invoke('userWorks:start', payload),
  cancelUserWorks: (taskId) => ipcRenderer.invoke('userWorks:cancel', taskId),

  // 新发布
  startNewReleases: (payload) => ipcRenderer.invoke('newReleases:start', payload),
  cancelNewReleases: (taskId) => ipcRenderer.invoke('newReleases:cancel', taskId),

  // 登录
  validateCookie: (cookieString) => ipcRenderer.invoke('auth:validate', cookieString),
  loginWithBrowser: () => ipcRenderer.invoke('auth:loginWithBrowser'),

  // 批量关注/取关
  startRelation: (payload) => ipcRenderer.invoke('relation:start', payload),
  cancelRelation: (taskId) => ipcRenderer.invoke('relation:cancel', taskId),

  // 报表导出
  exportReport: (payload) => ipcRenderer.invoke('report:export', payload),
  cancelReport: (taskId) => ipcRenderer.invoke('report:cancel', taskId),

  // 云同步
  backupCloud: (payload) => ipcRenderer.invoke('cloud:backup', payload),
  restoreCloud: (payload) => ipcRenderer.invoke('cloud:restore', payload),
  cancelCloud: (taskId) => ipcRenderer.invoke('cloud:cancel', taskId),

  // 全局快捷键
  onShortcutTriggered: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('shortcut:triggered', listener);
    return () => ipcRenderer.removeListener('shortcut:triggered', listener);
  },

  // 事件监听：下载
  onDownloadProgress: (callback) => makeListener('download:progress', callback),
  onDownloadLog: (callback) => makeListener('download:log', callback),
  onDownloadFinished: (callback) => makeListener('download:finished', callback),

  // 事件监听：同步
  onSyncProgress: (callback) => makeListener('sync:progress', callback),
  onSyncLog: (callback) => makeListener('sync:log', callback),
  onSyncFinished: (callback) => makeListener('sync:finished', callback),

  // 事件监听：批量关注/取关
  onRelationProgress: (callback) => makeListener('relation:progress', callback),
  onRelationLog: (callback) => makeListener('relation:log', callback),
  onRelationFinished: (callback) => makeListener('relation:finished', callback),

  // 事件监听：报表导出
  onReportProgress: (callback) => makeListener('report:progress', callback),
  onReportLog: (callback) => makeListener('report:log', callback),
  onReportFinished: (callback) => makeListener('report:finished', callback),

  // 事件监听：云同步
  onCloudProgress: (callback) => makeListener('cloud:progress', callback),
  onCloudLog: (callback) => makeListener('cloud:log', callback),
  onCloudFinished: (callback) => makeListener('cloud:finished', callback),

  // 事件监听：博主作品列表
  onUserWorksProgress: (callback) => makeListener('userWorks:progress', callback),
  onUserWorksLog: (callback) => makeListener('userWorks:log', callback),
  onUserWorksFinished: (callback) => makeListener('userWorks:finished', callback),

  // 事件监听：新发布
  onNewReleasesProgress: (callback) => makeListener('newReleases:progress', callback),
  onNewReleasesLog: (callback) => makeListener('newReleases:log', callback),
  onNewReleasesFinished: (callback) => makeListener('newReleases:finished', callback),
});

function makeListener(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
