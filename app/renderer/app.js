const { createApp, ref, computed, reactive, provide, inject, watch, onMounted, onUnmounted, nextTick } = Vue;

function generateAvatar(name) {
  const colors = ['#1fb7d6', '#2dd36f', '#ff4d6d', '#a78bfa', '#f59e0b', '#38bdf8'];
  const color = colors[(name || '').length % colors.length];
  const initial = (name || 'U').charAt(0).toUpperCase();
  const svg = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="${encodeURIComponent(color)}"/><text x="50" y="68" font-size="45" fill="white" text-anchor="middle" font-family="Arial">${initial}</text></svg>`;
  return svg;
}

function formatTimeLabel(iso) {
  if (!iso) return '从未';
  const d = new Date(iso);
  const now = new Date();
  const diff = Math.floor((now - d) / 60000);
  if (diff < 1) return '刚刚';
  if (diff < 60) return `${diff} 分钟前`;
  if (diff < 1440) return `${Math.floor(diff / 60)} 小时前`;
  if (diff < 43200) return `${Math.floor(diff / 1440)} 天前`;
  return d.toLocaleDateString();
}

function extractSecUidFromUrl(url) {
  if (!url) return null;
  const m = url.match(/\/user\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function awemeUrl(awemeId) {
  return `https://www.douyin.com/video/${awemeId}`;
}

function formatFileSize(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function formatDownloadLog(line) {
  if (typeof line !== 'string' || !line.trim().startsWith('{')) return line;
  try {
    const data = JSON.parse(line);
    const event = data.event;
    if (event === 'log') {
      const level = data.level || 'info';
      const msg = data.message || '';
      if (level === 'error') return `[错误] ${msg}`;
      if (level === 'warn') return `[警告] ${msg}`;
      return `[信息] ${msg}`;
    }
    if (event === 'step') {
      const step = data.step || '';
      const detail = data.detail || '';
      return `[步骤] ${step}${detail ? '：' + detail : ''}`;
    }
    if (event === 'url_start') {
      return `[开始] 处理第 ${data.index || 1}/${data.total || 1} 个链接`;
    }
    if (event === 'url_result') {
      return `[完成] 成功 ${data.success || 0} / 失败 ${data.failed || 0} / 跳过 ${data.skipped || 0}`;
    }
    if (event === 'item_advanced') {
      const statusMap = { success: '成功', failed: '失败', skipped: '跳过' };
      const status = statusMap[data.status] || data.status || '未知';
      return `[${status}] ${data.detail || ''}`;
    }
    if (event === 'author') {
      return `[识别] 博主：${data.nickname || '未知'}`;
    }
    if (event === 'title') {
      return `[识别] 作品：${data.title || '未知'}`;
    }
    return line;
  } catch (e) {
    return line;
  }
}

// Electron IPC 的结构化克隆无法序列化 Vue reactive proxy，传给主进程前统一深拷贝为普通对象
function plain(obj) {
  if (obj === undefined || obj === null) return obj;
  return JSON.parse(JSON.stringify(obj));
}

function translateFilenameTemplate(template) {
  return template
    .replace(/\{日期\}/g, '{date}')
    .replace(/\{年份\}/g, '{year}')
    .replace(/\{月份\}/g, '{month}')
    .replace(/\{日\}/g, '{day}')
    .replace(/\{发布时间\}/g, '{time}')
    .replace(/\{时\}/g, '{hour}')
    .replace(/\{分\}/g, '{minute}')
    .replace(/\{秒\}/g, '{second}')
    .replace(/\{时间戳\}/g, '{timestamp}')
    .replace(/\{作者昵称\}/g, '{author}')
    .replace(/\{作者ID\}/g, '{author_id}')
    .replace(/\{作品标题\}/g, '{title}')
    .replace(/\{作品ID\}/g, '{id}')
    .replace(/\{作品类型\}/g, '{type}')
    .replace(/\{下载模式\}/g, '{mode}');
}

// 统一图标库（Feather 风格线框图标）
const icons = {
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>',
  bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>',
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>',
  more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
  winMinimize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>',
  winMaximize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect></svg>',
  winRestore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path></svg>',
  winClose: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>',
  fileText: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>',
  cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path></svg>',
  archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>',
};

const defaultSettings = {
  outputPath: '',
  cookieString: '',
  thread: 5,
  retryTimes: 3,
  proxy: '',
  cover: true,
  music: true,
  avatar: true,
  downloadImages: true,
  downloadLivePhotos: true,
  database: true,
  folderstyle: false,
  filenameTemplate: '{日期}_{标题}',
  videoQuality: 'highest',
  syncLimits: {
    favorites: 1000,
    collections: 200,
    likes: 1000,
    following: 2000,
    newReleasesAuthors: 200,
    newReleasesPerAuthor: 30,
  },
  retention: 'forever',
  theme: 'dark',
  pythonPath: '',
  shortcuts: {
    enabled: true,
    pasteDownload: 'Ctrl+Shift+V',
    toggleWindow: 'Ctrl+Shift+D',
    pauseAll: 'Ctrl+Shift+P',
  },
  relation: {
    minDelay: 2.0,
    maxDelay: 4.0,
    dryRun: false,
  },
  browserFallback: {
    enabled: true,
    headless: false,
    maxScrolls: 500,
  },
  transcript: {
    enabled: false,
    mode: 'api',
    apiKey: '',
    model: 'gpt-4o-mini-transcribe',
    formats: ['srt', 'txt'],
    language: 'zh',
  },
  cloudSync: {
    enabled: false,
    provider: '',
    accessKeyId: '',
    accessKeySecret: '',
    bucket: '',
    region: '',
    endpoint: '',
  },
};

const store = reactive({
  settings: { ...defaultSettings },
  tasks: [],
  archive: [],
  syncs: [],
  relationTasks: [],
  reportTasks: [],
  transcriptTasks: [],
  cloudTasks: [],
  userWorks: [],
  newReleases: {
    status: 'idle',
    taskId: null,
    items: [],
    progress: {},
    logs: [],
    error: '',
  },
  syncCache: {
    favorites: null,
    likes: null,
    following: null,
  },
  currentPage: 'downloads',
  initialized: false,
  authChecked: false,
  effectiveTheme: 'dark',
  user: {
    isLoggedIn: false,
    nickname: '',
    avatar: '',
    sec_uid: '',
    unique_id: '',
  },
});

store.applyTheme = () => {
  store.effectiveTheme = 'dark';
  document.documentElement.setAttribute('data-theme', 'dark');
};

store.loadSettings = async () => {
  const s = await window.electronAPI.getSettings();
  store.settings = { ...defaultSettings, ...s };
  if (store.settings.filenameTemplate === undefined || store.settings.filenameTemplate === null || store.settings.filenameTemplate === '') {
    store.settings.filenameTemplate = defaultSettings.filenameTemplate;
  }
  if (!store.settings.syncLimits) store.settings.syncLimits = { ...defaultSettings.syncLimits };
  if (!store.settings.shortcuts) store.settings.shortcuts = { ...defaultSettings.shortcuts };
  if (!store.settings.relation) store.settings.relation = { ...defaultSettings.relation };
  if (!store.settings.browserFallback) store.settings.browserFallback = { ...defaultSettings.browserFallback };
  if (!store.settings.transcript) store.settings.transcript = { ...defaultSettings.transcript };
  if (!store.settings.cloudSync) store.settings.cloudSync = { ...defaultSettings.cloudSync };
  // 如果 cookie 已被旧版本的脱敏逻辑破坏，清空避免使用无效值校验
  if (typeof store.settings.cookieString === 'string' && store.settings.cookieString.includes('***')) {
    store.settings.cookieString = '';
  }
  store.applyTheme(store.settings.theme);
  store.initialized = true;
  await store.checkAuth();
  if (store.user.isLoggedIn) {
    store.loadArchive();
    store.loadSyncCache('favorites');
    store.loadSyncCache('likes');
    store.loadSyncCache('following');
  }
};

store.checkAuth = async () => {
  const cookie = store.settings.cookieString || '';
  if (!cookie.trim()) {
    store.user = { isLoggedIn: false, nickname: '', avatar: '', sec_uid: '', unique_id: '' };
    store.authChecked = true;
    return;
  }
  try {
    const result = await window.electronAPI.validateCookie(cookie);
    if (result.valid && result.user) {
      store.user = { ...result.user, isLoggedIn: true };
    } else {
      store.user = { isLoggedIn: false, nickname: '', avatar: '', sec_uid: '', unique_id: '' };
    }
  } catch (e) {
    store.user = { isLoggedIn: false, nickname: '', avatar: '', sec_uid: '', unique_id: '' };
  }
  store.authChecked = true;
};

store.login = async (cookieString) => {
  store.settings.cookieString = cookieString;
  await store.saveSettings();
  await store.checkAuth();
  return store.user.isLoggedIn;
};

store.loginWithBrowser = async () => {
  if (!window.electronAPI || !window.electronAPI.loginWithBrowser) {
    return { success: false, reason: '当前环境不支持内置浏览器登录' };
  }
  const result = await window.electronAPI.loginWithBrowser();
  if (result.success && result.cookieString) {
    store.settings.cookieString = result.cookieString;
    await store.saveSettings();
    await store.checkAuth();
    if (store.user.isLoggedIn) {
      await store.loadArchive();
      await store.loadSyncCache('favorites');
      await store.loadSyncCache('likes');
      await store.loadSyncCache('following');
    }
  }
  return result;
};

store.logout = async () => {
  store.settings.cookieString = '';
  store.user = { isLoggedIn: false, nickname: '', avatar: '', sec_uid: '', unique_id: '' };
  await store.saveSettings();
};

store.saveSettings = async () => {
  // Vue reactive proxy cannot be cloned across IPC; send a plain object
  await window.electronAPI.setSettings(Vue.toRaw ? Vue.toRaw(store.settings) : JSON.parse(JSON.stringify(store.settings)));
};

store.buildConfig = () => {
  // Vue reactive proxy objects cannot be cloned across IPC; convert to raw plain object
  const s = Vue.toRaw ? Vue.toRaw(store.settings) : JSON.parse(JSON.stringify(store.settings));
  return {
    path: s.outputPath,
    thread: s.thread,
    retry_times: s.retryTimes,
    proxy: s.proxy,
    cover: s.cover,
    music: s.music,
    avatar: s.avatar,
    download_images: s.downloadImages,
    download_live_photos: s.downloadLivePhotos,
    json: false,
    database: s.database,
    database_path: s.outputPath ? s.outputPath + '\\dy_downloader.db' : 'dy_downloader.db',
    folderstyle: false,
    filename_template: translateFilenameTemplate(s.filenameTemplate || '{日期}_{标题}'),
    folder_template: '{title}_{id}',
    author_dir: 'nickname',
    group_by_mode: false,
    write_media_metadata: false,
    download_manifest: false,
    download_pinned: false,
    video_quality: s.videoQuality,
    progress: { quiet_logs: true },
    browser_fallback: {
      enabled: Boolean(s.browserFallback?.enabled),
      headless: Boolean(s.browserFallback?.headless),
      max_scrolls: Math.max(50, parseInt(s.browserFallback?.maxScrolls, 10) || 500),
      idle_rounds: 12,
      wait_timeout_seconds: 600,
    },
    number: { post: 0, like: 0, mix: 0, allmix: 0, collect: 0, collectmix: 0, music: 0 },
  };
};

// ========== 下载任务 ==========
store.startTask = (urls, name) => {
  if (!Array.isArray(urls)) urls = [urls];
  urls = urls.map(u => String(u).trim()).filter(Boolean);
  if (urls.length === 0) return null;
  const id = 'task-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const task = reactive({
    id,
    name: name || urls[0],
    urls,
    status: 'running',
    progress: 0,
    step: '等待开始',
    total: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    logs: [],
    createdAt: new Date().toLocaleString(),
  });
  store.tasks.unshift(task);
  window.electronAPI.startDownload({
    taskId: id,
    urls,
    config: plain(store.buildConfig()),
    cookies: store.settings.cookieString,
  });
  return id;
};

store.cancelTask = (id) => {
  const task = store.tasks.find(t => t.id === id);
  if (task && task.status === 'running') {
    task.status = 'cancelling';
    window.electronAPI.cancelDownload(id);
  }
};

store.onProgress = (payload) => {
  const { taskId, data } = payload;
  const task = store.tasks.find(t => t.id === taskId);
  if (!task) return;
  const firstUrl = task.urls[0] || '';
  if (data.event === 'url_start') {
    task.step = `正在处理 ${data.index}/${data.total}`;
    task.logs.push(`[开始] 处理第 ${data.index || 1}/${data.total || 1} 个链接`);
  } else if (data.event === 'step') {
    task.step = data.detail ? `${data.step}：${data.detail}` : data.step;
    task.logs.push(`[步骤] ${data.step}${data.detail ? '：' + data.detail : ''}`);
  } else if (data.event === 'item_total') {
    task.total = data.total;
    task.progress = 0;
    task.logs.push(`[进度] 共 ${data.total} 个作品待下载`);
  } else if (data.event === 'item_advanced') {
    if (task.total > 0) {
      const done = task.success + task.failed + task.skipped + 1;
      task.progress = Math.min(100, Math.round((done / task.total) * 100));
    }
    const statusMap = { success: '成功', failed: '失败', skipped: '跳过' };
    const statusText = statusMap[data.status] || data.status || '未知';
    if (data.status === 'success') task.success++;
    else if (data.status === 'failed') task.failed++;
    else if (data.status === 'skipped') task.skipped++;
    task.logs.push(`[${statusText}] ${data.detail || ''}`);
  } else if (data.event === 'url_result') {
    task.total += data.total || 0;
    task.success += data.success || 0;
    task.failed += data.failed || 0;
    task.skipped += data.skipped || 0;
    task.logs.push(`[完成] 成功 ${data.success || 0} / 失败 ${data.failed || 0} / 跳过 ${data.skipped || 0}`);
  } else if (data.event === 'url_error') {
    const msg = data.message || '链接处理失败';
    if (!task.step || !task.step.includes('失败')) {
      task.step = `失败：${msg}`;
    }
    task.logs.push(`[错误] ${msg}`);
  } else if (data.event === 'author') {
    if (extractSecUidFromUrl(firstUrl) && data.nickname) {
      task.name = `${data.nickname} 的主页`;
    }
    task.logs.push(`[识别] 博主：${data.nickname || '未知'}`);
  } else if (data.event === 'title') {
    if ((/\/video\/\d+/.test(firstUrl) || /v\.douyin\.com|v\.iesdouyin\.com/.test(firstUrl)) && data.title) {
      task.name = data.title;
    }
    task.logs.push(`[识别] 作品：${data.title || '未知'}`);
  } else if (data.event === 'log') {
    task.logs.push(formatDownloadLog(data.message || ''));
  }
};

