const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 窗口控制
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),

  // 设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),

  // 目录
  selectFolder: () => ipcRenderer.invoke('folder:select'),
  openFolder: (dirPath) => ipcRenderer.invoke('folder:open', dirPath),

  // 档案
  listArchive: (dirPath) => ipcRenderer.invoke('archive:list', dirPath),
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

  // 字幕生成
  startTranscript: (payload) => ipcRenderer.invoke('transcript:start', payload),
  cancelTranscript: (taskId) => ipcRenderer.invoke('transcript:cancel', taskId),

  // 云同步
  backupCloud: (payload) => ipcRenderer.invoke('cloud:backup', payload),
  restoreCloud: (payload) => ipcRenderer.invoke('cloud:restore', payload),
  cancelCloud: (taskId) => ipcRenderer.invoke('cloud:cancel', taskId),

  // 全局快捷键
  onShortcutTriggered: (callback) =>
    ipcRenderer.on('shortcut:triggered', (_event, payload) => callback(payload)),

  // 事件监听：下载
  onDownloadProgress: (callback) =>
    ipcRenderer.on('download:progress', (_event, payload) => callback(payload)),
  onDownloadLog: (callback) =>
    ipcRenderer.on('download:log', (_event, payload) => callback(payload)),
  onDownloadFinished: (callback) =>
    ipcRenderer.on('download:finished', (_event, payload) => callback(payload)),

  // 事件监听：同步
  onSyncProgress: (callback) =>
    ipcRenderer.on('sync:progress', (_event, payload) => callback(payload)),
  onSyncLog: (callback) =>
    ipcRenderer.on('sync:log', (_event, payload) => callback(payload)),
  onSyncFinished: (callback) =>
    ipcRenderer.on('sync:finished', (_event, payload) => callback(payload)),

  // 事件监听：批量关注/取关
  onRelationProgress: (callback) =>
    ipcRenderer.on('relation:progress', (_event, payload) => callback(payload)),
  onRelationLog: (callback) =>
    ipcRenderer.on('relation:log', (_event, payload) => callback(payload)),
  onRelationFinished: (callback) =>
    ipcRenderer.on('relation:finished', (_event, payload) => callback(payload)),

  // 事件监听：报表导出
  onReportProgress: (callback) =>
    ipcRenderer.on('report:progress', (_event, payload) => callback(payload)),
  onReportLog: (callback) =>
    ipcRenderer.on('report:log', (_event, payload) => callback(payload)),
  onReportFinished: (callback) =>
    ipcRenderer.on('report:finished', (_event, payload) => callback(payload)),

  // 事件监听：字幕生成
  onTranscriptProgress: (callback) =>
    ipcRenderer.on('transcript:progress', (_event, payload) => callback(payload)),
  onTranscriptLog: (callback) =>
    ipcRenderer.on('transcript:log', (_event, payload) => callback(payload)),
  onTranscriptFinished: (callback) =>
    ipcRenderer.on('transcript:finished', (_event, payload) => callback(payload)),

  // 事件监听：云同步
  onCloudProgress: (callback) =>
    ipcRenderer.on('cloud:progress', (_event, payload) => callback(payload)),
  onCloudLog: (callback) =>
    ipcRenderer.on('cloud:log', (_event, payload) => callback(payload)),
  onCloudFinished: (callback) =>
    ipcRenderer.on('cloud:finished', (_event, payload) => callback(payload)),

  // 事件监听：博主作品列表
  onUserWorksProgress: (callback) =>
    ipcRenderer.on('userWorks:progress', (_event, payload) => callback(payload)),
  onUserWorksLog: (callback) =>
    ipcRenderer.on('userWorks:log', (_event, payload) => callback(payload)),
  onUserWorksFinished: (callback) =>
    ipcRenderer.on('userWorks:finished', (_event, payload) => callback(payload)),

  // 事件监听：新发布
  onNewReleasesProgress: (callback) =>
    ipcRenderer.on('newReleases:progress', (_event, payload) => callback(payload)),
  onNewReleasesLog: (callback) =>
    ipcRenderer.on('newReleases:log', (_event, payload) => callback(payload)),
  onNewReleasesFinished: (callback) =>
    ipcRenderer.on('newReleases:finished', (_event, payload) => callback(payload)),
});