store.onLog = (payload) => {
  const { taskId, line } = payload;
  const task = store.tasks.find(t => t.id === taskId);
  if (task) task.logs.push(formatDownloadLog(line));
};

store.onFinished = (payload) => {
  const { taskId, code } = payload;
  const task = store.tasks.find(t => t.id === taskId);
  if (!task) return;
  if (task.status === 'cancelling') {
    task.status = 'cancelled';
  } else if (code === 0 && task.failed === 0) {
    task.status = 'success';
  } else {
    task.status = 'error';
  }
  if (!task.step || !task.step.includes('失败')) {
    task.step = task.status === 'success' ? '已完成' : `结束（code=${code}）`;
  }
  store.loadArchive();
};

// ========== 同步任务 ==========
store.startSync = (kind) => {
  const id = 'sync-' + kind + '-' + Date.now();
  const sync = reactive({
    id,
    kind,
    status: 'running',
    step: '初始化',
    progress: 0,
    total: 0,
    added: 0,
    logs: [],
    createdAt: new Date().toLocaleString(),
  });
  store.syncs.unshift(sync);
  window.electronAPI.startSync({
    syncId: id,
    kind,
    config: plain(store.buildConfig()),
    cookies: store.settings.cookieString,
    limits: plain(store.settings.syncLimits),
  });
  return id;
};

store.cancelSync = (id) => {
  const sync = store.syncs.find(s => s.id === id);
  if (sync && sync.status === 'running') {
    sync.status = 'cancelling';
    window.electronAPI.cancelSync(id);
  }
};

store.onSyncProgress = (payload) => {
  const { syncId, data } = payload;
  const sync = store.syncs.find(s => s.id === syncId);
  if (!sync) return;
  if (data.event === 'sync_start') {
    sync.step = '开始同步';
    sync.total = data.limit || 0;
    sync.added = 0;
  } else if (data.event === 'sync_progress') {
    if (data.kind === 'favorites_collections') {
      sync.step = `同步收藏夹列表：${data.total}`;
    } else if (data.kind === 'collect_mixes') {
      sync.step = `同步合集列表：${data.total}`;
    } else if (data.kind === 'favorites_items' || data.kind === 'likes' || data.kind === 'following') {
      let step = `已拉取 ${data.total} 条`;
      if (data.status_code && Number(data.status_code) !== 0) {
        step += ` (接口状态 ${data.status_code}${data.status_msg ? ': ' + data.status_msg : ''})`;
      }
      sync.step = step;
      sync.added = data.total || sync.added;
      if (sync.total > 0) sync.progress = Math.min(100, Math.round((sync.added / sync.total) * 100));
    } else if (data.kind === 'favorites_collection_items' || data.kind === 'collect_mix_items') {
      sync.step = `同步「${data.collection || data.collection_id}」${data.total ? data.total + ' 条' : ''}`;
      sync.added = data.total || sync.added;
      if (sync.total > 0) sync.progress = Math.min(100, Math.round((sync.added / sync.total) * 100));
    } else if (data.collection) {
      sync.step = `同步收藏夹「${data.collection}」`;
    }
  } else if (data.event === 'sync_done') {
    sync.step = '同步完成';
    sync.progress = 100;
  } else if (data.event === 'sync_error') {
    sync.step = `错误：${data.message}`;
  }
};

store.onSyncLog = (payload) => {
  const { syncId, line } = payload;
  const sync = store.syncs.find(s => s.id === syncId);
  if (sync) sync.logs.push(line);
};

store.onSyncFinished = async (payload) => {
  const { syncId, code, kind } = payload;
  const sync = store.syncs.find(s => s.id === syncId);
  if (!sync) return;
  const hadError = sync.step && String(sync.step).startsWith('错误：');
  if (sync.status === 'cancelling') {
    sync.status = 'cancelled';
    sync.step = '已取消';
  } else if (code === 0 && !hadError) {
    sync.status = 'success';
    sync.step = '同步完成';
  } else {
    sync.status = 'error';
    if (!hadError) sync.step = `同步失败（code=${code}）`;
  }
  await store.loadSyncCache(kind);
};

store.loadSyncCache = async (kind) => {
  const cache = await window.electronAPI.getSyncCache(kind);
  store.syncCache[kind] = cache;
  return cache;
};

store.clearSyncCache = async (kind) => {
  const ok = await window.electronAPI.clearSyncCache(kind);
  if (ok) store.syncCache[kind] = null;
  return ok;
};

// ========== 博主作品列表任务 ==========
store.startUserWorks = (secUid, nickname) => {
  const id = 'userWorks-' + secUid + '-' + Date.now();
  const task = reactive({
    id,
    secUid,
    nickname: nickname || secUid,
    status: 'running',
    progress: 0,
    total: 0,
    items: [],
    step: '准备中',
    logs: [],
    createdAt: new Date().toLocaleString(),
  });
  store.userWorks.unshift(task);
  window.electronAPI.startUserWorks({
    taskId: id,
    secUid,
    nickname: nickname || secUid,
    cookies: store.settings.cookieString,
    limit: store.settings.syncLimits.following || 200,
    proxy: store.settings.proxy || '',
  });
  return id;
};

store.cancelUserWorks = (id) => {
  const task = store.userWorks.find(t => t.id === id);
  if (task && task.status === 'running') {
    task.status = 'cancelling';
    window.electronAPI.cancelUserWorks(id);
  }
};

store.onUserWorksProgress = (payload) => {
  const { taskId, data } = payload;
  const task = store.userWorks.find(t => t.id === taskId);
  if (!task) return;
  if (data.event === 'start') {
    task.step = '开始获取作品';
    task.total = data.limit || 0;
  } else if (data.event === 'progress') {
    task.step = data.message ? `正在获取：${data.message}` : '正在获取作品';
    if (task.total > 0) {
      task.progress = Math.min(100, Math.round((data.current / task.total) * 100));
    }
  } else if (data.event === 'items') {
    task.items.push(...(data.items || []));
    task.total = data.total || task.total;
  } else if (data.event === 'done') {
    task.step = `共 ${data.total || task.items.length} 个作品`;
    task.progress = 100;
    if (data.items) task.items = data.items;
  } else if (data.event === 'log') {
    task.logs.push(data.message || '');
  }
};

store.onUserWorksLog = (payload) => {
  const { taskId, line } = payload;
  const task = store.userWorks.find(t => t.id === taskId);
  if (task) task.logs.push(line);
};

store.onUserWorksFinished = (payload) => {
  const { taskId, code } = payload;
  const task = store.userWorks.find(t => t.id === taskId);
  if (!task) return;
  if (task.status === 'cancelling') {
    task.status = 'cancelled';
    task.step = '已取消';
  } else if (code === 0) {
    task.status = 'success';
    if (!task.step || !task.step.includes('个作品')) {
      task.step = `共 ${task.items.length} 个作品`;
    }
  } else {
    task.status = 'error';
    task.step = `获取失败（code=${code}）`;
  }
};

// ========== 新发布任务 ==========
store.startNewReleases = () => {
  if (!store.user.isLoggedIn) return;
  if (store.newReleases.status === 'running') return;
  const id = 'newReleases-' + Date.now();
  store.newReleases.status = 'running';
  store.newReleases.taskId = id;
  store.newReleases.items = [];
  store.newReleases.progress = {};
  store.newReleases.logs = [];
  store.newReleases.error = '';
  window.electronAPI.startNewReleases({
    taskId: id,
    config: plain(store.buildConfig()),
    cookies: store.settings.cookieString,
    limits: plain(store.settings.syncLimits),
    proxy: store.settings.proxy || '',
  });
};

store.cancelNewReleases = () => {
  const id = store.newReleases.taskId;
  if (id && store.newReleases.status === 'running') {
    window.electronAPI.cancelNewReleases(id);
  }
};

store.onNewReleasesProgress = (payload) => {
  const { data } = payload;
  if (!data) return;
  if (data.event === 'start') {
    store.newReleases.progress = {
      current: 0,
      total: data.authors_total || 0,
      message: `开始检查 ${data.authors_total || 0} 位博主`,
    };
  } else if (data.event === 'progress') {
    store.newReleases.progress = {
      current: data.current_author_index || store.newReleases.progress.current || 0,
      total: data.total_authors || store.newReleases.progress.total || 0,
      message: data.message || '',
    };
  } else if (data.event === 'items') {
    store.newReleases.items.push(...(data.items || []));
    store.newReleases.progress.message = `已发现 ${store.newReleases.items.length} 个新作品`;
  } else if (data.event === 'done') {
    store.newReleases.status = 'done';
    store.newReleases.progress = {
      current: data.authors_checked || 0,
      total: data.authors_checked || 0,
      message: `检查完成，共 ${data.total || 0} 个新作品`,
    };
    if (data.items) store.newReleases.items = data.items;
  } else if (data.event === 'log') {
    store.newReleases.logs.push(data.message || '');
  }
};

store.onNewReleasesLog = (payload) => {
  const { line } = payload;
  if (line) store.newReleases.logs.push(line);
};

store.onNewReleasesFinished = (payload) => {
  const { code } = payload;
  if (store.newReleases.status === 'running') {
    store.newReleases.status = code === 0 ? 'done' : 'error';
    if (code !== 0) {
      store.newReleases.error = `检查失败（code=${code}）`;
    }
  }
};

// ========== 批量关注/取关任务 ==========
store.startRelationTask = (action, secUids) => {
  const id = 'relation-' + action + '-' + Date.now();
  const task = reactive({
    id,
    action,
    secUids,
    dryRun: store.settings.relation.dryRun,
    status: 'running',
    progress: 0,
    current: 0,
    total: secUids.length,
    step: '准备中',
    logs: [],
    createdAt: new Date().toLocaleString(),
  });
  store.relationTasks.unshift(task);
  window.electronAPI.startRelation({
    taskId: id,
    action,
    secUids,
    cookies: store.settings.cookieString,
    proxy: store.settings.proxy,
    config: plain(store.settings.relation),
  });
  return id;
};

store.cancelRelationTask = (id) => {
  const task = store.relationTasks.find(t => t.id === id);
  if (task && task.status === 'running') {
    task.status = 'cancelling';
    window.electronAPI.cancelRelation(id);
  }
};

store.onRelationProgress = (payload) => {
  const { taskId, data } = payload;
  const task = store.relationTasks.find(t => t.id === taskId);
  if (!task) return;
  if (data.event === 'progress') {
    task.current = data.current || 0;
    task.total = data.total || task.total;
    task.progress = task.total > 0 ? Math.round((task.current / task.total) * 100) : 0;
    task.step = data.message || `处理中 ${task.current}/${task.total}`;
  } else if (data.event === 'log') {
    task.logs.push(data.message);
  } else if (data.event === 'finished' && data.summary) {
    const summary = data.summary;
    task.summary = summary;
    if (task.status === 'cancelling') {
      task.status = 'cancelled';
      task.step = '已取消';
    } else if (data.success && summary.failed === 0) {
      task.status = 'success';
      task.step = '已完成';
      task.progress = 100;
    } else {
      task.status = 'error';
      task.step = `完成：成功 ${summary.success || 0} / 失败 ${summary.failed || 0} / 跳过 ${summary.skipped || 0}`;
      task.progress = 100;
    }
    // 只有真正取关成功（且非演练模式）的用户才标记为已取消关注
    if (task.action === 'unfollow' && !task.dryRun && Array.isArray(summary.results)) {
      const unfollowedSet = loadUnfollowedSet();
      let changed = false;
      summary.results.forEach(r => {
        if (r && r.success && r.sec_uid && !unfollowedSet.has(r.sec_uid)) {
          unfollowedSet.add(r.sec_uid);
          changed = true;
        }
      });
      if (changed) saveUnfollowedSet(unfollowedSet);
    }
  }
};

store.onRelationLog = (payload) => {
  const { taskId, line } = payload;
  const task = store.relationTasks.find(t => t.id === taskId);
  if (task) task.logs.push(line);
};

store.onRelationFinished = (payload) => {
  const { taskId, code } = payload;
  const task = store.relationTasks.find(t => t.id === taskId);
  if (!task) return;
  // stdout 的 finished 事件通常已先设置状态；避免覆盖
  if (task.summary) return;
  if (task.status === 'cancelling') {
    task.status = 'cancelled';
    task.step = '已取消';
  } else if (code === 0) {
    task.status = 'success';
    task.step = '已完成';
    task.progress = 100;
  } else {
    task.status = 'error';
    task.step = `失败（code=${code}）`;
  }
};

// ========== 报表导出任务 ==========
store.exportReport = (options) => {
  const id = 'report-' + Date.now();
  const task = reactive({
    id,
    status: 'running',
    progress: 0,
    step: '准备中',
    logs: [],
    result: null,
    createdAt: new Date().toLocaleString(),
  });
  store.reportTasks.unshift(task);
  window.electronAPI.exportReport({
    taskId: id,
    dbPath: options.dbPath || (store.settings.outputPath + '\\dy_downloader.db'),
    dateFrom: options.dateFrom,
    dateTo: options.dateTo,
    groupBy: options.groupBy,
    formats: options.formats,
    outputDir: options.outputDir,
  });
  return id;
};

store.cancelReport = (id) => {
  const task = store.reportTasks.find(t => t.id === id);
  if (task && task.status === 'running') {
    task.status = 'cancelling';
    window.electronAPI.cancelReport(id);
  }
};

store.onReportProgress = (payload) => {
  const { taskId, data } = payload;
  const task = store.reportTasks.find(t => t.id === taskId);
  if (!task) return;
  if (data.event === 'progress') {
    task.step = data.message || '导出中';
    if (data.current && data.total) {
      task.progress = Math.round((data.current / data.total) * 100);
    }
  } else if (data.event === 'finished' && data.files) {
    task.result = data.files;
    task.progress = 100;
  } else if (data.event === 'log') {
    task.logs.push(data.message);
  }
};

store.onReportLog = (payload) => {
  const { taskId, line } = payload;
  const task = store.reportTasks.find(t => t.id === taskId);
  if (task) task.logs.push(line);
};

store.onReportFinished = (payload) => {
  const { taskId, code } = payload;
  const task = store.reportTasks.find(t => t.id === taskId);
  if (!task) return;
  if (task.status === 'cancelling') {
    task.status = 'cancelled';
    task.step = '已取消';
  } else if (code === 0) {
    task.status = 'success';
    task.step = '导出完成';
    task.progress = 100;
  } else {
    task.status = 'error';
    task.step = `导出失败（code=${code}）`;
  }
};

// ========== 字幕生成任务 ==========
store.startTranscript = (videoPath, options) => {
  const id = 'transcript-' + Date.now();
  const task = reactive({
    id,
    videoPath,
    status: 'running',
    progress: 0,
    step: '准备中',
    logs: [],
    outputs: [],
    createdAt: new Date().toLocaleString(),
  });
  store.transcriptTasks.unshift(task);
  const cfg = plain(store.settings.transcript);
  window.electronAPI.startTranscript({
    taskId: id,
    videoPath,
    mode: options.mode || cfg.mode,
    apiKey: options.apiKey || cfg.apiKey,
    model: options.model || cfg.model,
    formats: options.formats || cfg.formats,
    language: options.language || cfg.language,
  });
  return id;
};

store.cancelTranscript = (id) => {
  const task = store.transcriptTasks.find(t => t.id === id);
  if (task && task.status === 'running') {
    task.status = 'cancelling';
    window.electronAPI.cancelTranscript(id);
  }
};

store.onTranscriptProgress = (payload) => {
  const { taskId, data } = payload;
  const task = store.transcriptTasks.find(t => t.id === taskId);
  if (!task) return;
  if (data.event === 'progress') {
    task.step = data.message || '生成中';
    if (data.current && data.total) {
      task.progress = Math.round((data.current / data.total) * 100);
    }
  } else if (data.event === 'finished' && data.outputs) {
    task.outputs = data.outputs;
    task.progress = 100;
  } else if (data.event === 'log') {
    task.logs.push(data.message);
  }
};

store.onTranscriptLog = (payload) => {
  const { taskId, line } = payload;
  const task = store.transcriptTasks.find(t => t.id === taskId);
  if (task) task.logs.push(line);
};

store.onTranscriptFinished = (payload) => {
  const { taskId, code } = payload;
  const task = store.transcriptTasks.find(t => t.id === taskId);
  if (!task) return;
  if (task.status === 'cancelling') {
    task.status = 'cancelled';
    task.step = '已取消';
  } else if (code === 0) {
    task.status = 'success';
    task.step = '字幕生成完成';
    task.progress = 100;
  } else {
    task.status = 'error';
    task.step = `生成失败（code=${code}）`;
  }
};

// ========== 云同步任务 ==========
store.backupCloud = () => {
  const id = 'cloud-backup-' + Date.now();
  const task = reactive({
    id,
    kind: 'backup',
    status: 'running',
    progress: 0,
    step: '准备中',
    logs: [],
    token: '',
    createdAt: new Date().toLocaleString(),
  });
  store.cloudTasks.unshift(task);
  const cfg = plain(store.settings.cloudSync);
  window.electronAPI.backupCloud({
    taskId: id,
    configPath: store.settings.outputPath + '\\config.yml',
    dbPath: store.settings.outputPath + '\\dy_downloader.db',
    cookiePath: '',
    provider: cfg.provider,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      accessKeySecret: cfg.accessKeySecret,
      bucket: cfg.bucket,
      region: cfg.region,
      endpoint: cfg.endpoint,
    },
  });
  return id;
};

store.restoreCloud = (token) => {
  const id = 'cloud-restore-' + Date.now();
  const task = reactive({
    id,
    kind: 'restore',
    status: 'running',
    progress: 0,
    step: '准备中',
    logs: [],
    createdAt: new Date().toLocaleString(),
  });
  store.cloudTasks.unshift(task);
  const cfg = plain(store.settings.cloudSync);
  window.electronAPI.restoreCloud({
    taskId: id,
    token,
    provider: cfg.provider,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      accessKeySecret: cfg.accessKeySecret,
      bucket: cfg.bucket,
      region: cfg.region,
      endpoint: cfg.endpoint,
    },
    outputDir: store.settings.outputPath,
  });
  return id;
};

store.cancelCloud = (id) => {
  const task = store.cloudTasks.find(t => t.id === id);
  if (task && task.status === 'running') {
    task.status = 'cancelling';
    window.electronAPI.cancelCloud(id);
  }
};

store.onCloudProgress = (payload) => {
  const { taskId, data } = payload;
  const task = store.cloudTasks.find(t => t.id === taskId);
  if (!task) return;
  if (data.event === 'progress') {
    task.step = data.message || '同步中';
    if (data.current && data.total) {
      task.progress = Math.round((data.current / data.total) * 100);
    }
  } else if (data.event === 'finished') {
    task.token = data.token || '';
    task.progress = 100;
  } else if (data.event === 'log') {
    task.logs.push(data.message);
  }
};

store.onCloudLog = (payload) => {
  const { taskId, line } = payload;
  const task = store.cloudTasks.find(t => t.id === taskId);
  if (task) task.logs.push(line);
};

store.onCloudFinished = (payload) => {
  const { taskId, code } = payload;
  const task = store.cloudTasks.find(t => t.id === taskId);
  if (!task) return;
  if (task.status === 'cancelling') {
    task.status = 'cancelled';
    task.step = '已取消';
  } else if (code === 0) {
    task.status = 'success';
    task.step = task.kind === 'backup' ? '备份完成' : '恢复完成';
    task.progress = 100;
  } else {
    task.status = 'error';
    task.step = `失败（code=${code}）`;
  }
};

store.loadArchive = async () => {
  store.archive = await window.electronAPI.listArchive(store.settings.outputPath);
};

store.openFolder = (dirPath) => {
  window.electronAPI.openFolder(dirPath);
};

store.openVideo = (filePath) => {
  window.electronAPI.openVideo(filePath);
};

store.deleteArchive = async (dirPath) => {
  const ok = await window.electronAPI.deleteArchive(dirPath);
  if (ok) await store.loadArchive();
  return ok;
};

store.selectFolder = async () => {
  return await window.electronAPI.selectFolder();
};

function formatNumber(n) {
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return (n || 0).toString();
}

function formatDate(ts) {
  if (!ts) return '';
  if (typeof ts === 'number' && ts < 10000000000) ts *= 1000;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  return d.toLocaleDateString();
}

function loadFollowingRemarks() {
  try {
    return JSON.parse(localStorage.getItem('douzy.following.remarks') || '{}');
  } catch (e) {
    return {};
  }
}

function saveFollowingRemarks(map) {
  localStorage.setItem('douzy.following.remarks', JSON.stringify({ ...map }));
}

function loadUnfollowedSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem('douzy.following.unfollowed') || '[]'));
  } catch (e) {
    return new Set();
  }
}

function saveUnfollowedSet(set) {
  localStorage.setItem('douzy.following.unfollowed', JSON.stringify(Array.from(set)));
}

function getDownloadStatus(user, archive) {
  if (!archive || !archive.length) return { status: 'never' };
  const nickname = (user.nickname || '').trim();
  for (const item of archive) {
    const name = (item.name || '').trim();
    if (!name || !nickname) continue;
    const parts = name.split('_');
    const authorPart = parts[parts.length - 1] || name;
    if (authorPart === nickname || name.includes(nickname)) {
      const date = item.mtime ? item.mtime.slice(0, 10) : '';
      return { status: 'downloaded', date };
    }
  }
  return { status: 'never' };
}

// ===== 页面组件 =====

const PageLogin = {
  setup() {
    const s = inject('store');
    const loading = ref(false);
    const error = ref('');

    const messages = {
      following: { label: '需要登录', title: '需要先登录抖音账号', desc: '「关注」需要读取当前抖音账号的关注列表。请先登录，登录后即可浏览并一键下载已关注作者的作品。' },
      favorites: { label: '需要登录', title: '需要先登录抖音账号', desc: '「收藏」需要读取当前抖音账号的收藏、喜欢与合集。请先登录，登录后即可浏览并下载收藏内容。' },
      downloads: { label: 'Account', title: '尚未登录抖音', desc: '登录抖音账号以下载用户主页、喜欢、合集等内容；公开的单个作品无需登录即可下载。' },
      default: { label: '需要登录', title: '需要先登录抖音账号', desc: '请先登录抖音账号后再使用该功能。' },
    };

    const info = computed(() => messages[s.currentPage] || messages.default);

    async function login() {
      loading.value = true;
      error.value = '';
      const result = await s.loginWithBrowser();
      loading.value = false;
      if (!result.success) {
        error.value = result.reason || '登录失败，请重试';
      }
    }

    return { s, loading, error, login, info };
  },
  template: `
    <div class="login-prompt-card">
      <div class="login-prompt-label">{{ info.label }}</div>
      <h3>{{ info.title }}</h3>
      <p>{{ info.desc }}</p>
      <button class="btn btn-primary btn-large" :disabled="loading" @click="login">
        <span>→</span> {{ loading ? '登录中...' : '去登录' }}
      </button>
      <div v-if="error" class="login-prompt-error">{{ error }}</div>
    </div>
  `
};

const PageFollowing = {
  setup() {
    const s = inject('store');
    const search = ref('');
    const sortBy = ref('follow-time');
    const sortOrder = ref('desc');
    const sortOpen = ref(false);
    const filterTag = ref('all');
    const page = ref(1);
    const pageSize = ref(10);
    const viewMode = ref('list');
    const multiSelect = ref(false);
    const selected = ref(new Set());
    const showMore = ref(null);
    const remarkInput = ref({ sec_uid: '', value: '' });
    const remarks = ref(loadFollowingRemarks());
    const unfollowed = ref(loadUnfollowedSet());

    const sortOptions = [
      { key: 'follow-time', label: '关注时间' },
      { key: 'fans', label: '粉丝数' },
      { key: 'works', label: '作品数' },
      { key: 'name', label: '昵称' },
    ];

    const sortLabel = computed(() => {
      const opt = sortOptions.find(o => o.key === sortBy.value);
      const arrow = sortOrder.value === 'desc' ? '↓' : '↑';
      return `${opt ? opt.label : sortBy.value} ${arrow}`;
    });

    function toggleSort(key) {
      if (sortBy.value === key) {
        sortOrder.value = sortOrder.value === 'desc' ? 'asc' : 'desc';
      } else {
        sortBy.value = key;
        sortOrder.value = key === 'name' ? 'asc' : 'desc';
      }
      sortOpen.value = false;
    }

    function closeSortDropdown(e) {
      const dropdown = document.querySelector('.following-toolbar .dropdown');
      if (dropdown && !dropdown.contains(e.target)) {
        sortOpen.value = false;
      }
    }

    onMounted(() => document.addEventListener('mousedown', closeSortDropdown));
    onUnmounted(() => document.removeEventListener('mousedown', closeSortDropdown));

    const filterOptions = [
      { key: 'all', label: '全部' },
      { key: 'mutual', label: '仅互关' },
      { key: 'remark', label: '有本地备注' },
      { key: 'never', label: '从未下载过' },
      { key: 'downloaded', label: '下载过' },
      { key: 'unfollowed', label: '已取消关注' },
    ];

    watch([search, sortBy, sortOrder, filterTag], () => { page.value = 1; });

    const rawList = computed(() => {
      const cache = s.syncCache.following;
      if (!cache || !cache.items) return [];
      return cache.items.map((u, idx) => {
        const dl = getDownloadStatus(u, s.archive);
        return {
          ...u,
          avatar: u.avatar || generateAvatar(u.nickname),
          following: u.following_count || 0,
          fans: u.follower_count || 0,
          works: u.video_count || u.aweme_count || 0,
          followTime: u.create_time || 0,
          followOrder: idx,
          remark: remarks.value[u.sec_uid] || '',
          isUnfollowed: unfollowed.value.has(u.sec_uid),
          downloadStatus: dl.status,
          lastDownloadDate: dl.date,
        };
      });
    });

    const filteredList = computed(() => {
      let list = [...rawList.value];
      const q = search.value.trim().toLowerCase();
      if (q) {
        list = list.filter(u =>
          (u.nickname || '').toLowerCase().includes(q) ||
          (u.unique_id || '').toLowerCase().includes(q) ||
          (u.remark || '').toLowerCase().includes(q)
        );
      }
      if (filterTag.value === 'mutual') {
        list = [];
      } else if (filterTag.value === 'remark') {
        list = list.filter(u => u.remark);
      } else if (filterTag.value === 'never') {
        list = list.filter(u => u.downloadStatus === 'never' && !u.isUnfollowed);
      } else if (filterTag.value === 'downloaded') {
        list = list.filter(u => u.downloadStatus === 'downloaded');
      } else if (filterTag.value === 'unfollowed') {
        list = list.filter(u => u.isUnfollowed);
      }
      list.sort((a, b) => {
        const aTime = a.followTime || 0;
        const bTime = b.followTime || 0;
        if (sortBy.value === 'follow-time') {
          if (aTime && bTime) {
            return sortOrder.value === 'desc' ? bTime - aTime : aTime - bTime;
          }
          // Fallback to list order (API returns newest first) for legacy data without create_time.
          return sortOrder.value === 'desc' ? b.followOrder - a.followOrder : a.followOrder - b.followOrder;
        }
        if (sortBy.value === 'fans') {
          return sortOrder.value === 'desc'
            ? (b.fans || 0) - (a.fans || 0)
            : (a.fans || 0) - (b.fans || 0);
        }
        if (sortBy.value === 'works') {
          return sortOrder.value === 'desc'
            ? (b.works || 0) - (a.works || 0)
            : (a.works || 0) - (b.works || 0);
        }
        if (sortBy.value === 'name') {
          return sortOrder.value === 'desc'
            ? (b.nickname || '').localeCompare(a.nickname || '', 'zh-CN')
            : (a.nickname || '').localeCompare(b.nickname || '', 'zh-CN');
        }
        return 0;
      });
      return list;
    });

    const totalPages = computed(() => Math.max(1, Math.ceil(filteredList.value.length / pageSize.value)));
    const pagedList = computed(() => {
      const start = (page.value - 1) * pageSize.value;
      return filteredList.value.slice(start, start + pageSize.value);
    });
    const needsLogin = computed(() => !s.user.isLoggedIn);
    const selectedCount = computed(() => selected.value.size);
    const allPageSelected = computed(() => pagedList.value.length > 0 && pagedList.value.every(u => selected.value.has(u.sec_uid)));

    const isSyncing = computed(() => s.syncs.some(sync => sync.kind === 'following' && (sync.status === 'running' || sync.status === 'cancelling')));
    const lastSyncText = computed(() => {
      if (isSyncing.value) return '同步中...';
      return formatTimeLabel(s.syncCache.following?.updated_at);
    });
    const syncedCount = computed(() => {
      const active = s.syncs.find(sync => sync.kind === 'following' && (sync.status === 'running' || sync.status === 'cancelling'));
      if (active) return active.added || 0;
      return s.syncCache.following?.count || s.syncCache.following?.items?.length || 0;
    });

    const emptyText = computed(() => {
      if (!s.syncCache.following || !s.syncCache.following.items || s.syncCache.following.items.length === 0) {
        return '暂无关注数据，点击上方“刷新”同步';
      }
      if (filterTag.value === 'mutual') return '暂不支持判断互关状态';
      return '没有符合筛选条件的关注用户';
    });

    function sync() {
      if (needsLogin.value || isSyncing.value) return;
      s.startSync('following');
    }

    function downloadUser(user) {
      // 用户主页下载需要 sec_uid，unique_id 会被后端当成 sec_uid 传给 API 导致获取用户信息失败。
      const uid = user.sec_uid || user.unique_id;
      if (uid) {
        s.startTask(`https://www.douyin.com/user/${uid}`, `${user.nickname} 的主页`);
      }
    }

    // ========== 博主作品弹窗 ==========
    const userWorksModal = ref({ open: false, secUid: '', nickname: '', avatar: '' });
    const worksSearch = ref('');
    const worksPage = ref(1);
    const worksPageSize = ref(30);
    const worksTask = computed(() => {
      const list = s.userWorks.filter(t => t.secUid === userWorksModal.value.secUid);
      return list.find(t => t.status === 'running' || t.status === 'cancelling') || list[0] || null;
    });
    const worksTaskStatus = computed(() => {
      const t = worksTask.value;
      if (!t) return 'idle';
      return t.status;
    });
    const worksList = computed(() => {
      const t = worksTask.value;
      const items = t ? t.items : [];
      const q = worksSearch.value.trim().toLowerCase();
      if (!q) return items;
      return items.filter(item => (item.title || '').toLowerCase().includes(q));
    });
    const worksTotalPages = computed(() => Math.max(1, Math.ceil(worksList.value.length / worksPageSize.value)));
    const worksPagedList = computed(() => {
      const start = (worksPage.value - 1) * worksPageSize.value;
      return worksList.value.slice(start, start + worksPageSize.value);
    });

    watch(worksSearch, () => { worksPage.value = 1; });

    function openUserWorks(user) {
      if (!user || !user.sec_uid) return;
      userWorksModal.value = { open: true, secUid: user.sec_uid, nickname: user.nickname, avatar: user.avatar };
      worksSearch.value = '';
      worksPage.value = 1;
      const existing = s.userWorks.find(t => t.secUid === user.sec_uid && (t.status === 'success' || t.status === 'running'));
      if (!existing) {
        s.startUserWorks(user.sec_uid, user.nickname);
      }
    }
    function closeUserWorks() {
      userWorksModal.value = { open: false, secUid: '', nickname: '', avatar: '' };
    }
    function downloadWork(item) {
      if (item.share_url) {
        s.startTask(item.share_url, item.title || '博主作品');
      } else if (item.aweme_id) {
        s.startTask(awemeUrl(item.aweme_id), item.title || '博主作品');
      }
    }

    function toggleSelect(user) {
      if (selected.value.has(user.sec_uid)) selected.value.delete(user.sec_uid);
      else selected.value.add(user.sec_uid);
    }

    function selectAll() {
      if (allPageSelected.value) {
        pagedList.value.forEach(u => selected.value.delete(u.sec_uid));
      } else {
        pagedList.value.forEach(u => selected.value.add(u.sec_uid));
      }
    }

    function runRelation(action) {
      const secUids = Array.from(selected.value);
      if (secUids.length === 0) return;
      const actionName = action === 'follow' ? '关注' : '取关';
      if (!confirm(`确定要对 ${secUids.length} 位用户执行「${actionName}」吗？${s.settings.relation.dryRun ? '（当前为演练模式，不会真正执行）' : ''}`)) return;
      s.startRelationTask(action, secUids);
      selected.value.clear();
    }
    function unfollowUser(user) {
      if (user.isUnfollowed) return;
      if (!confirm(`确定取消关注「${user.nickname || user.unique_id || user.sec_uid}」吗？${s.settings.relation.dryRun ? '（当前为演练模式，不会真正执行）' : ''}`)) return;
      s.startRelationTask('unfollow', [user.sec_uid]);
    }

    function toggleMore(secUid, event) {
      event.stopPropagation();
      showMore.value = showMore.value === secUid ? null : secUid;
    }
    function closeMore() { showMore.value = null; }

    function openRemark(user) {
      remarkInput.value = { sec_uid: user.sec_uid, value: user.remark || '' };
    }
    function saveRemark() {
      const { sec_uid, value } = remarkInput.value;
      if (sec_uid) {
        const v = value.trim();
        if (v) remarks.value[sec_uid] = v;
        else delete remarks.value[sec_uid];
        saveFollowingRemarks(remarks.value);
      }
      remarkInput.value = { sec_uid: '', value: '' };
    }
    function removeRemark(secUid) {
      delete remarks.value[secUid];
      saveFollowingRemarks(remarks.value);
    }

    function markUnfollowed(secUid) {
      unfollowed.value.add(secUid);
      saveUnfollowedSet(unfollowed.value);
    }
    function restoreFollowed(secUid) {
      unfollowed.value.delete(secUid);
      saveUnfollowedSet(unfollowed.value);
    }
    function clearUnfollowed() {
      if (!unfollowed.value.size) return;
      if (!confirm(`确定清除 ${unfollowed.value.size} 位已取消关注的博主记录吗？`)) return;
      unfollowed.value = new Set();
      saveUnfollowedSet(unfollowed.value);
    }

    function copyHandle(user) {
      const text = user.unique_id || user.sec_uid || '';
      if (text && navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => alert('已复制：' + text));
      } else if (text) {
        alert(text);
      }
    }

    function statusText(u) {
      if (u.isUnfollowed) return '已取消关注';
      if (u.downloadStatus === 'downloaded') return u.lastDownloadDate || '下载过';
      return '未下载过';
    }

    onMounted(() => { document.addEventListener('click', closeMore); });
    onUnmounted(() => { document.removeEventListener('click', closeMore); });

    return {
      s, search, sortBy, sortOrder, sortOpen, sortOptions, sortLabel, toggleSort, filterTag, page, pageSize, viewMode, multiSelect,
      filterOptions, rawList, filteredList, totalPages, pagedList, sync, downloadUser, formatNumber, needsLogin,
      selected, selectedCount, allPageSelected, toggleSelect, selectAll, runRelation, unfollowUser,
      isSyncing, lastSyncText, syncedCount, emptyText,
      showMore, toggleMore, closeMore, openRemark, saveRemark, removeRemark, remarkInput,
      unfollowed, remarks, markUnfollowed, restoreFollowed, clearUnfollowed, copyHandle, statusText,
      userWorksModal, worksSearch, worksPage, worksPageSize, worksTask, worksTaskStatus,
      worksList, worksTotalPages, worksPagedList, openUserWorks, closeUserWorks, downloadWork,
    };
  },
  template: `
    <div class="page-header">
      <h1>关注</h1>
      <div class="sync-bar">
        <div class="sync-info">
          <span class="sync-label">上次同步：</span>
          <span class="sync-time" :class="{syncing: isSyncing}">{{ lastSyncText }}</span>
          <span class="sync-count" v-if="syncedCount > 0"> · 已同步 {{ syncedCount }} 人</span>
        </div>
        <button class="btn sync-btn" :disabled="isSyncing || needsLogin" @click="sync">
          <span class="spin" v-if="isSyncing" v-html="$icons.refresh"></span>
          <span v-else v-html="$icons.refresh"></span>
          {{ isSyncing ? '同步中...' : '刷新' }}
        </button>
      </div>
    </div>
    <PageLogin v-if="needsLogin" />
    <template v-else>
    <div class="toolbar following-toolbar">
      <div class="search-box"><span class="icon" v-html="$icons.search"></span><input v-model="search" placeholder="搜索昵称 / 抖音号 / 备注" /></div>
      <div class="dropdown">
        <button class="dropdown-toggle" @click="sortOpen = !sortOpen">{{ sortLabel }}</button>
        <div v-if="sortOpen" class="dropdown-menu">
          <div
            v-for="opt in sortOptions"
            :key="opt.key"
            class="dropdown-item"
            :class="{active: sortBy===opt.key}"
            @click="toggleSort(opt.key)"
          >
            {{ opt.label }}
            <span class="order">{{ sortBy===opt.key ? (sortOrder==='desc'?'↓':'↑') : (opt.key==='name'?'↑':'↓') }}</span>
          </div>
        </div>
      </div>
      <div class="view-toggle">
        <button :class="{active: viewMode==='grid'}" @click="viewMode='grid'" title="网格视图" v-html="$icons.grid"></button>
        <button :class="{active: viewMode==='list'}" @click="viewMode='list'" title="列表视图" v-html="$icons.list"></button>
      </div>
      <button class="btn" :class="{active: multiSelect}" @click="multiSelect=!multiSelect; selected.clear()">
        {{ multiSelect ? '完成' : '多选' }}
      </button>
      <button class="btn btn-danger" :disabled="!unfollowed.size" @click="clearUnfollowed" title="清除已取消关注的博主记录">
        清除已取消关注
      </button>
    </div>
    <div class="filters">
      <button v-for="f in filterOptions" :key="f.key" class="filter-chip" :class="{active: filterTag===f.key}" @click="filterTag=f.key; page=1">{{ f.label }}</button>
    </div>
    <div class="content" :class="{'multi-active': multiSelect}">
      <div v-if="pagedList.length===0" class="empty-state"><div class="big-icon" v-html="$icons.user"></div><div>{{ emptyText }}</div></div>
      <div v-else-if="viewMode==='list'" class="list-card following-list" :class="{'multi-select': multiSelect}">
        <div class="list-header">
          <div v-if="multiSelect" class="select-col"><input type="checkbox" :checked="allPageSelected" @change="selectAll" /></div>
          <div class="avatar-col"></div>
          <div>用户</div>
          <div class="num-col">作品数</div>
          <div class="num-col">粉丝数</div>
          <div class="status-col">状态</div>
          <div class="action-col"></div>
        </div>
        <div v-for="u in pagedList" :key="u.sec_uid" class="list-row" :class="{unfollowed: u.isUnfollowed}">
          <div v-if="multiSelect" class="select-col"><input type="checkbox" :checked="selected.has(u.sec_uid)" @change="toggleSelect(u)" /></div>
          <img :src="u.avatar" class="avatar clickable" @click="openUserWorks(u)" />
          <div class="user-info clickable" @click="openUserWorks(u)">
            <div class="name">{{ u.nickname }}<span v-if="u.remark" class="remark-badge">{{ u.remark }}</span></div>
            <div class="handle">@{{ u.unique_id || u.sec_uid }}</div>
          </div>
          <div class="col num-col">{{ formatNumber(u.works) }}</div>
          <div class="col num-col">{{ formatNumber(u.fans) }}</div>
          <div class="col status-col" :class="u.downloadStatus">{{ statusText(u) }}</div>
          <div class="action-col">
            <button class="btn btn-primary" @click="downloadUser(u)"><span v-html="$icons.download"></span> 下载</button>
            <div class="more-wrap">
              <button class="btn btn-icon more" @click="toggleMore(u.sec_uid, $event)" v-html="$icons.more"></button>
              <div class="more-menu" v-if="showMore===u.sec_uid" @click.stop>
                <div class="more-item" @click="openUserWorks(u); closeMore()">查看作品</div>
                <div class="more-item" @click="downloadUser(u); closeMore()">下载主页</div>
                <div class="more-item" @click="openRemark(u); closeMore()">{{ u.remark ? '编辑备注' : '添加备注' }}</div>
                <div class="more-item" v-if="!u.isUnfollowed" @click="unfollowUser(u); closeMore()">取消关注</div>
                <div class="more-item" v-else @click="restoreFollowed(u.sec_uid); closeMore()">恢复关注状态</div>
                <div class="more-item" @click="copyHandle(u); closeMore()">复制抖音号</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="following-grid">
        <div v-for="u in pagedList" :key="u.sec_uid" class="following-card" :class="{unfollowed: u.isUnfollowed}">
          <div v-if="multiSelect" class="card-check"><input type="checkbox" :checked="selected.has(u.sec_uid)" @change="toggleSelect(u)" /></div>
          <img :src="u.avatar" class="avatar clickable" @click="openUserWorks(u)" />
          <div class="card-info clickable" @click="openUserWorks(u)">
            <div class="name">{{ u.nickname }}</div>
            <div class="handle">@{{ u.unique_id || u.sec_uid }}</div>
            <div class="stats">作品 {{ formatNumber(u.works) }} · 粉丝 {{ formatNumber(u.fans) }}</div>
            <div class="status" :class="u.downloadStatus">{{ statusText(u) }}</div>
          </div>
          <div class="card-actions">
            <button class="btn btn-primary" @click="downloadUser(u)"><span v-html="$icons.download"></span> 下载</button>
            <button class="btn btn-icon more" @click="toggleMore(u.sec_uid, $event)" v-html="$icons.more"></button>
            <div class="more-menu" v-if="showMore===u.sec_uid" @click.stop>
              <div class="more-item" @click="openUserWorks(u); closeMore()">查看作品</div>
              <div class="more-item" @click="downloadUser(u); closeMore()">下载主页</div>
              <div class="more-item" @click="openRemark(u); closeMore()">{{ u.remark ? '编辑备注' : '添加备注' }}</div>
              <div class="more-item" v-if="!u.isUnfollowed" @click="unfollowUser(u); closeMore()">取消关注</div>
              <div class="more-item" v-else @click="restoreFollowed(u.sec_uid); closeMore()">恢复关注状态</div>
              <div class="more-item" @click="copyHandle(u); closeMore()">复制抖音号</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="pagination" v-if="filteredList.length>0">
      <div>共 {{ filteredList.length }} 人 · 第 {{ page }}/{{ totalPages }} 页</div>
      <div class="pages">
        <button @click="page=1" :disabled="page===1">«</button>
        <button @click="page--" :disabled="page===1">‹</button>
        <div class="current">{{ page }}</div>
        <button @click="page++" :disabled="page===totalPages">›</button>
        <button @click="page=totalPages" :disabled="page===totalPages">»</button>
      </div>
    </div>
    <div class="multi-select-bar" v-if="multiSelect">
      <div>已选择 {{ selectedCount }} 人</div>
      <div class="actions">
        <button class="btn" :disabled="selectedCount===0" @click="runRelation('follow')">批量关注</button>
        <button class="btn" :disabled="selectedCount===0" @click="runRelation('unfollow')">批量取关</button>
        <button class="btn" @click="multiSelect=false; selected.clear()">取消</button>
      </div>
    </div>
    <div v-if="remarkInput.sec_uid" class="video-modal" @click.self="remarkInput.sec_uid=''">
      <div class="video-modal-content report-modal">
        <button class="btn btn-icon video-modal-close" @click="remarkInput.sec_uid=''" v-html="$icons.close"></button>
        <h3>{{ remarks[remarkInput.sec_uid] ? '编辑备注' : '添加备注' }}</h3>
        <input v-model="remarkInput.value" placeholder="输入备注，最多 20 字" maxlength="20" />
        <div class="modal-actions">
          <button class="btn" @click="remarkInput.sec_uid=''">取消</button>
          <button class="btn btn-primary" @click="saveRemark">保存</button>
          <button class="btn btn-danger" v-if="remarks[remarkInput.sec_uid]" @click="removeRemark(remarkInput.sec_uid); remarkInput.sec_uid=''">删除</button>
        </div>
      </div>
    </div>
    <div v-if="userWorksModal.open" class="video-modal user-works-modal" @click.self="closeUserWorks">
      <div class="video-modal-content user-works-content">
        <button class="btn btn-icon video-modal-close" @click="closeUserWorks" v-html="$icons.close"></button>
        <div class="user-works-header">
          <img v-if="userWorksModal.avatar" :src="userWorksModal.avatar" class="avatar" />
          <div>
            <h3>{{ userWorksModal.nickname }} 的作品</h3>
            <div class="user-works-subtitle">
              <span v-if="worksTaskStatus==='running'" class="syncing">{{ worksTask?.step || '获取中...' }}</span>
              <span v-else-if="worksTaskStatus==='error'" class="error">{{ worksTask?.step || '获取失败' }}</span>
              <span v-else>共 {{ worksList.length }} 个作品</span>
            </div>
          </div>
        </div>
        <div class="toolbar" style="padding-top:0">
          <div class="search-box"><span class="icon" v-html="$icons.search"></span><input v-model="worksSearch" placeholder="搜索作品标题" /></div>
          <button class="btn" :disabled="worksTaskStatus==='running'" @click="s.startUserWorks(userWorksModal.secUid, userWorksModal.nickname)">刷新</button>
        </div>
        <div class="user-works-body">
          <div v-if="worksTaskStatus==='running' && worksPagedList.length===0" class="empty-state"><div class="big-icon" v-html="$icons.refresh"></div><div>正在加载作品...</div></div>
          <div v-else-if="worksList.length===0 && worksTaskStatus!=='running'" class="empty-state"><div class="big-icon" v-html="$icons.folder"></div><div>暂无作品</div></div>
          <div v-else class="user-works-grid">
            <div v-for="item in worksPagedList" :key="item.aweme_id" class="user-works-card">
              <div class="user-works-cover" :style="item.cover ? {backgroundImage:'url('+item.cover+')',backgroundSize:'cover'} : {}" @click="downloadWork(item)">
                <span class="play-icon" v-html="$icons.play"></span>
              </div>
              <div class="user-works-info">
                <div class="user-works-title" :title="item.title">{{ item.title || '无标题' }}</div>
                <div class="user-works-meta">{{ $formatDate(item.create_time) }}</div>
              </div>
              <button class="btn download-video" @click="downloadWork(item)"><span v-html="$icons.download"></span> 下载</button>
            </div>
          </div>
        </div>
        <div class="pagination" v-if="worksList.length>0">
          <div>共 {{ worksList.length }} 个 · 第 {{ worksPage }}/{{ worksTotalPages }} 页</div>
          <div class="pages">
            <button @click="worksPage=1" :disabled="worksPage===1">«</button>
            <button @click="worksPage--" :disabled="worksPage===1">‹</button>
            <div class="current">{{ worksPage }}</div>
            <button @click="worksPage++" :disabled="worksPage===worksTotalPages">›</button>
            <button @click="worksPage=worksTotalPages" :disabled="worksPage===worksTotalPages">»</button>
          </div>
        </div>
      </div>
    </div>
    </template>
  `
};

const PageFavorites = {
  setup() {
    const s = inject('store');
    const activeTab = ref('videos');
    const activeCollection = ref('all');
    const search = ref('');
    const showDrawer = ref(false);
    const loading = ref(false);

    const tabs = [
      { key: 'videos', label: '我的收藏（视频）' },
      { key: 'collections', label: '我收藏的合集' },
      { key: 'likes', label: '我的喜欢' },
    ];

    const favCache = computed(() => s.syncCache.favorites || { collections: [], collect_mixes: [], items: [], updated_at: null });

    const collections = computed(() => {
      const list = [{ collects_id: 'all', name: '全部收藏', count: favCache.value.items?.length || 0 }];
      list.push(...(favCache.value.collections || []).map(c => ({ ...c, count: c.video_count || 0 })));
      return list;
    });

    const currentList = computed(() => {
      if (activeTab.value === 'likes') return (s.syncCache.likes?.items || []);
      if (activeTab.value === 'collections') return (favCache.value.collect_mixes || []);
      let items = favCache.value.items || [];
      if (activeCollection.value !== 'all') {
        items = items.filter(i => (i.collection_id || 'all') === activeCollection.value);
      }
      return items;
    });

    const filteredList = computed(() => {
      const q = search.value.trim().toLowerCase();
      if (!q) return currentList.value;
      return currentList.value.filter(item => {
        const title = (item.title || '').toLowerCase();
        const author = ((item.author && item.author.nickname) || '').toLowerCase();
        return title.includes(q) || author.includes(q);
      });
    });
    const needsLogin = computed(() => !s.user.isLoggedIn);

    const activeSyncKinds = computed(() => {
      if (activeTab.value === 'likes') return ['likes'];
      return ['favorites'];
    });

    const isSyncing = computed(() => s.syncs.some(
      sync => activeSyncKinds.value.includes(sync.kind) && (sync.status === 'running' || sync.status === 'cancelling')
    ));

    const lastSync = computed(() => {
      const kinds = activeSyncKinds.value;
      return s.syncs.find(sync => kinds.includes(sync.kind));
    });

    const lastSyncTime = computed(() => {
      if (activeTab.value === 'likes') return s.syncCache.likes?.updated_at || null;
      return s.syncCache.favorites?.updated_at || null;
    });

    function downloadItem(item) {
      if (item.share_url) {
        s.startTask(item.share_url, item.title || '收藏视频');
      } else if (item.aweme_id) {
        s.startTask(awemeUrl(item.aweme_id), item.title || '收藏视频');
      }
    }

    function downloadMix(item) {
      if (item.mix_id) {
        s.startTask(`https://www.douyin.com/collection/${item.mix_id}`, item.name || '合集');
      }
    }

    function syncCurrent() {
      if (needsLogin.value) return;
      if (activeTab.value === 'likes') {
        s.startSync('likes');
      } else {
        s.startSync('favorites');
      }
    }

    function syncAll() {
      if (needsLogin.value) return;
      s.startSync('favorites');
      s.startSync('likes');
    }

    async function loadCaches() {
      loading.value = true;
      await s.loadSyncCache('favorites');
      await s.loadSyncCache('likes');
      loading.value = false;
    }

    return {
      activeTab, activeCollection, search, showDrawer, loading, tabs,
      collections, currentList, filteredList, s, favCache, needsLogin,
      downloadItem, downloadMix, syncCurrent, syncAll, loadCaches,
      isSyncing, lastSync, lastSyncTime,
    };
  },
  template: `
    <div class="page-header">
      <div class="page-label">My</div>
      <h1>收藏</h1>
      <button class="btn drawer-toggle" @click="showDrawer=true" v-if="!needsLogin"><span v-html="$icons.refresh"></span> 缓存与同步</button>
    </div>
    <PageLogin v-if="needsLogin" />
    <template v-else>
    <div class="sub-tabs">
      <button v-for="t in tabs" :key="t.key" :class="{active: activeTab===t.key}" @click="activeTab=t.key; activeCollection='all'">{{ t.label }}</button>
    </div>
    <div class="favorites-layout">
      <aside class="collection-list" v-if="activeTab==='videos'">
        <template v-if="collections.length <= 1">
          <div class="collection-empty">
            <div class="big-icon" v-html="$icons.folder"></div>
            <div>还没有收藏夹</div>
          </div>
        </template>
        <template v-else>
          <div v-for="c in collections" :key="c.collects_id" class="collection-item" :class="{active: activeCollection===c.collects_id}" @click="activeCollection=c.collects_id">
            <div class="collection-name">{{ c.name }}</div>
            <div class="collection-count">({{ c.count }})</div>
          </div>
        </template>
        <button class="btn download-collection" @click="syncCurrent" :disabled="loading || isSyncing"><span :class="{spin: isSyncing}" v-html="$icons.refresh"></span> {{ isSyncing ? '同步中' : '同步收藏夹' }}</button>
      </aside>
      <div class="favorites-main">
        <div class="toolbar" style="padding-top:0">
          <div class="search-box"><span class="icon" v-html="$icons.search"></span><input v-model="search" placeholder="搜索作品标题 / 作者" /></div>
          <button class="btn" @click="syncCurrent" :disabled="loading || isSyncing">同步当前收藏夹</button>
          <button class="btn btn-primary" @click="syncAll" :disabled="loading || isSyncing">同步全部收藏夹</button>
          <span class="sync-status" :class="{syncing: isSyncing, error: lastSync?.status === 'error', never: !isSyncing && !lastSyncTime && lastSync?.status !== 'error'}">
            <span class="status-dot" :class="{spin: isSyncing}"></span>
            {{ isSyncing ? '同步中...' : (lastSync?.status === 'error' ? lastSync.step : (lastSyncTime ? '已同步 ' + $formatTimeLabel(lastSyncTime) : '从未同步过')) }}
          </span>
        </div>
        <div class="content">
          <div v-if="activeTab==='collections'" class="video-list">
            <div v-if="filteredList.length===0" class="empty-state"><div class="empty-title">当前视图没有作品</div><div class="empty-subtitle">同步完成后，作品会出现在这里</div></div>
            <div v-for="item in filteredList" :key="item.mix_id" class="video-card">
              <div class="video-cover" :style="item.cover ? {backgroundImage:'url('+item.cover+')',backgroundSize:'cover'} : {}"><span class="play-icon" v-html="$icons.play"></span></div>
              <div class="video-info">
                <div class="video-title">{{ item.name }}</div>
                <div class="video-meta">{{ item.video_count || 0 }} 个作品</div>
              </div>
              <button class="btn download-video" @click="downloadMix(item)"><span v-html="$icons.download"></span> 下载</button>
            </div>
          </div>
          <div v-else-if="filteredList.length===0" class="empty-state"><div class="empty-title">当前视图没有作品</div><div class="empty-subtitle">同步完成后，作品会出现在这里</div></div>
          <div v-else class="video-list">
            <div v-for="item in filteredList" :key="item.aweme_id" class="video-card">
              <div class="video-check"><input type="checkbox" /></div>
              <div class="video-cover" :style="item.cover ? {backgroundImage:'url('+item.cover+')',backgroundSize:'cover'} : {}"><span class="play-icon" v-html="$icons.play"></span></div>
              <div class="video-info">
                <div class="video-title">{{ item.title || '无标题' }}</div>
                <div class="video-meta">{{ item.author?.nickname || '未知作者' }} · {{ $formatDate(item.create_time) }}</div>
              </div>
              <button class="btn download-video" @click="downloadItem(item)"><span v-html="$icons.download"></span> 下载</button>
            </div>
          </div>
        </div>
        <div class="favorites-footer">
          <span>已加载 {{ filteredList.length }} / {{ currentList.length }} 条</span>
        </div>
      </div>
    </div>
    <div class="drawer-overlay" v-if="showDrawer" @click="showDrawer=false"></div>
    <div class="drawer" :class="{open: showDrawer}">
      <div class="drawer-header">
        <h3>缓存与同步</h3>
        <button class="btn btn-icon" @click="showDrawer=false" v-html="$icons.close"></button>
      </div>
      <div class="drawer-body">
        <div class="drawer-section">
          <div class="drawer-section-title"><span class="dot dot-accent"></span>SYNC LIMITS</div>
          <p>每次同步从抖音拉取的最大条数。数值越大同步越慢。</p>
          <div class="drawer-row"><span>我的收藏<br><small>1–10,000</small></span><input type="number" v-model.number="s.settings.syncLimits.favorites" min="1" max="10000" /></div>
          <div class="drawer-row"><span>我收藏的合集<br><small>1–2,000</small></span><input type="number" v-model.number="s.settings.syncLimits.collections" min="1" max="2000" /></div>
          <div class="drawer-row"><span>我的喜欢<br><small>1–10,000</small></span><input type="number" v-model.number="s.settings.syncLimits.likes" min="1" max="10000" /></div>
        </div>
        <div class="drawer-section">
          <div class="drawer-section-title"><span class="dot dot-purple"></span>RETENTION</div>
          <div class="drawer-row"><span>保留时长<br><small>超过时限的缓存条目将自动清理</small></span>
            <select v-model="s.settings.retention">
              <option value="forever">永久</option>
              <option value="7d">7 天</option>
              <option value="30d">30 天</option>
              <option value="90d">90 天</option>
            </select>
          </div>
        </div>
        <div class="drawer-section">
          <div class="drawer-section-title"><span class="dot dot-danger"></span>CLEAR CACHE</div>
          <p>仅清除本地缓存，不会影响抖音侧的收藏/喜欢列表。</p>
          <button class="btn clear-cache" @click="s.clearSyncCache('favorites')">清空缓存 <span>我的收藏</span></button>
          <button class="btn clear-cache" @click="s.clearSyncCache('likes')">清空缓存 <span>我的喜欢</span></button>
          <button class="btn clear-cache" @click="s.clearSyncCache('following')">清空缓存 <span>我的关注</span></button>
        </div>
      </div>
    </div>
    </template>
  `
};

const PageNewReleases = {
  setup() {
    const s = inject('store');
    const search = ref('');
    const selected = ref({});

    const needsLogin = computed(() => !s.user.isLoggedIn);
    const isRunning = computed(() => s.newReleases.status === 'running');
    const isDone = computed(() => s.newReleases.status === 'done');

    const filteredItems = computed(() => {
      const q = search.value.trim().toLowerCase();
      if (!q) return s.newReleases.items;
      return s.newReleases.items.filter(item => {
        const title = (item.title || '').toLowerCase();
        const author = ((item.author && item.author.nickname) || '').toLowerCase();
        return title.includes(q) || author.includes(q);
      });
    });

    const selectedCount = computed(() => {
      return Object.values(selected.value).filter(Boolean).length;
    });

    const allSelected = computed(() => {
      if (filteredItems.value.length === 0) return false;
      return filteredItems.value.every(item => selected.value[item.aweme_id]);
    });

    const progressText = computed(() => {
      const p = s.newReleases.progress || {};
      if (isRunning.value) {
        return p.message || '正在检查新发布...';
      }
      if (s.newReleases.status === 'error') {
        return s.newReleases.error || '检查失败';
      }
      if (s.newReleases.items.length === 0 && isDone.value) {
        return '所有博主暂无新作品';
      }
      return `共 ${s.newReleases.items.length} 个新作品`;
    });

    function toggleSelect(item) {
      const next = { ...selected.value };
      if (next[item.aweme_id]) {
        delete next[item.aweme_id];
      } else {
        next[item.aweme_id] = true;
      }
      selected.value = next;
    }

    function toggleSelectAll() {
      const next = { ...selected.value };
      if (allSelected.value) {
        filteredItems.value.forEach(item => delete next[item.aweme_id]);
      } else {
        filteredItems.value.forEach(item => { next[item.aweme_id] = true; });
      }
      selected.value = next;
    }

    function downloadItem(item) {
      const url = item.share_url || awemeUrl(item.aweme_id);
      s.startTask(url, item.title || '新发布视频');
    }

    function downloadSelected() {
      const items = s.newReleases.items.filter(item => selected.value[item.aweme_id]);
      if (items.length === 0) return;
      const urls = items.map(item => item.share_url || awemeUrl(item.aweme_id)).filter(Boolean);
      if (urls.length === 0) return;
      s.startTask(urls, `新发布 ${items.length} 个作品`);
      selected.value = {};
    }

    function refresh() {
      selected.value = {};
      s.startNewReleases();
    }

    return {
      s, search, selected, selectedCount, needsLogin, isRunning, isDone,
      filteredItems, allSelected, progressText,
      toggleSelect, toggleSelectAll, downloadItem, downloadSelected, refresh,
    };
  },
  template: `
    <div class="page-header">
      <div class="page-label">New</div>
      <h1>新发布</h1>
      <button class="btn" :disabled="isRunning || needsLogin" @click="refresh">
        <span :class="{spin: isRunning}" v-html="$icons.refresh"></span> {{ isRunning ? '检查中' : '刷新' }}
      </button>
      <button class="btn" v-if="isRunning" @click="s.cancelNewReleases()">取消</button>
    </div>
    <PageLogin v-if="needsLogin" />
    <template v-else>
      <div class="toolbar" style="padding-top:0">
        <div class="search-box"><span class="icon" v-html="$icons.search"></span><input v-model="search" placeholder="搜索作品标题 / 博主" /></div>
        <button class="btn btn-primary" :disabled="selectedCount===0" @click="downloadSelected">下载选中 ({{ selectedCount }})</button>
        <button class="btn" @click="toggleSelectAll">{{ allSelected ? '取消全选' : '全选本页' }}</button>
        <span class="sync-status" :class="{syncing: isRunning, never: !isRunning && s.newReleases.items.length===0 && !isDone}">
          <span class="status-dot" :class="{spin: isRunning}"></span>
          {{ progressText }}
        </span>
      </div>
      <div class="content">
        <div v-if="s.newReleases.items.length===0 && !isRunning && isDone" class="empty-state">
          <div class="empty-title">所有博主暂无新作品</div>
          <div class="empty-subtitle">关注列表中已下载的博主最近没有发布新视频</div>
        </div>
        <div v-else-if="s.newReleases.items.length===0 && !isRunning" class="empty-state">
          <div class="big-icon" v-html="$icons.refresh"></div>
          <div>暂无已下载的博主，先去下载一些作品吧</div>
        </div>
        <div v-else-if="filteredItems.length===0" class="empty-state">
          <div class="empty-title">没有匹配的作品</div>
        </div>
        <div v-else class="video-list">
          <div v-for="item in filteredItems" :key="item.aweme_id" class="video-card">
            <div class="video-check"><input type="checkbox" :checked="selected[item.aweme_id]" @change="toggleSelect(item)" /></div>
            <div class="video-cover" :style="item.cover ? {backgroundImage:'url('+item.cover+')',backgroundSize:'cover'} : {}"><span class="play-icon" v-html="$icons.play"></span></div>
            <div class="video-info">
              <div class="video-title">{{ item.title || '无标题' }}</div>
              <div class="video-meta">{{ item.author?.nickname || '未知作者' }} · {{ $formatDate(item.create_time) }}</div>
            </div>
            <button class="btn download-video" @click="downloadItem(item)"><span v-html="$icons.download"></span> 下载</button>
          </div>
        </div>
      </div>
    </template>
  `
};

const PageDownloads = {
  setup() {
    const url = ref('');
    const recognized = ref(null);
    const s = inject('store');

    const examples = [
      'https://www.douyin.com/video/1234567890123456789',
      'https://www.douyin.com/user/MS4wLjABAAAA...',
      'https://v.douyin.com/xxxxx',
    ];

    function detectType(u) {
      if (/\/video\/\d+/.test(u)) return { type: 'video', label: '单条视频' };
      if (/\/user\/[A-Za-z0-9_-]+/.test(u)) return { type: 'user', label: '博主主页' };
      if (/\/collection\/\d+|\/mix\/\d+/.test(u)) return { type: 'collection', label: '合集' };
      if (/\/music\/\d+/.test(u)) return { type: 'music', label: '音乐' };
      if (/\/live\//.test(u) || /live\.douyin\.com/.test(u)) return { type: 'live', label: '直播' };
      if (/v\.douyin\.com|v\.iesdouyin\.com/.test(u)) return { type: 'short', label: '短链' };
      return null;
    }

    function onInput() {
      recognized.value = detectType(url.value);
    }

    function startDownload() {
      if (!url.value.trim()) return;
      if (!s.user.isLoggedIn) {
        if (!confirm('当前未登录，部分视频可能无法下载。是否仍要继续？')) return;
      }
      const u = url.value.trim();
      const detected = detectType(u);
      let name = '单个链接';
      if (detected?.type === 'user') name = '博主主页';
      else if (detected?.type === 'video') name = '单个视频';
      else if (detected?.type === 'collection') name = '合集';
      else if (detected?.type === 'music') name = '音乐';
      else if (detected?.type === 'live') name = '直播';
      else if (detected?.type === 'short') name = '短链接';
      s.startTask(u, name);
      url.value = '';
      recognized.value = null;
    }

    return { s, url, recognized, examples, onInput, startDownload };
  },
  template: `
    <div class="download-hero">
      <div class="download-hero-label">Download</div>
      <h1>粘贴链接，<span>马上开始。</span></h1>
      <PageLogin v-if="!s.user.isLoggedIn" />
      <div class="url-card">
        <div class="url-card-label"><span class="dot"></span> URL</div>
        <h3>下载链接</h3>
        <input v-model="url" @input="onInput" placeholder="https://www.douyin.com/video/xxxxx 或用户主页、合集、音乐链接" />
        <div class="url-recognize" v-if="recognized">
          <span class="dot"></span> 已识别：{{ recognized.label }}
        </div>
        <div class="url-recognize" v-else-if="url">
          <span class="dot"></span> 未识别到有效链接类型
        </div>
        <button class="btn btn-primary btn-large" :disabled="!url.trim()" @click="startDownload">开始下载</button>
      </div>
      <div class="url-examples">
        <div>示例：</div>
        <div v-for="(ex, idx) in examples" :key="idx" class="example-link" @click="url=ex; onInput()">{{ ex }}</div>
      </div>
    </div>
  `
};

const PageBatch = {
  setup() {
    const urlsText = ref('');
    const s = inject('store');

    function startBatch() {
      const urls = urlsText.value.split('\n').map(u => u.trim()).filter(Boolean);
      if (urls.length === 0) return;
      if (!s.user.isLoggedIn) {
        if (!confirm('当前未登录，部分视频可能无法下载。是否仍要继续？')) return;
      }
      s.startTask(urls, `批量下载 ${urls.length} 个链接`);
      urlsText.value = '';
    }

    return { urlsText, startBatch };
  },
  template: `
    <div class="page-header">
      <div class="page-label">Batch</div>
      <h1>批量下载</h1>
    </div>
    <div class="batch-page">
      <div class="url-card">
        <div class="url-card-label"><span class="dot"></span> URLS</div>
        <h3>每行一个链接</h3>
        <textarea v-model="urlsText" rows="12" placeholder="https://www.douyin.com/video/xxx&#10;https://www.douyin.com/user/xxx&#10;https://v.douyin.com/xxx"></textarea>
        <button class="btn btn-primary btn-large" :disabled="!urlsText.trim()" @click="startBatch">添加到任务队列</button>
      </div>
    </div>
  `
};

const PageTasks = {
  setup() {
    const s = inject('store');
    const expanded = ref({});
    const activeTab = ref('download');

    const runningDownloadCount = computed(() => s.tasks.filter(t => t.status === 'running' || t.status === 'cancelling').length);
    const runningSyncCount = computed(() => s.syncs.filter(t => t.status === 'running' || t.status === 'cancelling').length);

    function statusText(status) {
      const map = { running: '运行中', cancelling: '取消中', success: '成功', error: '失败', cancelled: '已取消' };
      return map[status] || status;
    }

    function clearDone() {
      s.tasks = s.tasks.filter(t => t.status === 'running' || t.status === 'cancelling');
      s.syncs = s.syncs.filter(t => t.status === 'running' || t.status === 'cancelling');
      s.relationTasks = s.relationTasks.filter(t => t.status === 'running' || t.status === 'cancelling');
      s.reportTasks = s.reportTasks.filter(t => t.status === 'running' || t.status === 'cancelling');
      s.transcriptTasks = s.transcriptTasks.filter(t => t.status === 'running' || t.status === 'cancelling');
      s.cloudTasks = s.cloudTasks.filter(t => t.status === 'running' || t.status === 'cancelling');
    }

    return { s, expanded, activeTab, runningDownloadCount, runningSyncCount, statusText, clearDone };
  },
  template: `
    <div class="page-header">
      <div class="page-label">Tasks</div>
      <h1>任务中心</h1>
    </div>
    <div class="toolbar">
      <div class="sub-tabs" style="padding:0;border:none;flex:1">
        <button :class="{active: activeTab==='download'}" @click="activeTab='download'">下载任务 {{ s.tasks.length }}</button>
        <button :class="{active: activeTab==='sync'}" @click="activeTab='sync'">同步任务 {{ s.syncs.length }}</button>
        <button :class="{active: activeTab==='relation'}" @click="activeTab='relation'">关注/取关 {{ s.relationTasks.length }}</button>
        <button :class="{active: activeTab==='report'}" @click="activeTab='report'">报表导出 {{ s.reportTasks.length }}</button>
        <button :class="{active: activeTab==='transcript'}" @click="activeTab='transcript'">字幕生成 {{ s.transcriptTasks.length }}</button>
        <button :class="{active: activeTab==='cloud'}" @click="activeTab='cloud'">云同步 {{ s.cloudTasks.length }}</button>
      </div>
      <button class="btn" @click="clearDone">清除已完成</button>
    </div>
    <div class="content">
      <div v-if="activeTab==='download'">
        <div v-if="s.tasks.length===0" class="empty-state"><div class="big-icon" v-html="$icons.clock"></div><div>暂无下载任务</div></div>
        <div v-else class="task-list">
          <div v-for="task in s.tasks" :key="task.id" class="task-card" :class="'status-'+task.status">
            <div class="task-header">
              <div>
                <div class="task-name">{{ task.name }}</div>
                <div class="task-meta">{{ task.createdAt }} · {{ task.urls.length }} 个链接</div>
              </div>
              <div class="task-status">{{ statusText(task.status) }}</div>
            </div>
            <div class="task-step">{{ task.step }}</div>
            <div class="progress-bar"><div class="progress-fill" :style="{width: task.progress+'%'}"></div></div>
            <div class="task-stats">
              <span>总数 {{ task.total }}</span>
              <span class="stat-success">成功 {{ task.success }}</span>
              <span class="stat-failed">失败 {{ task.failed }}</span>
              <span>跳过 {{ task.skipped }}</span>
            </div>
            <div class="task-actions">
              <button class="btn" @click="expanded[task.id]=!expanded[task.id]">{{ expanded[task.id]?'收起日志':'查看日志' }}</button>
              <button class="btn" v-if="task.status==='running'" @click="s.cancelTask(task.id)">取消</button>
            </div>
            <div v-if="expanded[task.id]" class="task-logs">
              <div v-for="(log, idx) in task.logs" :key="idx" class="task-log-line">{{ log }}</div>
            </div>
          </div>
        </div>
      </div>
      <div v-else-if="activeTab==='sync'">
        <div v-if="s.syncs.length===0" class="empty-state"><div class="big-icon" v-html="$icons.refresh"></div><div>暂无同步任务</div></div>
        <div v-else class="task-list">
          <div v-for="sync in s.syncs" :key="sync.id" class="task-card" :class="'status-'+sync.status">
            <div class="task-header">
              <div>
                <div class="task-name">{{ {favorites:'收藏', likes:'喜欢', following:'关注'}[sync.kind] || sync.kind }} 同步</div>
                <div class="task-meta">{{ sync.createdAt }}</div>
              </div>
              <div class="task-status">{{ statusText(sync.status) }}</div>
            </div>
            <div class="task-step">{{ sync.step }}</div>
            <div class="progress-bar"><div class="progress-fill" :style="{width: sync.progress+'%'}"></div></div>
            <div class="task-actions">
              <button class="btn" @click="expanded[sync.id]=!expanded[sync.id]">{{ expanded[sync.id]?'收起日志':'查看日志' }}</button>
              <button class="btn" v-if="sync.status==='running'" @click="s.cancelSync(sync.id)">取消</button>
            </div>
            <div v-if="expanded[sync.id]" class="task-logs">
              <div v-for="(log, idx) in sync.logs" :key="idx" class="task-log-line">{{ log }}</div>
            </div>
          </div>
        </div>
      </div>
      <div v-else-if="activeTab==='relation'">
        <div v-if="s.relationTasks.length===0" class="empty-state"><div class="big-icon" v-html="$icons.users"></div><div>暂无批量关注/取关任务</div></div>
        <div v-else class="task-list">
          <div v-for="task in s.relationTasks" :key="task.id" class="task-card" :class="'status-'+task.status">
            <div class="task-header">
              <div>
                <div class="task-name">{{ task.action==='follow'?'批量关注':'批量取关' }}</div>
                <div class="task-meta">{{ task.createdAt }}</div>
              </div>
              <div class="task-status">{{ statusText(task.status) }}</div>
            </div>
            <div class="task-step">{{ task.step }}</div>
            <div class="progress-bar"><div class="progress-fill" :style="{width: task.progress+'%'}"></div></div>
            <div class="task-actions">
              <button class="btn" @click="expanded[task.id]=!expanded[task.id]">{{ expanded[task.id]?'收起日志':'查看日志' }}</button>
              <button class="btn" v-if="task.status==='running'" @click="s.cancelRelationTask(task.id)">取消</button>
            </div>
            <div v-if="expanded[task.id]" class="task-logs">
              <div v-for="(log, idx) in task.logs" :key="idx" class="task-log-line">{{ log }}</div>
            </div>
          </div>
        </div>
      </div>
      <div v-else-if="activeTab==='report'">
        <div v-if="s.reportTasks.length===0" class="empty-state"><div class="big-icon" v-html="$icons.chart"></div><div>暂无报表导出任务</div></div>
        <div v-else class="task-list">
          <div v-for="task in s.reportTasks" :key="task.id" class="task-card" :class="'status-'+task.status">
            <div class="task-header">
              <div>
                <div class="task-name">下载报表导出</div>
                <div class="task-meta">{{ task.createdAt }}</div>
              </div>
              <div class="task-status">{{ statusText(task.status) }}</div>
            </div>
            <div class="task-step">{{ task.step }}</div>
            <div class="progress-bar"><div class="progress-fill" :style="{width: task.progress+'%'}"></div></div>
            <div v-if="task.result" class="task-result">
              <div v-for="f in task.result" :key="f" class="result-file">{{ f }}</div>
            </div>
            <div class="task-actions">
              <button class="btn" @click="expanded[task.id]=!expanded[task.id]">{{ expanded[task.id]?'收起日志':'查看日志' }}</button>
              <button class="btn" v-if="task.status==='running'" @click="s.cancelReport(task.id)">取消</button>
            </div>
            <div v-if="expanded[task.id]" class="task-logs">
              <div v-for="(log, idx) in task.logs" :key="idx" class="task-log-line">{{ log }}</div>
            </div>
          </div>
        </div>
      </div>
      <div v-else-if="activeTab==='transcript'">
        <div v-if="s.transcriptTasks.length===0" class="empty-state"><div class="big-icon" v-html="$icons.fileText"></div><div>暂无字幕生成任务</div></div>
        <div v-else class="task-list">
          <div v-for="task in s.transcriptTasks" :key="task.id" class="task-card" :class="'status-'+task.status">
            <div class="task-header">
              <div>
                <div class="task-name">字幕生成</div>
                <div class="task-meta">{{ task.createdAt }}</div>
              </div>
              <div class="task-status">{{ statusText(task.status) }}</div>
            </div>
            <div class="task-step">{{ task.step }}</div>
            <div class="progress-bar"><div class="progress-fill" :style="{width: task.progress+'%'}"></div></div>
            <div v-if="task.outputs && task.outputs.length" class="task-result">
              <div v-for="f in task.outputs" :key="f" class="result-file">{{ f }}</div>
            </div>
            <div class="task-actions">
              <button class="btn" @click="expanded[task.id]=!expanded[task.id]">{{ expanded[task.id]?'收起日志':'查看日志' }}</button>
              <button class="btn" v-if="task.status==='running'" @click="s.cancelTranscript(task.id)">取消</button>
            </div>
            <div v-if="expanded[task.id]" class="task-logs">
              <div v-for="(log, idx) in task.logs" :key="idx" class="task-log-line">{{ log }}</div>
            </div>
          </div>
        </div>
      </div>
      <div v-else-if="activeTab==='cloud'">
        <div v-if="s.cloudTasks.length===0" class="empty-state"><div class="big-icon" v-html="$icons.cloud"></div><div>暂无云同步任务</div></div>
        <div v-else class="task-list">
          <div v-for="task in s.cloudTasks" :key="task.id" class="task-card" :class="'status-'+task.status">
            <div class="task-header">
              <div>
                <div class="task-name">{{ task.kind==='backup'?'云端备份':'云端恢复' }}</div>
                <div class="task-meta">{{ task.createdAt }}</div>
              </div>
              <div class="task-status">{{ statusText(task.status) }}</div>
            </div>
            <div class="task-step">{{ task.step }}</div>
            <div class="progress-bar"><div class="progress-fill" :style="{width: task.progress+'%'}"></div></div>
            <div v-if="task.token" class="task-result">
              <div class="result-token">恢复 Token（请妥善保存）：<code>{{ task.token }}</code></div>
            </div>
            <div class="task-actions">
              <button class="btn" @click="expanded[task.id]=!expanded[task.id]">{{ expanded[task.id]?'收起日志':'查看日志' }}</button>
              <button class="btn" v-if="task.status==='running'" @click="s.cancelCloud(task.id)">取消</button>
            </div>
            <div v-if="expanded[task.id]" class="task-logs">
              <div v-for="(log, idx) in task.logs" :key="idx" class="task-log-line">{{ log }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `
};

const PageArchive = {
  setup() {
    const s = inject('store');
    const loading = ref(false);
    const search = ref('');
    const sortKey = ref('mtime-desc');
    const authorFilter = ref('all');
    const dateFilter = ref('all');
    const previewVideo = ref(null);
    const showReportModal = ref(false);
    const reportDateFrom = ref('');
    const reportDateTo = ref('');
    const reportGroupBy = ref('author');
    const reportFormats = ref({ excel: true, html: false });

    async function refresh() {
      loading.value = true;
      await s.loadArchive();
      loading.value = false;
    }

    const authors = computed(() => {
      const map = new Map();
      s.archive.forEach(item => {
        const name = item.name.split('_').pop() || item.name;
        map.set(name, (map.get(name) || 0) + 1);
      });
      return Array.from(map.entries()).map(([name, count]) => ({ name, count }));
    });

    const filteredArchive = computed(() => {
      let list = [...s.archive];
      const q = search.value.trim().toLowerCase();
      if (q) list = list.filter(i => i.name.toLowerCase().includes(q));
      if (authorFilter.value !== 'all') {
        list = list.filter(i => i.name.toLowerCase().includes(authorFilter.value.toLowerCase()));
      }
      if (dateFilter.value !== 'all') {
        const now = new Date();
        list = list.filter(i => {
          const m = new Date(i.mtime);
          if (dateFilter.value === 'today') return m.toDateString() === now.toDateString();
          if (dateFilter.value === 'week') return (now - m) < 7 * 86400000;
          if (dateFilter.value === 'month') return (now - m) < 30 * 86400000;
          return true;
        });
      }
      if (sortKey.value === 'mtime-desc') list.sort((a, b) => b.mtime.localeCompare(a.mtime));
      if (sortKey.value === 'mtime-asc') list.sort((a, b) => a.mtime.localeCompare(b.mtime));
      if (sortKey.value === 'name-asc') list.sort((a, b) => a.name.localeCompare(b.name));
      return list;
    });

    function openVideo(item) {
      if (item.videos && item.videos.length > 0) {
        previewVideo.value = item.videos[0].path;
      }
    }

    function closePreview() {
      previewVideo.value = null;
    }

    function generateTranscript(item) {
      if (!item.videos || item.videos.length === 0) return;
      s.startTranscript(item.videos[0].path, {});
      s.currentPage = 'tasks';
    }

    async function exportReport() {
      const formats = [];
      if (reportFormats.value.excel) formats.push('excel');
      if (reportFormats.value.html) formats.push('html');
      if (formats.length === 0) {
        alert('请至少选择一种导出格式');
        return;
      }
      s.exportReport({
        dateFrom: reportDateFrom.value,
        dateTo: reportDateTo.value,
        groupBy: reportGroupBy.value,
        formats,
        outputDir: s.settings.outputPath,
      });
      showReportModal.value = false;
      s.currentPage = 'tasks';
    }

    return {
      s, loading, refresh, search, sortKey, authorFilter, dateFilter,
      authors, filteredArchive, previewVideo, openVideo, closeVideo: closePreview,
      generateTranscript, showReportModal, reportDateFrom, reportDateTo,
      reportGroupBy, reportFormats, exportReport,
    };
  },
  template: `
    <div class="page-header">
      <div class="page-label">Archive</div>
      <h1>作品档案</h1>
      <div class="sync-bar" style="margin-left:auto;width:auto;gap:12px;background:transparent;border:none;padding:0">
        <button class="btn" @click="refresh" :disabled="loading"><span v-html="$icons.refresh"></span> 刷新</button>
        <button class="btn" @click="showReportModal=true"><span v-html="$icons.chart"></span> 导出报表</button>
      </div>
    </div>
    <div class="toolbar">
      <div class="search-box"><span class="icon" v-html="$icons.search"></span><input v-model="search" placeholder="搜索档案名称" /></div>
      <div class="dropdown">
        <select v-model="authorFilter">
          <option value="all">全部作者</option>
          <option v-for="a in authors" :key="a.name" :value="a.name">{{ a.name }} ({{ a.count }})</option>
        </select>
      </div>
      <div class="dropdown">
        <select v-model="dateFilter">
          <option value="all">全部时间</option>
          <option value="today">今天</option>
          <option value="week">最近 7 天</option>
          <option value="month">最近 30 天</option>
        </select>
      </div>
      <div class="dropdown">
        <select v-model="sortKey">
          <option value="mtime-desc">时间 ↓</option>
          <option value="mtime-asc">时间 ↑</option>
          <option value="name-asc">名称 ↑</option>
        </select>
      </div>
    </div>
    <div class="content">
      <div v-if="s.archive.length===0" class="empty-state"><div class="big-icon" v-html="$icons.archive"></div><div>暂无已下载作品</div></div>
      <div v-else-if="filteredArchive.length===0" class="empty-state"><div class="big-icon" v-html="$icons.search"></div><div>没有符合条件的档案</div></div>
      <div v-else class="archive-grid">
        <div v-for="item in filteredArchive" :key="item.path" class="archive-card">
          <div class="archive-folder" @click="s.openFolder(item.path)" v-html="$icons.folder"></div>
          <div class="archive-name" @click="s.openFolder(item.path)">{{ item.name }}</div>
          <div class="archive-count">{{ item.videoCount }} 个视频 · {{ item.files.length }} 个文件</div>
          <div class="archive-actions">
            <button class="btn" v-if="item.videoCount>0" @click="openVideo(item)"><span v-html="$icons.play"></span> 播放</button>
            <button class="btn" @click="s.openFolder(item.path)">打开目录</button>
            <button class="btn" v-if="item.videoCount>0" @click="generateTranscript(item)"><span v-html="$icons.fileText"></span> 字幕</button>
            <button class="btn" @click="s.deleteArchive(item.path)">删除</button>
          </div>
        </div>
      </div>
    </div>
    <div v-if="previewVideo" class="video-modal" @click.self="closeVideo">
      <div class="video-modal-content">
        <button class="btn btn-icon video-modal-close" @click="closeVideo" v-html="$icons.close"></button>
        <video controls autoplay :src="'file:///'+previewVideo"></video>
      </div>
    </div>
    <div v-if="showReportModal" class="video-modal" @click.self="showReportModal=false">
      <div class="video-modal-content report-modal">
        <button class="btn btn-icon video-modal-close" @click="showReportModal=false" v-html="$icons.close"></button>
        <h3>导出下载报表</h3>
        <div class="setting-row"><label>起始日期</label><input type="date" v-model="reportDateFrom" /></div>
        <div class="setting-row"><label>结束日期</label><input type="date" v-model="reportDateTo" /></div>
        <div class="setting-row"><label>分组维度</label>
          <select v-model="reportGroupBy">
            <option value="author">按作者</option>
            <option value="date">按日期</option>
            <option value="mode">按模式</option>
          </select>
        </div>
        <div class="setting-row"><label>导出格式</label>
          <div class="setting-checks">
            <label><input type="checkbox" v-model="reportFormats.excel" /> Excel</label>
            <label><input type="checkbox" v-model="reportFormats.html" /> HTML</label>
          </div>
        </div>
        <button class="btn btn-primary" @click="exportReport">开始导出</button>
      </div>
    </div>
  `
};

const PageSettings = {
  setup() {
    const s = inject('store');
    const saved = ref(false);
    const showToken = ref(false);
    const restoreToken = ref('');
    const filenameInput = ref(null);

    const filenameTokens = [
      { label: '日期', value: '{日期}' },
      { label: '年份', value: '{年份}' },
      { label: '月份', value: '{月份}' },
      { label: '日', value: '{日}' },
      { label: '发布时间', value: '{发布时间}' },
      { label: '时', value: '{时}' },
      { label: '分', value: '{分}' },
      { label: '秒', value: '{秒}' },
      { label: '作者昵称', value: '{作者昵称}' },
      { label: '作者ID', value: '{作者ID}' },
      { label: '作品标题', value: '{作品标题}' },
      { label: '作品ID', value: '{作品ID}' },
      { label: '作品类型', value: '{作品类型}' },
      { label: '下载模式', value: '{下载模式}' },
    ];

    function insertToken(token) {
      const input = filenameInput.value;
      if (!input) {
        s.settings.filenameTemplate += token.value;
        return;
      }
      const start = input.selectionStart || 0;
      const end = input.selectionEnd || 0;
      const before = s.settings.filenameTemplate.substring(0, start);
      const after = s.settings.filenameTemplate.substring(end);
      s.settings.filenameTemplate = before + token.value + after;
      nextTick(() => {
        const pos = start + token.value.length;
        input.focus();
        input.setSelectionRange(pos, pos);
      });
    }

    function onTokenDragStart(event, token) {
      event.dataTransfer.setData('text/plain', token.value);
      event.dataTransfer.effectAllowed = 'copy';
    }

    function onFilenameDrop(event) {
      event.preventDefault();
      const text = event.dataTransfer.getData('text/plain');
      if (!text) return;
      const token = filenameTokens.find(t => t.value === text);
      if (token) insertToken(token);
    }

    function onFilenameDragOver(event) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }

    async function chooseFolder() {
      const dir = await s.selectFolder();
      if (dir) s.settings.outputPath = dir;
    }

    async function save() {
      await s.saveSettings();
      await s.checkAuth();
      s.applyTheme(s.settings.theme);
      saved.value = true;
      setTimeout(() => saved.value = false, 2000);
    }

    async function logout() {
      await s.logout();
    }

    function runBackup() {
      s.backupCloud();
      s.currentPage = 'tasks';
    }

    function runRestore() {
      if (!restoreToken.value.trim()) {
        alert('请输入恢复 Token');
        return;
      }
      s.restoreCloud(restoreToken.value.trim());
      restoreToken.value = '';
      s.currentPage = 'tasks';
    }

    return {
      s, saved, chooseFolder, save, logout, showToken, restoreToken, runBackup, runRestore,
      filenameInput, filenameTokens, insertToken, onTokenDragStart, onFilenameDrop, onFilenameDragOver,
    };
  },
  template: `
    <div class="page-header">
      <div class="page-label">Settings</div>
      <h1>设置</h1>
    </div>
    <div class="settings-page">
      <div class="settings-card">
        <h3>下载目录</h3>
        <div class="setting-row">
          <input v-model="s.settings.outputPath" readonly placeholder="选择保存目录" />
          <button class="btn" @click="chooseFolder">浏览...</button>
        </div>
      </div>
      <div class="settings-card">
        <h3>账号登录</h3>
        <p style="color: var(--text-secondary); font-size: 13px; margin: 0 0 14px;">点击「登录抖音」将打开内置浏览器访问抖音官网，登录后会自动保存 Cookie。</p>
        <div class="setting-actions">
          <button class="btn btn-primary" @click="s.loginWithBrowser()" v-if="!s.user.isLoggedIn">登录抖音</button>
          <button class="btn" @click="logout" v-if="s.user.isLoggedIn">退出登录</button>
          <span v-if="s.user.isLoggedIn" class="login-status">已登录：{{ s.user.nickname }}</span>
          <span v-else class="login-status offline">当前未登录</span>
        </div>
      </div>
      <div class="settings-card">
        <h3>网络与并发</h3>
        <div class="setting-row">
          <label>并发数</label><input type="number" v-model.number="s.settings.thread" min="1" max="20" />
        </div>
        <div class="setting-row">
          <label>重试次数</label><input type="number" v-model.number="s.settings.retryTimes" min="0" max="10" />
        </div>
        <div class="setting-row">
          <label>代理</label><input v-model="s.settings.proxy" placeholder="http://127.0.0.1:7890" />
        </div>
      </div>
      <div class="settings-card">
        <h3>下载选项</h3>
        <div class="setting-checks">
          <label><input type="checkbox" v-model="s.settings.cover" /> 封面</label>
          <label><input type="checkbox" v-model="s.settings.music" /> 音乐</label>
          <label><input type="checkbox" v-model="s.settings.avatar" /> 头像</label>
          <label><input type="checkbox" v-model="s.settings.downloadImages" /> 图片</label>
          <label><input type="checkbox" v-model="s.settings.downloadLivePhotos" /> Live 图</label>
          <label><input type="checkbox" v-model="s.settings.database" /> SQLite 去重</label>
        </div>
        <div class="setting-row" style="margin-top: 14px; align-items: flex-start;">
          <label>文件名模板</label>
          <div style="flex:1; display:flex; flex-direction:column; gap:10px;">
            <input
              ref="filenameInput"
              v-model="s.settings.filenameTemplate"
              placeholder="把下方变量拖到这里"
              @drop="onFilenameDrop"
              @dragover="onFilenameDragOver"
              style="width:100%; box-sizing:border-box;"
            />
            <div class="filename-tokens">
              <span
                v-for="token in filenameTokens"
                :key="token.value"
                class="filename-token"
                draggable="true"
                @dragstart="onTokenDragStart($event, token)"
                @click="insertToken(token)"
              >{{ token.label }}</span>
            </div>
          </div>
        </div>
        <p style="color: var(--text-secondary); font-size: 13px; margin: 14px 0 0;">拖动下方变量到输入框即可组成文件名；作品将保存在「保存目录/博主昵称/」下，不再生成 post 子文件夹、作品子文件夹和元数据 JSON。</p>
      </div>
      <div class="settings-card">
        <h3>画质</h3>
        <div class="setting-row">
          <select v-model="s.settings.videoQuality">
            <option value="highest">最高画质</option>
            <option value="lowest">最低画质</option>
            <option value="1080p">1080p</option>
            <option value="720p">720p</option>
            <option value="540p">540p</option>
          </select>
        </div>
      </div>
      <div class="settings-card">
        <h3>浏览器回补</h3>
        <p style="color: var(--text-secondary); font-size: 13px; margin: 0 0 14px;">当接口被限制时，用浏览器滚动作者主页兜底采集。关闭「可见窗口」后遇到验证码无法人工验证。</p>
        <div class="setting-row">
          <label>启用浏览器回补</label>
          <label class="setting-checks"><input type="checkbox" v-model="s.settings.browserFallback.enabled" /> 接口受限时自动打开浏览器采集</label>
        </div>
        <div class="setting-row">
          <label>可见窗口</label>
          <label class="setting-checks"><input type="checkbox" v-model="s.settings.browserFallback.headless" /> 无头模式（不推荐）</label>
        </div>
        <div class="setting-row">
          <label>最大滚动次数</label><input type="number" v-model.number="s.settings.browserFallback.maxScrolls" min="50" max="5000" />
        </div>
      </div>
      <div class="settings-card">
        <h3>批量关注/取关</h3>
        <div class="setting-row">
          <label>最小间隔(秒)</label><input type="number" v-model.number="s.settings.relation.minDelay" min="0.5" max="60" step="0.5" />
        </div>
        <div class="setting-row">
          <label>最大间隔(秒)</label><input type="number" v-model.number="s.settings.relation.maxDelay" min="0.5" max="120" step="0.5" />
        </div>
        <div class="setting-row">
          <label>演练模式</label>
          <label class="setting-checks"><input type="checkbox" v-model="s.settings.relation.dryRun" /> 只模拟请求，不真正关注/取关</label>
        </div>
      </div>
      <div class="settings-card">
        <h3>字幕生成（Whisper）</h3>
        <div class="setting-row">
          <label>下载后自动生成</label>
          <label class="setting-checks"><input type="checkbox" v-model="s.settings.transcript.enabled" /> 启用</label>
        </div>
        <div class="setting-row">
          <label>模式</label>
          <select v-model="s.settings.transcript.mode">
            <option value="api">OpenAI API</option>
            <option value="local">本地 Whisper</option>
          </select>
        </div>
        <div class="setting-row">
          <label>API Key</label>
          <input :type="showToken?'text':'password'" v-model="s.settings.transcript.apiKey" placeholder="sk-..." />
          <button class="btn" @click="showToken=!showToken">{{ showToken?'隐藏':'显示' }}</button>
        </div>
        <div class="setting-row">
          <label>模型</label>
          <input v-model="s.settings.transcript.model" placeholder="gpt-4o-mini-transcribe" />
        </div>
        <div class="setting-row">
          <label>语言</label>
          <input v-model="s.settings.transcript.language" placeholder="zh / en / auto" />
        </div>
      </div>
      <div class="settings-card">
        <h3>云同步</h3>
        <div class="setting-row">
          <label>Provider</label>
          <select v-model="s.settings.cloudSync.provider">
            <option value="">不使用</option>
            <option value="s3">AWS S3 / 兼容 S3</option>
            <option value="oss">阿里云 OSS</option>
          </select>
        </div>
        <div class="setting-row">
          <label>AccessKey ID</label>
          <input v-model="s.settings.cloudSync.accessKeyId" placeholder="LTAI..." />
        </div>
        <div class="setting-row">
          <label>AccessKey Secret</label>
          <input :type="showToken?'text':'password'" v-model="s.settings.cloudSync.accessKeySecret" placeholder="..." />
        </div>
        <div class="setting-row">
          <label>Bucket</label>
          <input v-model="s.settings.cloudSync.bucket" placeholder="my-bucket" />
        </div>
        <div class="setting-row">
          <label>Region</label>
          <input v-model="s.settings.cloudSync.region" placeholder="cn-hangzhou / us-east-1" />
        </div>
        <div class="setting-row">
          <label>Endpoint</label>
          <input v-model="s.settings.cloudSync.endpoint" placeholder="可选，OSS 自定义域名" />
        </div>
        <div class="setting-actions">
          <button class="btn btn-primary" @click="runBackup">立即备份</button>
          <input v-model="restoreToken" placeholder="输入恢复 Token" style="flex:1" />
          <button class="btn" @click="runRestore">从 Token 恢复</button>
        </div>
      </div>
      <div class="settings-card">
        <h3>全局快捷键</h3>
        <div class="setting-row">
          <label>启用快捷键</label>
          <label class="setting-checks"><input type="checkbox" v-model="s.settings.shortcuts.enabled" /> 启用</label>
        </div>
        <div class="setting-row">
          <label>粘贴并下载</label><input v-model="s.settings.shortcuts.pasteDownload" placeholder="Ctrl+Shift+V" />
        </div>
        <div class="setting-row">
          <label>显示/隐藏窗口</label><input v-model="s.settings.shortcuts.toggleWindow" placeholder="Ctrl+Shift+D" />
        </div>
        <div class="setting-row">
          <label>暂停全部</label><input v-model="s.settings.shortcuts.pauseAll" placeholder="Ctrl+Shift+P" />
        </div>
      </div>
      <button class="btn btn-primary btn-large" @click="save">{{ saved ? '已保存' : '保存设置' }}</button>
    </div>
  `
};

const app = createApp({
  components: { PageLogin, PageFollowing, PageFavorites, PageNewReleases, PageDownloads, PageBatch, PageTasks, PageArchive, PageSettings },
  setup() {
    provide('store', store);

    const isMaximized = ref(false);
    const menu = [
      { key: 'following', label: '关注', icon: icons.user },
      { key: 'favorites', label: '收藏', icon: icons.bookmark },
      { key: 'newReleases', label: '新发布', icon: icons.refresh },
      { section: '本地' },
      { key: 'downloads', label: '下载', icon: icons.download },
      { key: 'batch', label: '批量下载', icon: icons.layers },
      { key: 'tasks', label: '任务中心', icon: icons.clock },
      { key: 'archive', label: '作品档案', icon: icons.folder },
      { key: 'settings', label: '设置', icon: icons.settings },
    ];

    store.loadSettings();

    if (window.electronAPI) {
      window.electronAPI.onDownloadProgress(store.onProgress);
      window.electronAPI.onDownloadLog(store.onLog);
      window.electronAPI.onDownloadFinished(store.onFinished);

      window.electronAPI.onSyncProgress(store.onSyncProgress);
      window.electronAPI.onSyncLog(store.onSyncLog);
      window.electronAPI.onSyncFinished(store.onSyncFinished);

      window.electronAPI.onRelationProgress(store.onRelationProgress);
      window.electronAPI.onRelationLog(store.onRelationLog);
      window.electronAPI.onRelationFinished(store.onRelationFinished);

      window.electronAPI.onReportProgress(store.onReportProgress);
      window.electronAPI.onReportLog(store.onReportLog);
      window.electronAPI.onReportFinished(store.onReportFinished);

      window.electronAPI.onTranscriptProgress(store.onTranscriptProgress);
      window.electronAPI.onTranscriptLog(store.onTranscriptLog);
      window.electronAPI.onTranscriptFinished(store.onTranscriptFinished);

      window.electronAPI.onCloudProgress(store.onCloudProgress);
      window.electronAPI.onCloudLog(store.onCloudLog);
      window.electronAPI.onCloudFinished(store.onCloudFinished);

      window.electronAPI.onUserWorksProgress(store.onUserWorksProgress);
      window.electronAPI.onUserWorksLog(store.onUserWorksLog);
      window.electronAPI.onUserWorksFinished(store.onUserWorksFinished);

      window.electronAPI.onNewReleasesProgress(store.onNewReleasesProgress);
      window.electronAPI.onNewReleasesLog(store.onNewReleasesLog);
      window.electronAPI.onNewReleasesFinished(store.onNewReleasesFinished);

      window.electronAPI.onShortcutTriggered((payload) => {
        if (payload.action === 'pasteDownload' && payload.url) {
          store.currentPage = 'downloads';
          setTimeout(() => {
            store.startTask(payload.url, '快捷键粘贴下载');
          }, 100);
        } else if (payload.action === 'pauseAll') {
          store.tasks.filter(t => t.status === 'running').forEach(t => store.cancelTask(t.id));
          store.syncs.filter(t => t.status === 'running').forEach(t => store.cancelSync(t.id));
        }
      });
    }

    async function minimize() { if (window.electronAPI) await window.electronAPI.minimize(); }
    async function maximize() {
      if (window.electronAPI) {
        await window.electronAPI.maximize();
        isMaximized.value = await window.electronAPI.isMaximized();
      }
    }
    async function closeWin() { if (window.electronAPI) await window.electronAPI.close(); }

    return { store, menu, isMaximized, minimize, maximize, closeWin, icons };
  },
  template: `
    <div class="window-frame">
      <div class="title-bar">
        <div class="brand">
          <div class="logo">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 2L14.5 9H22L16 13.5L18.5 21L12 16.5L5.5 21L8 13.5L2 9H9.5L12 2Z" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="1.5" stroke-linejoin="round"/>
            </svg>
          </div>
          <span>DRaccoon</span>
        </div>
        <div class="window-controls">
          <button @click="minimize" title="最小化" v-html="icons.winMinimize"></button>
          <button @click="maximize" title="最大化">
            <span v-if="!isMaximized" v-html="icons.winMaximize"></span>
            <span v-else v-html="icons.winRestore"></span>
          </button>
          <button class="close" @click="closeWin" title="关闭" v-html="icons.winClose"></button>
        </div>
      </div>
      <div class="app-body" v-if="store.authChecked">
        <aside class="sidebar">
          <div class="account-card">
            <div class="row">
              <img v-if="store.user.avatar" :src="store.user.avatar" class="avatar-small" />
              <span v-else class="avatar-small avatar-fallback" v-html="icons.user"></span>
              <div class="account-meta">
                <div class="name">{{ store.user.nickname || '抖音账号' }}</div>
                <div class="status" :class="{offline: !store.user.isLoggedIn}"><span class="dot"></span> {{ store.user.isLoggedIn ? '已登录' : '未登录' }}</div>
              </div>
              <button v-if="store.user.isLoggedIn" @click="store.currentPage='settings'">管理</button>
              <button v-else class="btn-login-sidebar" @click="store.loginWithBrowser()">登录抖音</button>
            </div>
          </div>
          <ul class="nav-menu">
            <template v-for="item in menu">
              <li v-if="item.section" class="nav-section" :key="'sec-'+item.section">{{ item.section }}</li>
              <li v-else :key="item.key" :class="{active: store.currentPage===item.key}" @click="store.currentPage=item.key">
                <span class="icon" v-html="item.icon"></span><span>{{ item.label }}</span>
              </li>
            </template>
          </ul>
        </aside>
        <main class="main">
          <component :is="'Page' + (store.currentPage.charAt(0).toUpperCase() + store.currentPage.slice(1))"></component>
        </main>
      </div>
      <div v-else class="login-page"><div class="login-card">初始化中...</div></div>
    </div>
  `
});

app.component('PageLogin', PageLogin);

app.config.globalProperties.$store = store;
app.config.globalProperties.$formatTimeLabel = formatTimeLabel;
app.config.globalProperties.$formatDate = formatDate;
app.config.globalProperties.$formatFileSize = formatFileSize;
app.config.globalProperties.$icons = icons;
app.mount('#app');
