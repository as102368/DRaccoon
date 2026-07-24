const { createApp, ref, computed, reactive, provide, inject, watch, onMounted, onUnmounted, onActivated, nextTick } = Vue;

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

function relativeTime(dateInput) {
  let d = dateInput;
  if (typeof d === 'number') d = new Date(d);
  if (typeof d === 'string') d = new Date(d);
  if (!d || isNaN(d.getTime())) return '';
  const now = Date.now();
  const diff = Math.floor((now - d.getTime()) / 1000);
  if (diff < 5) return '刚刚';
  if (diff < 60) return `${diff} 秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)} 天前`;
  return d.toLocaleString();
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
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(obj);
    } catch (e) {
      // 循环引用等 fallback 到 JSON
    }
  }
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
  music: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>',
  more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1.5"></circle><circle cx="19" cy="12" r="1.5"></circle><circle cx="5" cy="12" r="1.5"></circle></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
  winMinimize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line></svg>',
  winMaximize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="1" ry="1"></rect></svg>',
  winRestore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="4" width="12" height="12" rx="1" ry="1"></rect><path d="M4 8v12h12"></path></svg>',
  winClose: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>',
  fileText: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>',
  cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path></svg>',
  archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>',
  rotateCw: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>',
  trash2: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
  fileDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><polyline points="12 18 12 12"></polyline><polyline points="9 15 12 18 15 15"></polyline></svg>',
  checkCircle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>',
  xCircle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>',
  alertCircle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>',
  loader: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg>',
  filter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>',
  moreVertical: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg>',
  zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>',
  checkSquare: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>',
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
  downloadPinned: true,
  database: true,
  folderstyle: false,
  filenameTemplate: '{日期}_{标题}',
  videoQuality: 'highest',
  queueUrlMaxRuntimeMinutes: 30,
  syncLimits: {
    favorites: 50000,
    collections: 50000,
    likes: 50000,
    following: 50000,
    topics: 50000,
    favoritesMusic: 50000,
    newReleasesAuthors: 200,
    newReleasesPerAuthor: 30,
    newReleasesAuthorSource: 'downloaded',
    newReleasesDays: 7,
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
  },
  browserFallback: {
    enabled: false,
    headless: false,
    maxScrolls: 500,
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
  autoSync: {
    following: false,
    favorites: false,
    newReleases: false,
  },
};

const store = reactive({
  settings: { ...defaultSettings },
  tasks: [],
  archive: [],
  syncs: [],
  relationTasks: [],
  reportTasks: [],
  cloudTasks: [],
  dedupTasks: [],
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
    new_releases: null,
    topics: null,
  },
  archiveStatus: {},
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
  toast: {
    show: false,
    message: '',
    timer: null,
  },
});

store.applyTheme = (theme) => {
  const effective = theme === 'light' ? 'light' : 'dark';
  store.effectiveTheme = effective;
  document.documentElement.setAttribute('data-theme', effective);
};

store.showToast = (message, duration = 1000) => {
  store.toast.message = message;
  store.toast.show = true;
  if (store.toast.timer) clearTimeout(store.toast.timer);
  store.toast.timer = setTimeout(() => {
    store.toast.show = false;
  }, duration);
};

// ========== 任务记录本地持久化（localStorage）==========
const TASK_HISTORY_KEY = 'douzy.tasks.history';
const MAX_HISTORY_TASKS = 500;
const MAX_LOGS_PER_TASK = 100;

store.serializeTaskForHistory = (task) => {
  const raw = Vue.toRaw ? Vue.toRaw(task) : JSON.parse(JSON.stringify(task));
  const clone = { ...raw };
  if (Array.isArray(clone.logs) && clone.logs.length > MAX_LOGS_PER_TASK) {
    clone.logs = clone.logs.slice(-MAX_LOGS_PER_TASK);
  }
  // urlResults 仅用于当前会话的精准重试，持久化会显著增加 localStorage 占用
  if (Array.isArray(clone.urlResults)) {
    delete clone.urlResults;
  }
  return clone;
};

let saveTaskHistoryTimer = null;
function flushSaveTaskHistory() {
  saveTaskHistoryTimer = null;
  try {
    const all = [
      ...store.tasks,
      ...store.syncs,
      ...store.relationTasks,
      ...store.reportTasks,
      ...store.cloudTasks,
      ...store.dedupTasks,
    ].map(store.serializeTaskForHistory);
    const trimmed = all.slice(0, MAX_HISTORY_TASKS);
    localStorage.setItem(TASK_HISTORY_KEY, JSON.stringify(trimmed));
  } catch (e) {
    console.error('保存任务历史失败', e);
  }
}
store.saveTaskHistory = () => {
  if (saveTaskHistoryTimer) return;
  saveTaskHistoryTimer = setTimeout(flushSaveTaskHistory, 80);
};

store.loadTaskHistory = () => {
  try {
    const raw = localStorage.getItem(TASK_HISTORY_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const valid = parsed.filter(t => t && typeof t.id === 'string');
    const tasks = [];
    const syncs = [];
    const relationTasks = [];
    const reportTasks = [];
    const cloudTasks = [];
    const dedupTasks = [];
    valid.forEach(t => {
      // 重启时仍在运行中的任务已无法继续，标记为异常终止
      if (t.status === 'running' || t.status === 'cancelling') {
        t.status = 'error';
        t.step = t.step ? `${t.step}（程序重启后中断）` : '程序重启后中断';
      }
      if (t.id.startsWith('task-')) tasks.push(reactive(t));
      else if (t.id.startsWith('sync-')) syncs.push(reactive(t));
      else if (t.id.startsWith('relation-')) relationTasks.push(reactive(t));
      else if (t.id.startsWith('report-')) reportTasks.push(reactive(t));
      else if (t.id.startsWith('cloud-')) cloudTasks.push(reactive(t));
      else if (t.id.startsWith('dedup-')) dedupTasks.push(reactive(t));
    });
    store.tasks = tasks;
    store.syncs = syncs;
    store.relationTasks = relationTasks;
    store.reportTasks = reportTasks;
    store.cloudTasks = cloudTasks;
    store.dedupTasks = dedupTasks;
  } catch (e) {
    console.error('加载任务历史失败', e);
  }
};

store.loadSettings = async () => {
  const s = await window.electronAPI.getSettings();
  store.settings = { ...defaultSettings, ...s };
  if (store.settings.filenameTemplate === undefined || store.settings.filenameTemplate === null || store.settings.filenameTemplate === '') {
    store.settings.filenameTemplate = defaultSettings.filenameTemplate;
  }
  if (!store.settings.syncLimits) store.settings.syncLimits = { ...defaultSettings.syncLimits };
  else store.settings.syncLimits = { ...defaultSettings.syncLimits, ...store.settings.syncLimits };
  if (!store.settings.shortcuts) store.settings.shortcuts = { ...defaultSettings.shortcuts };
  if (!store.settings.relation) store.settings.relation = { ...defaultSettings.relation };
  if (!store.settings.browserFallback) store.settings.browserFallback = { ...defaultSettings.browserFallback };
  if (!store.settings.cloudSync) store.settings.cloudSync = { ...defaultSettings.cloudSync };
  if (!store.settings.autoSync) store.settings.autoSync = { ...defaultSettings.autoSync };
  // 如果 cookie 已被旧版本的脱敏逻辑破坏，清空避免使用无效值校验
  if (typeof store.settings.cookieString === 'string' && store.settings.cookieString.includes('***')) {
    store.settings.cookieString = '';
  }
  store.applyTheme(store.settings.theme);
  store.initialized = true;
  store.loadTaskHistory();
  await store.checkAuth();
  if (store.user.isLoggedIn) {
    store.loadArchive();
    store.loadSyncCache('favorites');
    store.loadSyncCache('likes');
    store.loadSyncCache('following');
    store.loadSyncCache('new_releases');
    store.loadSyncCache('topics');
    store.runAutoSyncs();
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
    if (result.user && result.user.sec_uid) {
      // 后端已完成校验并返回用户信息
      store.user = { ...result.user, isLoggedIn: true };
      store.authChecked = true;
    } else {
      // 扫码后快速完成：立即显示已登录，后台异步获取用户信息
      store.user = { isLoggedIn: true, nickname: '加载中...', avatar: '', sec_uid: '', unique_id: '' };
      store.authChecked = true;
      store.checkAuth().catch((e) => console.error('后台获取用户信息失败', e));
    }
    if (store.user.isLoggedIn) {
      await store.loadArchive();
      await store.loadSyncCache('favorites');
      await store.loadSyncCache('likes');
      await store.loadSyncCache('following');
      await store.loadSyncCache('new_releases');
      await store.loadSyncCache('topics');
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
    database_path: s.outputPath ? window.electronAPI.pathJoinSync(s.outputPath, 'dy_downloader.db') : 'dy_downloader.db',
    folderstyle: Boolean(s.folderstyle),
    filename_template: translateFilenameTemplate(s.filenameTemplate || '{日期}_{标题}'),
    folder_template: '{title}_{id}',
    author_dir: 'nickname',
    group_by_mode: false,
    write_media_metadata: false,
    download_manifest: false,
    download_pinned: Boolean(s.downloadPinned),
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
store.startTask = async (urls, name, downloadContext = null) => {
  if (!Array.isArray(urls)) urls = [urls];
  urls = urls.map(u => String(u).trim()).filter(Boolean);
  if (urls.length === 0) return null;
  const id = 'task-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const nowMs = Date.now();
  const task = reactive({
    id,
    name: name || urls[0],
    urls,
    downloadContext,
    status: 'running',
    progress: 0,
    step: '等待开始',
    total: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    _urlDone: 0,
    urlResults: [],
    logs: [],
    createdAt: new Date(nowMs).toLocaleString(),
    createdAtMs: nowMs,
  });
  store.tasks.unshift(task);
  store.saveTaskHistory();
  try {
    const result = await window.electronAPI.startDownload({
      taskId: id,
      urls,
      config: plain(store.buildConfig()),
      cookies: store.settings.cookieString,
      downloadContext: plain(downloadContext),
    });
    if (!result || result.started === false) {
      task.status = 'error';
      task.step = `启动失败：${result && result.error ? result.error : '未知错误'}`;
      store.saveTaskHistory();
    }
  } catch (err) {
    task.status = 'error';
    task.step = `启动失败：${err && err.message ? err.message : err}`;
    store.saveTaskHistory();
  }
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
  // 已结束的任务不再接受后续进度事件，防止 finished 事件提前到达后迟到的
  // url_result 等事件把失败计数累加回已完成状态。
  if (task.status !== 'running' && task.status !== 'cancelling') return;
  const firstUrl = task.urls[0] || '';
  if (data.event === 'url_start') {
    task.step = `正在处理 ${data.index}/${data.total}`;
    task.logs.push(`[开始] 处理第 ${data.index || 1}/${data.total || 1} 个链接`);
  } else if (data.event === 'step') {
    task.step = data.detail ? `${data.step}：${data.detail}` : data.step;
    task.logs.push(`[步骤] ${data.step}${data.detail ? '：' + data.detail : ''}`);
  } else if (data.event === 'item_total') {
    task.total = (task.total || 0) + (data.total || 0);
    task._urlDone = 0;
    task.progress = 0;
    task.logs.push(`[进度] 共 ${data.total} 个作品待下载`);
  } else if (data.event === 'item_advanced') {
    task._urlDone = (task._urlDone || 0) + 1;
    if (task.total > 0) {
      const done = task.success + task.failed + task.skipped + task._urlDone;
      task.progress = Math.min(100, Math.round((done / task.total) * 100));
    }
    const statusMap = { success: '成功', failed: '失败', skipped: '跳过' };
    const statusText = statusMap[data.status] || data.status || '未知';
    task.logs.push(`[${statusText}] ${data.detail || ''}`);
  } else if (data.event === 'url_result') {
    task.success += data.success || 0;
    task.failed += data.failed || 0;
    task.skipped += data.skipped || 0;
    task._urlDone = 0;
    task.urlResults.push({
      url: data.url,
      success: data.success || 0,
      failed: data.failed || 0,
      skipped: data.skipped || 0,
    });
    if (task.total > 0) {
      const done = task.success + task.failed + task.skipped;
      task.progress = Math.min(100, Math.round((done / task.total) * 100));
    }
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
    if (data.nickname) {
      task.nickname = data.nickname;
    }
    if (data.sec_uid) {
      task.authorSecUid = data.sec_uid;
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
  const { taskId, code, data } = payload;
  const task = store.tasks.find(t => t.id === taskId);
  if (!task) return;
  // 已结束的任务不再处理新的 finished 事件，防止重复收尾或状态被覆盖
  if (task.status !== 'running' && task.status !== 'cancelling') return;

  // 安全读取后端返回的计数，避免字符串、布尔值、NaN 等污染状态
  const pickCount = (obj, keys) => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    }
    return 0;
  };

  // 后端明确报告失败（success=false 或携带 error）时强制按失败处理
  const backendError = data && (data.success === false || (typeof data.error === 'string' && data.error));

  // 使用后端/队列返回的权威汇总数据覆盖当前计数，避免进度事件与 finished 事件
  // 到达顺序不一致导致失败任务被错误标为已完成。
  // 关键：取进度事件与 finished 数据两者的最大值，防止子任务异常退出时
  // finished 数据丢失失败数而将任务误标为成功。
  if (data && typeof data === 'object') {
    const dSuccess = pickCount(data, ['total_success', 'success']);
    const dFailed = pickCount(data, ['total_failed', 'failed']);
    const dSkipped = pickCount(data, ['total_skipped', 'skipped']);
    const dTotal = dSuccess + dFailed + dSkipped;
    task.success = Math.max(task.success || 0, dSuccess);
    task.failed = Math.max(task.failed || 0, dFailed);
    task.skipped = Math.max(task.skipped || 0, dSkipped);
    // total 不能小于各计数之和，避免子任务异常退出时 finished 数据缺失导致显示不一致
    task.total = Math.max(task.total || 0, dTotal, task.success + task.failed + task.skipped);
  }

  task.progress = 100;
  if (task.status === 'cancelling') {
    task.status = 'cancelled';
  } else if (code === 0 && (task.failed || 0) === 0 && !backendError) {
    task.status = 'success';
  } else {
    task.status = 'error';
    if (backendError && (!task.step || !task.step.includes('失败'))) {
      task.step = `失败：${data.error}`;
    }
  }
  if (!task.step || !task.step.includes('失败')) {
    if (task.status === 'success') {
      task.step = '已完成';
    } else if (code === 123) {
      task.step = '任务运行超时，已强制终止';
    } else if (code === 124) {
      task.step = '任务长时间无响应，已强制终止';
    } else if (task.status === 'error' && (task.failed || 0) > 0) {
      task.step = `完成：成功 ${task.success || 0} / 失败 ${task.failed || 0} / 跳过 ${task.skipped || 0}`;
    } else {
      task.step = `结束（code=${code}）`;
    }
  }
  store.saveTaskHistory();
  store.loadArchive();
};

// ========== 启动自动同步 ==========
store.runAutoSyncs = () => {
  if (!store.user.isLoggedIn) return;
  const cfg = store.settings.autoSync || {};
  if (cfg.following) store.startSync('following');
  if (cfg.favorites) store.startSync('favorites', 'folders');
  if (cfg.newReleases) store.startNewReleases();
};

// ========== 同步任务 ==========
store.startSync = async (kind, subKind, query, options = {}) => {
  const existing = store.syncs.find(s => s.kind === kind && s.subKind === subKind && (s.status === 'running' || s.status === 'cancelling'));
  if (existing) return existing.id;
  const id = 'sync-' + kind + (subKind ? '-' + subKind : '') + '-' + Date.now();
  const now = Date.now();
  const sync = reactive({
    id,
    kind,
    subKind,
    query,
    limit: options.limit,
    sortStrategy: options.sortStrategy,
    status: 'running',
    step: '初始化',
    progress: 0,
    total: 0,
    added: 0,
    drained: false,
    errorCount: 0,
    logs: [],
    createdAt: new Date(now).toLocaleString(),
    createdAtMs: now,
    lastProgressAt: now,
  });
  store.syncs.unshift(sync);
  store.saveTaskHistory();
  const limits = { ...plain(store.settings.syncLimits) };
  if (options.limit != null) limits.topics = options.limit;
  if (options.sortStrategy) limits.topicsSortStrategy = options.sortStrategy;
  const payload = {
    syncId: id,
    kind,
    subKind,
    config: plain(store.buildConfig()),
    cookies: store.settings.cookieString,
    limits,
  };
  if (query) {
    payload.query = query;
  }
  try {
    const result = await window.electronAPI.startSync(payload);
    if (!result || result.started === false) {
      sync.status = 'error';
      sync.step = `启动失败：${result && result.error ? result.error : '未知错误'}`;
      store.saveTaskHistory();
    }
  } catch (err) {
    sync.status = 'error';
    sync.step = `启动失败：${err && err.message ? err.message : err}`;
    store.saveTaskHistory();
  }
  return id;
};

store.cancelSync = (id) => {
  const sync = store.syncs.find(s => s.id === id);
  if (!sync || sync.status !== 'running') return;
  sync.status = 'cancelling';
  if (sync.kind === 'newReleases') {
    store.cancelNewReleases();
  } else {
    window.electronAPI.cancelSync(id);
  }
};

store.onSyncProgress = (payload) => {
  const { syncId, data } = payload;
  const sync = store.syncs.find(s => s.id === syncId);
  if (!sync) return;
  // 已结束的同步忽略后续进度事件，避免 step 被迟到事件覆盖
  if (sync.status !== 'running' && sync.status !== 'cancelling' && data.event !== 'sync_done') return;
  sync.lastProgressAt = Date.now();
  if (data.event === 'sync_init') {
    sync.step = '同步进程已启动';
  } else if (data.event === 'sync_start') {
    sync.step = '开始同步';
    sync.total = data.limit || 0;
    sync.added = 0;
  } else if (data.event === 'sync_progress') {
    if (data.kind === 'favorites_collections') {
      sync.step = `同步收藏夹列表：${data.total}`;
    } else if (data.kind === 'collect_mixes') {
      sync.step = `同步合集列表：${data.total}`;
    } else if (data.kind === 'favorites_music') {
      sync.step = `同步收藏音乐：${data.total}`;
      sync.added = data.total || sync.added;
    } else if (data.kind === 'favorites_videos' || data.kind === 'favorites_items' || data.kind === 'likes' || data.kind === 'following') {
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
    } else if (data.kind === 'topics') {
      const topicName = data.topic?.name || '话题';
      if (data.step === 'resolve') {
        sync.step = `已识别话题：${topicName}`;
      } else {
        sync.step = `同步「${topicName}」：${data.total || 0} 条`;
      }
      sync.added = data.total || sync.added;
      if (sync.total > 0) sync.progress = Math.min(100, Math.round((sync.added / sync.total) * 100));
    } else if (data.collection) {
      sync.step = `同步收藏夹「${data.collection}」`;
    }
  } else if (data.event === 'sync_done') {
    sync.step = '同步完成';
    sync.progress = 100;
    sync.drained = data.drained || false;
    if (data.kind) store.loadSyncCache(data.kind);
  } else if (data.event === 'sync_error') {
    sync.errorCount = (sync.errorCount || 0) + 1;
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
  // 已结束的同步不再处理新的 finished 事件
  if (sync.status !== 'running' && sync.status !== 'cancelling') return;
  const hadError = sync.step && String(sync.step).startsWith('错误：');
  const hasErrorCount = (sync.errorCount || 0) > 0;
  if (sync.status === 'cancelling') {
    sync.status = 'cancelled';
    sync.step = '已取消';
  } else if (code === 0 && !hadError && !hasErrorCount) {
    sync.status = 'success';
    sync.step = '同步完成';
  } else {
    sync.status = 'error';
    if (!hadError) sync.step = `同步失败（code=${code}）`;
  }
  store.saveTaskHistory();
  await store.loadSyncCache(kind);
};

store.recoverStalledSyncs = () => {
  const now = Date.now();
  // 新发布同步需要遍历大量博主，正常耗时可能超过 5 分钟，给更长的阈值
  const STALL_TIMEOUT_MS = 5 * 60 * 1000;
  const NEW_RELEASES_STALL_TIMEOUT_MS = 15 * 60 * 1000;
  let changed = false;
  for (const sync of store.syncs) {
    if (sync.status !== 'running' && sync.status !== 'cancelling') continue;
    const timeout = sync.kind === 'newReleases' ? NEW_RELEASES_STALL_TIMEOUT_MS : STALL_TIMEOUT_MS;
    const last = sync.lastProgressAt || sync.createdAtMs || now;
    if (now - last > timeout) {
      sync.status = 'error';
      sync.step = '同步卡住，请重新尝试';
      if (sync.kind === 'newReleases' && store.newReleases.taskId === sync.id) {
        store.newReleases.status = 'error';
        store.newReleases.error = sync.step;
      }
      changed = true;
    }
  }
  if (changed) store.saveTaskHistory();
};

store.loadSyncCache = async (kind) => {
  const cache = await window.electronAPI.getSyncCache(kind);
  store.syncCache[kind] = cache;
  if (kind === 'following' && cache && Array.isArray(cache.items)) {
    const secUids = cache.items.map(u => u.sec_uid).filter(Boolean);
    if (secUids.length > 0) {
      await store.loadArchiveStatus(secUids);
    }
  }
  return cache;
};

store.clearSyncCache = async (kind) => {
  const ok = await window.electronAPI.clearSyncCache(kind);
  if (ok) {
    store.syncCache[kind] = null;
    if (kind === 'new_releases') {
      store.newReleases.items = [];
      store.newReleases.status = 'idle';
      store.newReleases.progress = {};
    }
  }
  return ok;
};

store.saveSyncCache = async (kind, data) => {
  const ok = await window.electronAPI.saveSyncCache(kind, data);
  if (ok) {
    store.syncCache[kind] = data;
  }
  return ok;
};

// ========== 博主作品列表任务 ==========
const USER_WORKS_STALL_MS = 30000;

store.startUserWorks = async (secUid, nickname, forceRefresh = false, expectedTotal = 0, retry = false) => {
  const id = 'userWorks-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
  // 清理该作者已结束的历史任务，避免列表无限增长并防止旧空任务干扰判断
  store.userWorks = store.userWorks.filter(t => !(t.secUid === secUid && t.status !== 'running' && t.status !== 'cancelling'));
  const task = reactive({
    id,
    secUid,
    nickname: nickname || secUid,
    status: 'running',
    progress: 0,
    total: 0,
    items: [],
    step: retry ? '准备低速重试' : '准备中',
    logs: [],
    createdAt: new Date().toLocaleString(),
    lastProgressAt: Date.now(),
  });
  store.userWorks.unshift(task);
  try {
    const result = await window.electronAPI.startUserWorks({
      taskId: id,
      secUid,
      nickname: nickname || secUid,
      cookies: store.settings.cookieString,
      // 单个博主作品不应用 following 列表同步上限，传 0 表示不限制，靠 expectedTotal 判断完整度
      limit: 0,
      expectedTotal,
      retry,
      proxy: store.settings.proxy || '',
      config: plain(store.buildConfig()),
      forceRefresh,
    });
    if (!result || result.started === false) {
      task.status = 'error';
      task.step = `启动失败：${result && result.error ? result.error : '未知错误'}`;
      console.error('[userWorks] start failed', result);
    } else {
      task.step = '等待后端响应';
    }
  } catch (err) {
    task.status = 'error';
    task.step = `启动失败：${err && err.message ? err.message : err}`;
    console.error('[userWorks] start exception', err);
  }
  return id;
};

store.cancelUserWorks = (id) => {
  const task = store.userWorks.find(t => t.id === id);
  if (task && task.status === 'running') {
    task.status = 'cancelling';
    window.electronAPI.cancelUserWorks(id);
  }
};

store.isUserWorksRunning = (secUid) => {
  const task = store.userWorks.find(t => t.secUid === secUid && t.status === 'running');
  if (!task) return false;
  const stalled = Date.now() - (task.lastProgressAt || Date.now()) > USER_WORKS_STALL_MS;
  if (stalled) {
    task.status = 'error';
    task.step = '获取超时，请重试';
    return false;
  }
  return true;
};

store.onUserWorksProgress = (payload) => {
  const { taskId, data } = payload;
  const task = store.userWorks.find(t => t.id === taskId);
  if (!task) return;
  // 已结束的任务忽略后续进度事件，避免状态被迟到事件覆盖
  if (task.status !== 'running' && task.status !== 'cancelling') return;
  task.lastProgressAt = Date.now();
  console.log('[userWorks]', taskId, data.event, data.items?.length ?? data.total ?? '');
  if (data.event === 'start') {
    task.step = '开始获取作品';
    task.total = data.limit || 0;
  } else if (data.event === 'progress') {
    task.step = data.message ? `正在获取：${data.message}` : '正在获取作品';
    if (task.total > 0) {
      task.progress = Math.min(100, Math.round((data.current / task.total) * 100));
    }
  } else if (data.event === 'items') {
    const items = Array.isArray(data.items) ? data.items : [];
    task.items.push(...items);
    task.total = data.total || task.total;
  } else if (data.event === 'done') {
    task.step = `共 ${data.total || task.items.length} 个作品`;
    task.progress = 100;
    if (Array.isArray(data.items)) task.items = data.items;
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
  const { taskId, code, data } = payload;
  const task = store.userWorks.find(t => t.id === taskId);
  if (!task) return;
  // 已结束的任务不再处理新的 finished 事件
  if (task.status !== 'running' && task.status !== 'cancelling') return;
  const gotItems = (task.items && task.items.length > 0) || (data && data.total > 0);
  const backendError = data && (data.success === false || (typeof data.error === 'string' && data.error));
  const isComplete = !data || data.is_complete !== false;
  const expectedTotal = data && data.expected_total ? data.expected_total : 0;
  const failedCount = data && typeof data.failed_count === 'number' ? data.failed_count : 0;
  if (task.status === 'cancelling') {
    task.status = 'cancelled';
    task.step = '已取消';
  } else if (code !== 0 || backendError) {
    task.status = 'error';
    task.step = backendError ? `获取失败：${data.error}` : `获取失败（code=${code}）`;
  } else if (!isComplete) {
    task.status = 'failed';
    const actual = task.items.length;
    task.step = expectedTotal
      ? `拉取失败：已获取 ${actual}/${expectedTotal} 个作品，失败 ${failedCount} 个`
      : `拉取失败：已获取 ${actual} 个作品，可能未完整`;
  } else if (!gotItems) {
    task.status = 'error';
    task.step = '未获取到作品';
  } else {
    task.status = 'success';
    if (!task.step || !task.step.includes('个作品')) {
      task.step = `共 ${task.items.length} 个作品`;
    }
  }
};

// ========== 新发布任务 ==========
store.startNewReleases = async (filterOnly = false) => {
  if (!store.user.isLoggedIn) return;
  if (store.newReleases.status === 'running' || store.newReleases.status === 'cancelling') return;
  const id = 'sync-newReleases-' + Date.now();
  const now = Date.now();
  store.newReleases.status = 'running';
  store.newReleases.taskId = id;
  store.newReleases.items = [];
  store.newReleases.progress = {};
  store.newReleases.logs = [];
  store.newReleases.error = '';
  const sync = reactive({
    id,
    kind: 'newReleases',
    status: 'running',
    step: '初始化',
    progress: 0,
    total: 0,
    added: 0,
    logs: [],
    createdAt: new Date(now).toLocaleString(),
    createdAtMs: now,
    lastProgressAt: now,
  });
  store.syncs.unshift(sync);
  store.saveTaskHistory();
  try {
    const result = await window.electronAPI.startNewReleases({
      taskId: id,
      config: plain(store.buildConfig()),
      cookies: store.settings.cookieString,
      limits: plain(store.settings.syncLimits),
      proxy: store.settings.proxy || '',
      filterOnly: Boolean(filterOnly),
    });
    if (!result || result.started === false) {
      store.newReleases.status = 'error';
      store.newReleases.error = `启动失败：${result && result.error ? result.error : '未知错误'}`;
      sync.status = 'error';
      sync.step = store.newReleases.error;
      store.saveTaskHistory();
    }
  } catch (err) {
    store.newReleases.status = 'error';
    store.newReleases.error = `启动失败：${err && err.message ? err.message : err}`;
    sync.status = 'error';
    sync.step = store.newReleases.error;
    store.saveTaskHistory();
  }
};

store.cancelNewReleases = () => {
  const id = store.newReleases.taskId;
  if (id && store.newReleases.status === 'running') {
    store.newReleases.status = 'cancelling';
    const sync = store.syncs.find(s => s.id === id);
    if (sync) {
      sync.status = 'cancelling';
      sync.step = '取消中';
    }
    window.electronAPI.cancelNewReleases(id);
  }
};

store.onNewReleasesProgress = (payload) => {
  const { data } = payload;
  if (!data) return;
  // 已结束的任务忽略后续进度事件，避免状态被迟到事件覆盖
  if (store.newReleases.status !== 'running' && store.newReleases.status !== 'cancelling') return;
  const sync = store.syncs.find(s => s.id === store.newReleases.taskId);
  if (data.event === 'start') {
    store.newReleases.progress = {
      current: 0,
      total: data.authors_total || 0,
      message: `开始检查 ${data.authors_total || 0} 位博主`,
    };
    if (sync) {
      sync.total = data.authors_total || 0;
      sync.step = store.newReleases.progress.message;
      sync.lastProgressAt = Date.now();
    }
  } else if (data.event === 'progress') {
    store.newReleases.progress = {
      current: data.current_author_index || store.newReleases.progress.current || 0,
      total: data.total_authors || store.newReleases.progress.total || 0,
      message: data.message || '',
    };
    if (sync) {
      sync.total = store.newReleases.progress.total;
      const current = store.newReleases.progress.current;
      sync.progress = sync.total > 0 ? Math.min(100, Math.round((current / sync.total) * 100)) : 0;
      sync.step = store.newReleases.progress.message;
      sync.lastProgressAt = Date.now();
    }
  } else if (data.event === 'items') {
    store.newReleases.items.push(...(data.items || []));
    store.newReleases.progress.message = `已发现 ${store.newReleases.items.length} 个新作品`;
    if (sync) {
      sync.added = store.newReleases.items.length;
      sync.step = store.newReleases.progress.message;
      sync.lastProgressAt = Date.now();
    }
  } else if (data.event === 'done') {
    // 取消中的任务不应被进度通道的 done 事件覆盖为已完成，
    // 最终状态由 finished 通道根据 code 统一判定为 cancelled。
    if (store.newReleases.status !== 'cancelling') {
      store.newReleases.status = 'done';
    }
    store.newReleases.progress = {
      current: data.authors_checked || 0,
      total: data.authors_checked || 0,
      message: `检查完成，共 ${data.total || 0} 个新作品`,
    };
    if (data.items) store.newReleases.items = data.items;
    store.loadSyncCache('new_releases');
    if (sync) {
      if (store.newReleases.status !== 'cancelling') sync.status = 'success';
      sync.total = data.authors_checked || 0;
      sync.added = data.total || 0;
      sync.progress = 100;
      sync.step = store.newReleases.progress.message;
      sync.lastProgressAt = Date.now();
    }
  } else if (data.event === 'log') {
    store.newReleases.logs.push(data.message || '');
    if (sync) sync.logs.push(data.message || '');
  }
};

store.onNewReleasesLog = (payload) => {
  const { line } = payload;
  if (!line) return;
  store.newReleases.logs.push(line);
  const sync = store.syncs.find(s => s.id === store.newReleases.taskId);
  if (sync) {
    sync.logs.push(line);
    // 后端持续输出日志也说明进程仍在工作，刷新进度时间避免被误判为卡住
    sync.lastProgressAt = Date.now();
  }
};

store.onNewReleasesFinished = (payload) => {
  const { code, data } = payload;
  // 运行中或取消中时才需要兜底；进度通道里的 done 事件通常已先设置好状态
  if (store.newReleases.status !== 'running' && store.newReleases.status !== 'cancelling') return;
  const hasResult = store.newReleases.items && store.newReleases.items.length > 0;
  const backendError = data && (data.success === false || (typeof data.error === 'string' && data.error));
  const sync = store.syncs.find(s => s.id === store.newReleases.taskId);
  if (store.newReleases.status === 'cancelling') {
    store.newReleases.status = 'cancelled';
    store.newReleases.error = '';
    if (sync) {
      sync.status = 'cancelled';
      sync.step = '已取消';
    }
  } else if (code === 0 && hasResult && !backendError) {
    store.newReleases.status = 'done';
    if (sync) {
      sync.status = 'success';
      sync.step = '检查完成';
      sync.progress = 100;
    }
  } else {
    store.newReleases.status = 'error';
    store.newReleases.error = backendError ? `检查失败：${data.error}` : (hasResult ? `检查失败（code=${code}）` : '未检查到新作品');
    if (sync) {
      sync.status = 'error';
      sync.step = store.newReleases.error;
    }
  }
  store.loadSyncCache('new_releases');
  if (sync) store.saveTaskHistory();
};

// ========== 批量关注/取关任务 ==========
store.startRelationTask = async (action, secUids) => {
  const id = 'relation-' + action + '-' + Date.now();
  const nowMs = Date.now();
  const task = reactive({
    id,
    action,
    secUids,
    status: 'running',
    progress: 0,
    current: 0,
    total: secUids.length,
    step: '准备中',
    logs: [],
    createdAt: new Date(nowMs).toLocaleString(),
    createdAtMs: nowMs,
  });
  store.relationTasks.unshift(task);
  store.saveTaskHistory();
  const bf = store.settings.browserFallback || {};
  try {
    const result = await window.electronAPI.startRelation({
      taskId: id,
      action,
      secUids,
      cookies: store.settings.cookieString,
      proxy: store.settings.proxy,
      config: {
        ...plain(store.settings.relation),
        browser_fallback: {
          enabled: Boolean(bf.enabled),
          headless: Boolean(bf.headless),
          max_scrolls: Math.max(50, parseInt(bf.maxScrolls, 10) || 500),
        },
      },
    });
    if (!result || result.started === false) {
      task.status = 'error';
      task.step = `启动失败：${result && result.error ? result.error : '未知错误'}`;
      store.saveTaskHistory();
    }
  } catch (err) {
    task.status = 'error';
    task.step = `启动失败：${err && err.message ? err.message : err}`;
    store.saveTaskHistory();
  }
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
  // 已结束的任务忽略后续进度事件，避免状态被迟到的进度覆盖
  if (task.status !== 'running' && task.status !== 'cancelling') return;
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
    // 只有真正取关成功的用户才标记为已取消关注
    if (task.action === 'unfollow' && Array.isArray(summary.results)) {
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
  const { taskId, code, data } = payload;
  const task = store.relationTasks.find(t => t.id === taskId);
  if (!task) return;
  // 已结束的关系任务不再处理新的 finished 事件
  if (task.status !== 'running' && task.status !== 'cancelling') return;
  // 若 finished 通道携带了汇总数据，以它为准判断成败；summary.failed 为 0 才真正成功
  const summary = data && data.summary ? data.summary : (task.summary || null);
  if (data && data.summary) {
    task.summary = data.summary;
  }
  if (task.status === 'cancelling') {
    task.status = 'cancelled';
    task.step = '已取消';
  } else if (summary) {
    if (summary.failed === 0 && code === 0) {
      task.status = 'success';
      task.step = '已完成';
    } else {
      task.status = 'error';
      task.step = `完成：成功 ${summary.success || 0} / 失败 ${summary.failed || 0} / 跳过 ${summary.skipped || 0}`;
    }
    task.progress = 100;
    // 只有真正取关成功的用户才标记为已取消关注
    if (task.action === 'unfollow' && Array.isArray(summary.results)) {
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
  } else if (code === 0) {
    task.status = 'success';
    task.step = '已完成';
    task.progress = 100;
  } else {
    task.status = 'error';
    task.step = `失败（code=${code}）`;
  }
  store.saveTaskHistory();
};

// ========== 报表导出任务 ==========
store.exportReport = async (options) => {
  const id = 'report-' + Date.now();
  const nowMs = Date.now();
  const task = reactive({
    id,
    status: 'running',
    progress: 0,
    step: '准备中',
    logs: [],
    result: null,
    options,
    createdAt: new Date(nowMs).toLocaleString(),
    createdAtMs: nowMs,
  });
  store.reportTasks.unshift(task);
  store.saveTaskHistory();
  try {
    const result = await window.electronAPI.exportReport({
      taskId: id,
      dbPath: options.dbPath || window.electronAPI.pathJoinSync(store.settings.outputPath, 'dy_downloader.db'),
      dateFrom: options.dateFrom,
      dateTo: options.dateTo,
      groupBy: options.groupBy,
      formats: options.formats,
      outputDir: options.outputDir,
    });
    if (!result || result.started === false) {
      task.status = 'error';
      task.step = `启动失败：${result && result.error ? result.error : '未知错误'}`;
      store.saveTaskHistory();
    }
  } catch (err) {
    task.status = 'error';
    task.step = `启动失败：${err && err.message ? err.message : err}`;
    store.saveTaskHistory();
  }
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
  // 已结束的任务忽略后续进度事件，避免状态被迟到的进度覆盖
  if (task.status !== 'running' && task.status !== 'cancelling') return;
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
  const { taskId, code, data } = payload;
  const task = store.reportTasks.find(t => t.id === taskId);
  if (!task) return;
  // 已结束的报表任务不再处理新的 finished 事件
  if (task.status !== 'running' && task.status !== 'cancelling') return;
  // 若 finished 通道携带了结果文件，补全结果（防止进度事件迟到）
  if (data && Array.isArray(data.files) && data.files.length) {
    task.result = data.files;
  }
  if (task.status === 'cancelling') {
    task.status = 'cancelled';
    task.step = '已取消';
  } else if (code === 0 && task.result && task.result.length) {
    task.status = 'success';
    task.step = '导出完成';
    task.progress = 100;
  } else if (code === 0) {
    task.status = 'error';
    task.step = data && data.error ? `导出失败：${data.error}` : '导出失败：未生成文件';
    task.progress = 100;
  } else {
    task.status = 'error';
    task.step = data && data.error ? `导出失败：${data.error}` : `导出失败（code=${code}）`;
  }
  store.saveTaskHistory();
};

// ========== 云同步任务 ==========
store.backupCloud = async () => {
  const cfg = plain(store.settings.cloudSync);
  if (!cfg.enabled || !cfg.provider) {
    console.warn('云同步未启用或 Provider 未设置');
    return null;
  }
  const id = 'cloud-backup-' + Date.now();
  const nowMs = Date.now();
  const task = reactive({
    id,
    kind: 'backup',
    status: 'running',
    progress: 0,
    step: '准备中',
    logs: [],
    token: '',
    createdAt: new Date(nowMs).toLocaleString(),
    createdAtMs: nowMs,
  });
  store.cloudTasks.unshift(task);
  store.saveTaskHistory();
  try {
    const result = await window.electronAPI.backupCloud({
      taskId: id,
      configPath: '',
      dbPath: window.electronAPI.pathJoinSync(store.settings.outputPath, 'dy_downloader.db'),
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
    if (!result || result.started === false) {
      task.status = 'error';
      task.step = `启动失败：${result && result.error ? result.error : '未知错误'}`;
      store.saveTaskHistory();
    }
  } catch (err) {
    task.status = 'error';
    task.step = `启动失败：${err && err.message ? err.message : err}`;
    store.saveTaskHistory();
  }
  return id;
};

store.restoreCloud = async (token) => {
  const cfg = plain(store.settings.cloudSync);
  if (!cfg.enabled || !cfg.provider) {
    console.warn('云同步未启用或 Provider 未设置');
    return null;
  }
  const id = 'cloud-restore-' + Date.now();
  const nowMs = Date.now();
  const task = reactive({
    id,
    kind: 'restore',
    status: 'running',
    progress: 0,
    step: '准备中',
    logs: [],
    token,
    createdAt: new Date(nowMs).toLocaleString(),
    createdAtMs: nowMs,
  });
  store.cloudTasks.unshift(task);
  store.saveTaskHistory();
  try {
    const result = await window.electronAPI.restoreCloud({
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
    if (!result || result.started === false) {
      task.status = 'error';
      task.step = `启动失败：${result && result.error ? result.error : '未知错误'}`;
      store.saveTaskHistory();
    }
  } catch (err) {
    task.status = 'error';
    task.step = `启动失败：${err && err.message ? err.message : err}`;
    store.saveTaskHistory();
  }
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
  // 已结束的任务忽略后续进度事件，避免状态被迟到的进度覆盖
  if (task.status !== 'running' && task.status !== 'cancelling') return;
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
  const { taskId, code, data } = payload;
  const task = store.cloudTasks.find(t => t.id === taskId);
  if (!task) return;
  // 已结束的云同步任务不再处理新的 finished 事件
  if (task.status !== 'running' && task.status !== 'cancelling') return;
  // 若 finished 通道携带了结果，补全数据（防止进度事件迟到）
  if (data) {
    if (typeof data.token === 'string' && data.token) task.token = data.token;
    if (Array.isArray(data.restored_files)) task.result = data.restored_files;
  }
  const succeeded = code === 0 && data && data.success !== false;
  if (task.status === 'cancelling') {
    task.status = 'cancelled';
    task.step = '已取消';
  } else if (succeeded) {
    task.status = 'success';
    task.step = task.kind === 'backup' ? '备份完成' : '恢复完成';
    task.progress = 100;
  } else {
    task.status = 'error';
    task.step = data && data.error ? `失败：${data.error}` : `失败（code=${code}）`;
  }
  store.saveTaskHistory();
};

// ========== 作品去重任务 ==========
store.startDedupTask = async (outputDir) => {
  const id = 'dedup-' + Date.now();
  const nowMs = Date.now();
  const task = reactive({
    id,
    status: 'running',
    progress: 0,
    step: '准备中',
    total: 0,
    scanned: 0,
    duplicateGroups: 0,
    duplicateFiles: 0,
    deletedFiles: 0,
    freedBytes: 0,
    logs: [],
    createdAt: new Date(nowMs).toLocaleString(),
    createdAtMs: nowMs,
  });
  store.dedupTasks.unshift(task);
  store.saveTaskHistory();
  try {
    const result = await window.electronAPI.startDedup({
      taskId: id,
      outputDir,
    });
    if (!result || result.started === false) {
      task.status = 'error';
      task.step = `启动失败：${result && result.error ? result.error : '未知错误'}`;
      store.saveTaskHistory();
    }
  } catch (err) {
    task.status = 'error';
    task.step = `启动失败：${err && err.message ? err.message : err}`;
    store.saveTaskHistory();
  }
  return id;
};

store.cancelDedupTask = (id) => {
  const task = store.dedupTasks.find(t => t.id === id);
  if (task && task.status === 'running') {
    task.status = 'cancelling';
    window.electronAPI.cancelDedup(id);
  }
};

store.onDedupProgress = (payload) => {
  const { taskId, data } = payload;
  const task = store.dedupTasks.find(t => t.id === taskId);
  if (!task) return;
  if (task.status !== 'running' && task.status !== 'cancelling') return;
  if (data.event === 'progress') {
    task.step = data.message || '去重中';
    if (typeof data.current === 'number' && typeof data.total === 'number' && data.total > 0) {
      task.scanned = data.current;
      task.total = data.total;
      task.progress = Math.round((data.current / data.total) * 100);
    }
  } else if (data.event === 'stats') {
    if (typeof data.duplicateGroups === 'number') task.duplicateGroups = data.duplicateGroups;
    if (typeof data.duplicateFiles === 'number') task.duplicateFiles = data.duplicateFiles;
    if (typeof data.deletedFiles === 'number') task.deletedFiles = data.deletedFiles;
    if (typeof data.freedBytes === 'number') task.freedBytes = data.freedBytes;
  } else if (data.event === 'log') {
    task.logs.push(data.message);
  } else if (data.event === 'finished') {
    if (typeof data.duplicateGroups === 'number') task.duplicateGroups = data.duplicateGroups;
    if (typeof data.duplicateFiles === 'number') task.duplicateFiles = data.duplicateFiles;
    if (typeof data.deletedFiles === 'number') task.deletedFiles = data.deletedFiles;
    if (typeof data.freedBytes === 'number') task.freedBytes = data.freedBytes;
    task.progress = 100;
  }
};

store.onDedupLog = (payload) => {
  const { taskId, line } = payload;
  const task = store.dedupTasks.find(t => t.id === taskId);
  if (task) task.logs.push(line);
};

store.onDedupFinished = (payload) => {
  const { taskId, code, data } = payload;
  const task = store.dedupTasks.find(t => t.id === taskId);
  if (!task) return;
  if (task.status !== 'running' && task.status !== 'cancelling') return;
  if (data) {
    if (typeof data.duplicateGroups === 'number') task.duplicateGroups = data.duplicateGroups;
    if (typeof data.duplicateFiles === 'number') task.duplicateFiles = data.duplicateFiles;
    if (typeof data.deletedFiles === 'number') task.deletedFiles = data.deletedFiles;
    if (typeof data.freedBytes === 'number') task.freedBytes = data.freedBytes;
  }
  const succeeded = code === 0 && data && data.success !== false;
  if (task.status === 'cancelling') {
    task.status = 'cancelled';
    task.step = '已取消';
  } else if (succeeded) {
    task.status = 'success';
    task.step = `完成：发现 ${task.duplicateGroups} 组重复，删除 ${task.deletedFiles} 个文件`;
    task.progress = 100;
  } else {
    task.status = 'error';
    task.step = data && data.error ? `失败：${data.error}` : `失败（code=${code}）`;
  }
  store.saveTaskHistory();
};

store.loadArchive = async () => {
  store.archive = await window.electronAPI.listArchive(store.settings.outputPath);
};

store.loadArchiveStatus = async (secUids) => {
  if (!Array.isArray(secUids) || secUids.length === 0) return;
  const dbPath = window.electronAPI.pathJoinSync(store.settings.outputPath, 'dy_downloader.db');
  try {
    const status = await window.electronAPI.getArchiveStatus({ dbPath, secUids });
    if (status && typeof status === 'object') {
      Object.assign(store.archiveStatus, status);
    }
  } catch (e) {
    console.error('加载下载状态失败', e);
  }
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

function getDownloadStatus(user, archive, archiveStatus) {
  // Prefer the database-backed status keyed by sec_uid; this works regardless of
  // folderstyle and avoids false negatives when folder names differ from nicknames.
  const secUid = user.sec_uid;
  if (secUid && archiveStatus && archiveStatus[secUid]) {
    return archiveStatus[secUid];
  }
  // Fallback to folder-name matching for legacy installations without db records.
  if (archive && archive.length) {
    const nickname = (user.nickname || '').trim();
    const uniqueId = (user.unique_id || '').trim();
    for (const item of archive) {
      const name = (item.name || '').trim();
      if (!name) continue;
      if (nickname && (name === nickname || name.includes(nickname))) {
        const date = item.mtime ? item.mtime.slice(0, 10) : '';
        return { status: 'downloaded', date };
      }
      if (uniqueId && (name === uniqueId || name.includes(uniqueId))) {
        const date = item.mtime ? item.mtime.slice(0, 10) : '';
        return { status: 'downloaded', date };
      }
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
    const sortBy = ref('recent');
    const sortOrder = ref('desc');
    const sortOpen = ref(false);

    // 抖音原生的关注列表排序（最近/最早）；其余为管理排序
    const douyinSortKeys = new Set(['recent', 'earliest']);
    function defaultOrderFor(key) {
      if (key === 'earliest') return 'asc';
      if (key === 'name') return 'asc';
      return 'desc';
    }
    function arrowFor(key, order) {
      if (key === 'earliest') return '↑';
      if (douyinSortKeys.has(key)) return '↓';
      return order === 'desc' ? '↓' : '↑';
    }
    const filterTag = ref('all');
    const page = ref(1);
    const pageSize = ref(10);
    const viewMode = ref('list');
    const multiSelect = ref(false);
    const selected = ref(new Set());
    const showMore = ref(null);
    const moreMenuStyle = ref({});
    const remarkInput = ref({ sec_uid: '', value: '' });
    const remarks = ref(loadFollowingRemarks());
    const unfollowed = ref(loadUnfollowedSet());

    const sortOptions = [
      { key: 'recent', label: '最近关注', divider: false },
      { key: 'earliest', label: '最早关注', divider: true },
      { key: 'fans', label: '粉丝数', divider: false },
      { key: 'works', label: '作品数', divider: false },
      { key: 'name', label: '昵称', divider: false },
    ];

    const sortLabel = computed(() => {
      const opt = sortOptions.find(o => o.key === sortBy.value);
      const arrow = arrowFor(sortBy.value, sortOrder.value);
      return `${opt ? opt.label : sortBy.value}${douyinSortKeys.has(sortBy.value) ? '' : ' ' + arrow}`;
    });

    function toggleSort(key) {
      if (douyinSortKeys.has(key)) {
        sortBy.value = key;
        sortOrder.value = defaultOrderFor(key);
      } else if (sortBy.value === key) {
        sortOrder.value = sortOrder.value === 'desc' ? 'asc' : 'desc';
      } else {
        sortBy.value = key;
        sortOrder.value = defaultOrderFor(key);
      }
      sortOpen.value = false;
    }

    function closeSortDropdown(e) {
      const dropdown = document.querySelector('.following-toolbar .dropdown');
      if (dropdown && !dropdown.contains(e.target)) {
        sortOpen.value = false;
      }
    }

    function closeMoreOnScroll() { closeMore(); }

    onMounted(() => {
      document.addEventListener('mousedown', closeSortDropdown);
      document.addEventListener('scroll', closeMoreOnScroll, true);
      window.addEventListener('resize', closeMoreOnScroll);
    });
    onUnmounted(() => {
      document.removeEventListener('mousedown', closeSortDropdown);
      document.removeEventListener('scroll', closeMoreOnScroll, true);
      window.removeEventListener('resize', closeMoreOnScroll);
    });

    const filterOptions = [
      { key: 'all', label: '全部' },
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
        const dl = getDownloadStatus(u, s.archive, s.archiveStatus);
        return {
          ...u,
          avatar: u.avatar || generateAvatar(u.nickname),
          following: u.following_count || 0,
          fans: u.follower_count || 0,
          works: u.aweme_count || u.video_count || 0,
          // 旧缓存可能没有 follow_order，用数组下标兜底保证排序仍可工作；
          // 重新同步后会写入真实的 follow_order。
          followOrder: u.follow_order != null ? u.follow_order : idx,
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
      if (filterTag.value === 'remark') {
        list = list.filter(u => u.remark);
      } else if (filterTag.value === 'never') {
        list = list.filter(u => u.downloadStatus === 'never' && !u.isUnfollowed);
      } else if (filterTag.value === 'downloaded') {
        list = list.filter(u => u.downloadStatus === 'downloaded');
      } else if (filterTag.value === 'unfollowed') {
        list = list.filter(u => u.isUnfollowed);
      }
      list.sort((a, b) => {
        // 抖音原生的关注顺序：follow_order 越小代表越新关注
        if (sortBy.value === 'recent') {
          return (a.followOrder ?? Infinity) - (b.followOrder ?? Infinity);
        }
        if (sortBy.value === 'earliest') {
          return (b.followOrder ?? Infinity) - (a.followOrder ?? Infinity);
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
    const allSelected = computed(() => filteredList.value.length > 0 && filteredList.value.every(u => selected.value.has(u.sec_uid)));

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
      return '没有符合筛选条件的关注用户';
    });

    function sync() {
      if (needsLogin.value || isSyncing.value) return;
      s.startSync('following');
    }

    function downloadUser(user) {
      // 用户主页下载必须使用 sec_uid，unique_id 无法直接替代。
      const uid = user.sec_uid;
      if (uid) {
        s.startTask(`https://www.douyin.com/user/${uid}`, `${user.nickname} 的主页`);
        s.showToast(`已开始下载：${user.nickname || user.unique_id || '博主'} 的主页`);
      } else {
        s.showToast('该用户缺少 sec_uid，请重新同步关注列表后再试');
      }
    }

    // ========== 博主作品弹窗 ==========
    const userWorksModal = ref({ open: false, secUid: '', nickname: '', avatar: '', expectedTotal: 0 });
    const worksSearch = ref('');
    const worksPage = ref(1);
    const worksPageSize = ref(20);
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
      if (!user || !user.sec_uid) {
        console.warn('[openUserWorks] missing user or sec_uid', user);
        return;
      }
      const expectedTotal = user.aweme_count || user.video_count || 0;
      userWorksModal.value = { open: true, secUid: user.sec_uid, nickname: user.nickname, avatar: user.avatar, expectedTotal };
      worksSearch.value = '';
      worksPage.value = 1;
      const existing = s.userWorks.find(t => t.secUid === user.sec_uid && (t.status === 'success' || t.status === 'running' || t.status === 'partial' || t.status === 'failed'));
      if (!existing) {
        console.log('[openUserWorks] no existing task, starting', user.sec_uid);
        s.startUserWorks(user.sec_uid, user.nickname, false, expectedTotal);
      } else if ((existing.status === 'success' || existing.status === 'failed') && (!existing.items || existing.items.length === 0)) {
        console.log('[openUserWorks] existing empty task, restarting', user.sec_uid);
        s.startUserWorks(user.sec_uid, user.nickname, false, expectedTotal);
      } else if (existing.status === 'running' && !s.isUserWorksRunning(user.sec_uid)) {
        console.log('[openUserWorks] existing task stalled, restarting', user.sec_uid);
        s.startUserWorks(user.sec_uid, user.nickname, false, expectedTotal);
      } else {
        console.log('[openUserWorks] using existing task', existing.id, existing.status, existing.items?.length);
      }
    }
    function closeUserWorks() {
      userWorksModal.value = { open: false, secUid: '', nickname: '', avatar: '', expectedTotal: 0 };
    }
    function retryUserWorks() {
      s.startUserWorks(userWorksModal.value.secUid, userWorksModal.value.nickname, false, userWorksModal.value.expectedTotal, true);
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

    function selectAllFiltered() {
      if (allSelected.value) {
        selected.value.clear();
      } else {
        filteredList.value.forEach(u => selected.value.add(u.sec_uid));
      }
    }

    function clearSelection() {
      selected.value.clear();
    }

    function downloadSelected() {
      const secUids = Array.from(selected.value);
      if (secUids.length === 0) return;
      const list = filteredList.value.filter(u => selected.value.has(u.sec_uid));
      list.forEach(u => downloadUser(u));
      s.showToast('已开始下载 ' + list.length + ' 位博主的主页');
      selected.value.clear();
    }

    function runRelation(action) {
      const secUids = Array.from(selected.value);
      if (secUids.length === 0) return;
      const actionName = action === 'follow' ? '关注' : '取关';
      if (!confirm('确定要对 ' + secUids.length + ' 位用户执行「' + actionName + '」吗？')) return;
      s.startRelationTask(action, secUids);
      selected.value.clear();
    }
    function unfollowUser(user) {
      if (user.isUnfollowed) return;
      if (!confirm(`确定取消关注「${user.nickname || user.unique_id || user.sec_uid}」吗？`)) return;
      s.startRelationTask('unfollow', [user.sec_uid]);
    }

    function toggleMore(secUid, event) {
      event.stopPropagation();
      if (showMore.value === secUid) {
        showMore.value = null;
        moreMenuStyle.value = {};
        return;
      }
      showMore.value = secUid;
      const btn = event.currentTarget;
      const rect = btn.getBoundingClientRect();
      const gap = 6;
      // 先在按钮下方隐藏渲染，测量真实高度后再定位，避免初始位置闪一下
      moreMenuStyle.value = {
        top: `${rect.bottom + gap}px`,
        left: `${Math.max(4, rect.right - 150)}px`,
        visibility: 'hidden',
      };
      nextTick(() => {
        const menu = document.querySelector('.more-menu');
        if (!menu) return;
        const menuRect = menu.getBoundingClientRect();
        let top = rect.bottom + gap;
        // 下方放不下则翻到按钮上方
        if (top + menuRect.height > window.innerHeight - 4) {
          top = rect.top - menuRect.height - gap;
        }
        // 防止超出顶部
        if (top < 4) top = 4;
        let left = rect.right - menuRect.width;
        // 防止超出左右边界
        if (left < 4) left = 4;
        if (left + menuRect.width > window.innerWidth - 4) {
          left = window.innerWidth - menuRect.width - 4;
        }
        moreMenuStyle.value = { top: `${top}px`, left: `${left}px`, visibility: 'visible' };
      });
    }
    function closeMore() { showMore.value = null; moreMenuStyle.value = {}; }

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

    async function copyHandle(user) {
      const text = user.unique_id || user.sec_uid || '';
      if (!text) return;
      try {
        if (window.electronAPI && window.electronAPI.writeClipboard) {
          await window.electronAPI.writeClipboard(text);
        } else if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          throw new Error('clipboard unavailable');
        }
        s.showToast('已复制：' + text);
      } catch (e) {
        s.showToast('复制失败');
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
      s, search, sortBy, sortOrder, sortOpen, sortOptions, sortLabel, toggleSort, arrowFor, defaultOrderFor, filterTag, page, pageSize, viewMode, multiSelect,
      filterOptions, rawList, filteredList, totalPages, pagedList, sync, downloadUser, formatNumber, needsLogin,
      selected, selectedCount, allPageSelected, allSelected, toggleSelect, selectAll, selectAllFiltered, clearSelection, downloadSelected, runRelation, unfollowUser,
      isSyncing, lastSyncText, syncedCount, emptyText,
      showMore, moreMenuStyle, toggleMore, closeMore, openRemark, saveRemark, removeRemark, remarkInput,
      unfollowed, remarks, markUnfollowed, restoreFollowed, clearUnfollowed, copyHandle, statusText,
      userWorksModal, worksSearch, worksPage, worksPageSize, worksTask, worksTaskStatus,
      worksList, worksTotalPages, worksPagedList, openUserWorks, closeUserWorks, retryUserWorks, downloadWork,
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
          <template v-for="opt in sortOptions" :key="opt.key">
            <div v-if="opt.divider" class="dropdown-divider"></div>
            <div
              class="dropdown-item"
              :class="{active: sortBy===opt.key}"
              @click="toggleSort(opt.key)"
            >
              {{ opt.label }}
              <span class="order">{{ arrowFor(opt.key, sortBy===opt.key ? sortOrder : defaultOrderFor(opt.key)) }}</span>
            </div>
          </template>
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
          <div class="time-col" title="抖音未提供精确关注时间，此处按同步时获取的顺序排列">关注顺序</div>
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
          <div class="col time-col" :title="u.followOrder != null ? ('第 ' + (u.followOrder + 1) + ' 位') : '未获取到顺序'">
            {{ u.followOrder != null ? '第 ' + (u.followOrder + 1) + ' 位' : '-' }}
          </div>
          <div class="col status-col" :class="u.downloadStatus">{{ statusText(u) }}</div>
          <div class="action-col">
            <button class="btn btn-primary" @click="downloadUser(u)"><span v-html="$icons.download"></span> 下载</button>
            <div class="more-wrap">
              <button class="btn btn-icon more" @click="toggleMore(u.sec_uid, $event)" v-html="$icons.more"></button>
              <div class="more-menu" v-if="showMore===u.sec_uid" :style="moreMenuStyle" @click.stop>
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
            <div class="more-menu" v-if="showMore===u.sec_uid" :style="moreMenuStyle" @click.stop>
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
        <button class="btn" :disabled="filteredList.length===0" @click="selectAllFiltered">
          {{ allSelected ? '取消全选' : '全选 ' + filteredList.length + ' 人' }}
        </button>
        <button class="btn btn-primary" :disabled="selectedCount===0" @click="downloadSelected">批量下载</button>
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
              <span v-else-if="worksTaskStatus==='failed'" class="error">{{ worksTask?.step || '拉取失败' }}</span>
              <span v-else>共 {{ worksList.length }} 个作品</span>
            </div>
          </div>
        </div>
        <div class="toolbar" style="padding-top:0">
          <div class="search-box"><span class="icon" v-html="$icons.search"></span><input v-model="worksSearch" placeholder="搜索作品标题" /></div>
          <button v-if="worksTaskStatus==='failed'" class="btn btn-primary" @click="retryUserWorks">重试（慢速）</button>
          <button class="btn" @click="worksTaskStatus==='running' ? s.cancelUserWorks(worksTask.id) : s.startUserWorks(userWorksModal.secUid, userWorksModal.nickname, true, userWorksModal.expectedTotal)">
            {{ worksTaskStatus==='running' ? '取消' : '刷新' }}
          </button>
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
                <div class="user-works-footer">
                  <div class="user-works-meta">{{ $formatDate(item.create_time) }}</div>
                  <button class="btn download-video" @click="downloadWork(item)"><span v-html="$icons.download"></span> 下载</button>
                </div>
              </div>
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
    const activeTab = ref('favorites');
    const activeSubTab = ref('folders');
    const activeCollection = ref('all');
    const search = ref('');
    const topicQuery = ref('');
    const topicSortStrategy = ref('default');
    const topicSortOptions = [
      { value: 'default', label: '抖音推荐' },
      { value: 'random', label: '随机打乱' },
      { value: 'latest', label: '最新发布' },
      { value: 'oldest', label: '最早发布' },
      { value: 'hottest', label: '最多点赞' },
      { value: 'auto', label: '自动随机' },
    ];
    const showDrawer = ref(false);
    const loading = ref(false);
    const selected = ref(new Set());

    function itemKey(item) {
      return item.aweme_id || item.mix_id || item.music_id;
    }

    function toggleSelect(item) {
      const key = itemKey(item);
      const next = new Set(selected.value);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      selected.value = next;
    }

    const selectedCount = computed(() => selected.value.size);

    const allSelected = computed(() => {
      const validItems = paginatedList.value.filter(item => !isInvalid(item));
      return validItems.length > 0 && validItems.every(item => selected.value.has(itemKey(item)));
    });

    function toggleSelectAll() {
      const next = new Set(selected.value);
      const validItems = paginatedList.value.filter(item => !isInvalid(item));
      if (allSelected.value) {
        validItems.forEach(item => next.delete(itemKey(item)));
      } else {
        validItems.forEach(item => next.add(itemKey(item)));
      }
      selected.value = next;
    }

    function downloadSelected() {
      const keys = new Set(selected.value);
      if (keys.size === 0) return;
      currentList.value.filter(item => keys.has(itemKey(item)) && !isInvalid(item)).forEach(item => {
        if (item.mix_id) downloadMix(item);
        else if (item.music_id) downloadMusic(item);
        else downloadItem(item);
      });
      selected.value = new Set();
    }

    watch([activeTab, activeSubTab, activeCollection], () => {
      selected.value = new Set();
    });

    const tabs = [
      { key: 'favorites', label: '我的收藏', kind: 'favorites' },
      { key: 'likes', label: '我的喜欢', kind: 'likes' },
    ];

    const subTabs = [
      { key: 'folders', label: '我的收藏夹' },
      { key: 'videos', label: '视频' },
      { key: 'music', label: '音乐' },
      { key: 'mixes', label: '合集' },
      { key: 'topics', label: '话题' },
    ];

    const currentTab = computed(() => tabs.find(t => t.key === activeTab.value) || tabs[0]);

    const favCache = computed(() => s.syncCache.favorites || { collections: [], collect_mixes: [], items: [], favorite_videos: [], music_items: [], updated_at: null });
    const likesCache = computed(() => s.syncCache.likes || { items: [], updated_at: null });
    const topicsCache = computed(() => s.syncCache.topics || { topic: null, items: [], updated_at: null });

    const collections = computed(() => {
      const items = favCache.value.items || [];
      const list = [{ collects_id: 'all', name: '全部收藏', count: items.length }];
      list.push(...(favCache.value.collections || []).map(c => {
        const cid = c.collects_id || 'all';
        const count = items.filter(i => (i.collection_id || 'all') === cid).length;
        return { ...c, count };
      }));
      return list;
    });

    function sortByNewest(items, orderKey = null, descending = false) {
      return [...items].sort((a, b) => {
        // 如果存在交互顺序字段（点赞/收藏顺序），优先按它排序。
        // 默认数值越小表示交互越新；传入 descending=true 时按数值越大越新。
        if (orderKey && a && b && typeof a[orderKey] === 'number' && typeof b[orderKey] === 'number') {
          return descending ? b[orderKey] - a[orderKey] : a[orderKey] - b[orderKey];
        }
        const ta = (a && a.create_time) || 0;
        const tb = (b && b.create_time) || 0;
        return tb - ta;
      });
    }

    const currentList = computed(() => {
      if (activeTab.value === 'likes') return sortByNewest(likesCache.value.items || [], 'like_order');
      if (activeTab.value !== 'favorites') return [];
      if (activeSubTab.value === 'folders') {
        // 我的收藏夹：左侧边栏选择收藏夹，右侧显示该收藏夹内的视频
        let items = favCache.value.items || [];
        if (activeCollection.value !== 'all') {
          items = items.filter(i => (i.collection_id || 'all') === activeCollection.value);
        }
        return sortByNewest(items, 'favorite_order');
      }
      if (activeSubTab.value === 'videos') {
        // 视频：展示点击收藏后默认存入的收藏视频（与收藏夹数据分离）
        return sortByNewest(favCache.value.favorite_videos || [], 'favorite_order');
      }
      if (activeSubTab.value === 'music') return (favCache.value.music_items || []);
      if (activeSubTab.value === 'mixes') return (favCache.value.collect_mixes || []);
      if (activeSubTab.value === 'topics') return sortByNewest(topicsCache.value.items || []);
      return [];
    });

    const filteredList = computed(() => {
      const q = search.value.trim().toLowerCase();
      if (!q) return currentList.value;
      return currentList.value.filter(item => {
        if (activeSubTab.value === 'mixes') {
          const name = (item.name || '').toLowerCase();
          return name.includes(q);
        }
        const title = (item.title || '').toLowerCase();
        const author = ((item.author && item.author.nickname) || '').toLowerCase();
        return title.includes(q) || author.includes(q);
      });
    });

    const pageSize = ref(50);
    const currentPage = ref(1);
    const pageSizeOptions = [
      { value: 50, label: '50 / 页' },
      { value: 100, label: '100 / 页' },
      { value: 200, label: '200 / 页' },
    ];

    const totalPages = computed(() => {
      if (filteredList.value.length === 0) return 1;
      return Math.ceil(filteredList.value.length / pageSize.value);
    });

    const paginatedList = computed(() => {
      const start = (currentPage.value - 1) * pageSize.value;
      return filteredList.value.slice(start, start + pageSize.value);
    });

    function goPage(page) {
      if (page < 1) page = 1;
      if (page > totalPages.value) page = totalPages.value || 1;
      currentPage.value = page;
    }

    watch([() => search.value, () => pageSize.value, () => activeTab.value, () => activeSubTab.value, () => activeCollection.value], () => {
      currentPage.value = 1;
    });

    const needsLogin = computed(() => !s.user.isLoggedIn);

    const relevantKinds = ['favorites', 'likes'];

    // 当前标签对应的同步类型是否正在运行
    const isCurrentSyncing = computed(() => {
      const kind = currentTab.value.kind;
      const subKind = activeTab.value === 'favorites' ? activeSubTab.value : undefined;
      return s.syncs.some(sync => sync.kind === kind && sync.subKind === subKind && (sync.status === 'running' || sync.status === 'cancelling'));
    });

    // 收藏/喜欢相关同步是否正在运行（用于禁用"同步全部"，避免并发风暴）
    const isAnySyncing = computed(() => s.syncs.some(
      sync => relevantKinds.includes(sync.kind) && (sync.status === 'running' || sync.status === 'cancelling')
    ));

    const lastSync = computed(() => {
      const kind = currentTab.value.kind;
      const subKind = activeTab.value === 'favorites' ? activeSubTab.value : undefined;
      const list = s.syncs.filter(sync => sync.kind === kind && sync.subKind === subKind);
      return list.length ? list[list.length - 1] : null;
    });

    const lastSyncTime = computed(() => {
      if (activeTab.value === 'likes') return likesCache.value.updated_at || null;
      if (activeTab.value === 'favorites' && activeSubTab.value === 'topics') return topicsCache.value.updated_at || null;
      return favCache.value.updated_at || null;
    });

    const syncCurrentLabel = computed(() => {
      if (activeTab.value === 'likes') return '同步喜欢';
      switch (activeSubTab.value) {
        case 'folders': return '同步收藏夹';
        case 'videos': return '同步视频';
        case 'music': return '同步音乐';
        case 'mixes': return '同步合集';
        case 'topics': return '同步话题';
        default: return '同步我的收藏';
      }
    });

    // 实时显示同步进度或缓存数量
    const syncCountText = computed(() => {
      const kind = currentTab.value.kind;
      const subKind = activeTab.value === 'favorites' ? activeSubTab.value : undefined;
      const active = s.syncs.find(sync => sync.kind === kind && sync.subKind === subKind && (sync.status === 'running' || sync.status === 'cancelling'));
      if (active) {
        const total = active.total || 0;
        const added = active.added || 0;
        return total > 0 ? `${added} / ${total}` : `${added}`;
      }
      if (activeTab.value === 'likes') return `${likesCache.value.items?.length || 0} 条`;
      if (activeTab.value === 'favorites') {
        if (activeSubTab.value === 'folders') return `${currentList.value.length} 条`;
        if (activeSubTab.value === 'videos') return `${favCache.value.favorite_videos?.length || 0} 条`;
        if (activeSubTab.value === 'music') return `${favCache.value.music_items?.length || 0} 首`;
        if (activeSubTab.value === 'mixes') return `${favCache.value.collect_mixes?.length || 0} 个合集`;
        if (activeSubTab.value === 'topics') return `${topicsCache.value.items?.length || 0} 条`;
      }
      return `${favCache.value.items?.length || 0} 条`;
    });

    const syncStatusText = computed(() => {
      if (isCurrentSyncing.value) {
        const kind = currentTab.value.kind;
        const subKind = activeTab.value === 'favorites' ? activeSubTab.value : undefined;
        const active = s.syncs.find(sync => sync.kind === kind && sync.subKind === subKind && (sync.status === 'running' || sync.status === 'cancelling'));
        if (active && active.step) return active.step;
        return '同步中...';
      }
      if (lastSync.value?.status === 'error') {
        return '同步失败';
      }
      if (lastSyncTime.value) {
        return '已同步 ' + formatTimeLabel(lastSyncTime.value);
      }
      return '从未同步过';
    });

    const syncErrorText = computed(() => {
      if (lastSync.value?.status === 'error') {
        return lastSync.value.step || '同步失败';
      }
      return '';
    });

    function getCollectionName(collectionId) {
      const cid = collectionId || 'all';
      if (cid === 'all') return '全部收藏';
      const c = (favCache.value.collections || []).find(c => (c.collects_id || 'all') === cid);
      return c?.name || '未知收藏夹';
    }

    function buildDownloadContext() {
      if (activeTab.value === 'likes') {
        return { category: 'likes' };
      }
      if (activeTab.value !== 'favorites') return null;
      switch (activeSubTab.value) {
        case 'folders':
          return {
            category: 'favorites',
            subCategory: 'folders',
            collectionName: getCollectionName(activeCollection.value),
          };
        case 'videos':
          return { category: 'favorites', subCategory: 'videos' };
        case 'music':
          return { category: 'favorites', subCategory: 'music' };
        case 'mixes':
          return { category: 'favorites', subCategory: 'mixes' };
        case 'topics':
          return {
            category: 'favorites',
            subCategory: 'topics',
            topicName: topicsCache.value.topic?.name || '话题',
          };
        default:
          return null;
      }
    }

    function isInvalid(item) {
      // 同步服务可能把仍可访问的作品标记为 is_invalid，因此不能只看该字段。
      // 只要作品还有 aweme_id 或 share_url 等可下载标识，就不显示「作品已失效」遮罩。
      if (!item || !item.is_invalid) return false;
      const hasDownloadableId = !!(item.aweme_id || item.share_url || item.mix_id || item.music_id);
      return !hasDownloadableId;
    }

    function downloadItem(item) {
      if (isInvalid(item)) return;
      const baseContext = buildDownloadContext();
      let context = baseContext;
      if (context && context.subCategory === 'folders' && item.collection_id && activeCollection.value === 'all') {
        context = { ...context, collectionName: getCollectionName(item.collection_id) };
      }
      if (item.share_url) {
        s.startTask(item.share_url, item.title || '收藏视频', context);
      } else if (item.aweme_id) {
        s.startTask(awemeUrl(item.aweme_id), item.title || '收藏视频', context);
      }
    }

    function downloadMix(item) {
      if (item.mix_id) {
        s.startTask(
          `https://www.douyin.com/collection/${item.mix_id}`,
          item.name || '合集',
          { category: 'favorites', subCategory: 'mixes', mixName: item.name || '合集' }
        );
      }
    }

    function downloadMusic(item) {
      if (item.play_url) {
        s.startTask(
          item.play_url,
          item.title || '收藏音乐',
          { category: 'favorites', subCategory: 'music', musicName: item.title || '收藏音乐' }
        );
      }
    }

    function formatDuration(seconds) {
      if (!seconds || seconds <= 0) return '';
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60).toString().padStart(2, '0');
      return `${m}:${s}`;
    }

    function selectCollection(c) {
      activeCollection.value = c.collects_id || 'all';
    }

    function syncCurrent() {
      if (needsLogin.value || isCurrentSyncing.value) return;
      const subKind = activeTab.value === 'favorites' ? activeSubTab.value : undefined;
      if (activeTab.value === 'favorites' && activeSubTab.value === 'topics') {
        const query = topicQuery.value.trim();
        if (!query) {
          s.showToast('请输入话题 ID 或抖音话题链接');
          return;
        }
        const limit = Math.max(1, Math.min(50000, parseInt(s.settings.syncLimits.topics, 10) || 200));
        const options = { limit, sortStrategy: topicSortStrategy.value };
        s.startSync(currentTab.value.kind, subKind, query, options);
      } else {
        s.startSync(currentTab.value.kind, subKind);
      }
    }

    async function refreshCache() {
      if (needsLogin.value || loading.value || isAnySyncing.value) return;
      loading.value = true;
      await s.loadSyncCache('favorites');
      await s.loadSyncCache('likes');
      await s.loadSyncCache('topics');
      // 刷新按钮同时触发后台同步，确保用户看到最新数据
      const subKind = activeTab.value === 'favorites' ? activeSubTab.value : undefined;
      if (activeTab.value === 'favorites' && activeSubTab.value === 'topics') {
        const query = topicQuery.value.trim() || (topicsCache.value.topic?.query);
        if (query) {
          const limit = Math.max(1, Math.min(50000, parseInt(s.settings.syncLimits.topics, 10) || 200));
          const options = { limit, sortStrategy: topicSortStrategy.value };
          s.startSync(currentTab.value.kind, subKind, query, options);
        }
      } else {
        s.startSync(currentTab.value.kind, subKind);
      }
      loading.value = false;
    }

    async function loadCaches() {
      loading.value = true;
      await s.loadSyncCache('favorites');
      await s.loadSyncCache('likes');
      await s.loadSyncCache('topics');
      if (!topicQuery.value && topicsCache.value.topic?.query) {
        topicQuery.value = topicsCache.value.topic.query;
      }
      if (topicsCache.value.strategy && topicSortStrategy.value === 'default') {
        topicSortStrategy.value = topicsCache.value.strategy;
      }
      loading.value = false;
    }

    onActivated(async () => {
      if (needsLogin.value) return;
      await loadCaches();
      // 若当前标签没有任何缓存，自动触发一次同步，避免页面空白（话题需要用户先输入，不自动同步）
      if (activeTab.value === 'favorites' && activeSubTab.value === 'topics') return;
      const kind = currentTab.value.kind;
      const cache = kind === 'likes' ? likesCache.value : favCache.value;
      const isEmpty = kind === 'likes'
        ? (!cache || !cache.items || cache.items.length === 0)
        : (!cache || (
            (!cache.items || cache.items.length === 0) &&
            (!cache.favorite_videos || cache.favorite_videos.length === 0) &&
            (!cache.collections || cache.collections.length === 0) &&
            (!cache.collect_mixes || cache.collect_mixes.length === 0) &&
            (!cache.music_items || cache.music_items.length === 0)
          ));
      if (isEmpty) {
        const subKind = kind === 'favorites' ? activeSubTab.value : undefined;
        s.startSync(kind, subKind);
      }
    });

    return {
      activeTab, activeSubTab, activeCollection, search, topicQuery, topicSortStrategy, topicSortOptions, showDrawer, loading, tabs, subTabs,
      collections, currentList, filteredList, paginatedList, s, favCache, topicsCache, needsLogin,
      downloadItem, downloadMix, downloadMusic, selectCollection, syncCurrent, refreshCache, loadCaches,
      isCurrentSyncing, isAnySyncing, lastSync, lastSyncTime,
      syncCurrentLabel, syncCountText, syncStatusText, syncErrorText, formatDuration,
      selected, selectedCount, allSelected, toggleSelect, toggleSelectAll, downloadSelected, itemKey,
      isInvalid,
      pageSize, pageSizeOptions, currentPage, totalPages, goPage,
    };
  },
  template: `
    <div class="page-favorites">
    <div class="page-header">
      <div class="page-label">My</div>
      <h1>我的收藏</h1>
      <button class="btn drawer-toggle" @click="showDrawer=true" v-if="!needsLogin"><span v-html="$icons.refresh"></span> 缓存与同步</button>
    </div>
    <PageLogin v-if="needsLogin" />
    <template v-else>
    <div class="sub-tabs">
      <button v-for="t in tabs" :key="t.key" :class="{active: activeTab===t.key}" @click="activeTab=t.key; activeSubTab='folders'; activeCollection='all'">{{ t.label }}</button>
    </div>
    <div v-if="activeTab==='favorites'" class="sub-tabs secondary">
      <button v-for="st in subTabs" :key="st.key" :class="{active: activeSubTab===st.key}" @click="activeSubTab=st.key; activeCollection='all'">{{ st.label }}</button>
    </div>
    <div class="favorites-layout">
      <aside class="collection-list" v-if="activeTab==='favorites' && activeSubTab==='folders'">
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
      </aside>
      <div class="favorites-main">
        <div class="toolbar">
          <div v-if="activeTab==='favorites' && activeSubTab==='topics'" class="search-box topic-input"><span class="icon" v-html="$icons.search"></span><input v-model="topicQuery" placeholder="输入话题 ID、话题链接或抖音短链接" @keyup.enter="syncCurrent" /></div>
          <div v-else class="search-box"><span class="icon" v-html="$icons.search"></span><input v-model="search" :placeholder="(activeTab==='favorites' && activeSubTab==='mixes') ? '搜索名称' : '搜索作品标题 / 作者'" /></div>
          <template v-if="activeTab==='favorites' && activeSubTab==='topics'">
            <div class="topic-option">
              <span class="topic-option-label">排序</span>
              <select v-model="topicSortStrategy" class="topic-sort-select">
                <option v-for="opt in topicSortOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
              </select>
            </div>
          </template>
          <button class="btn btn-primary" @click="syncCurrent" :disabled="loading || isCurrentSyncing" :title="syncCurrentLabel">{{ syncCurrentLabel }}</button>
          <button class="btn" @click="refreshCache" :disabled="loading || isAnySyncing" title="从本地缓存重新加载"><span v-html="$icons.rotateCw"></span> 刷新</button>
          <button v-if="filteredList.length>0" class="btn" @click="toggleSelectAll">
            <span v-html="$icons.checkSquare" style="width:14px;height:14px;margin-right:4px"></span>{{ allSelected ? '取消全选' : '全选本页' }}
          </button>
          <button v-if="filteredList.length>0" class="btn btn-primary" :disabled="selectedCount===0" @click="downloadSelected">下载选中 ({{ selectedCount }})</button>
          <select class="btn page-size-select" v-model.number="pageSize" title="每页显示数量">
            <option v-for="opt in pageSizeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
          <span class="sync-status" :class="{syncing: isCurrentSyncing, error: lastSync?.status === 'error', never: !isCurrentSyncing && !lastSyncTime && lastSync?.status !== 'error'}">
            <span class="status-dot" :class="{spin: isCurrentSyncing}"></span>
            {{ syncStatusText }} · {{ syncCountText }}
          </span>
        </div>
        <div v-if="syncErrorText" class="sync-error">
          <span class="status-dot"></span>
          {{ syncErrorText }}
        </div>
        <div class="content">
          <!-- 我的喜欢 -->
          <template v-if="activeTab==='likes'">
            <div v-if="filteredList.length===0" class="empty-state"><div class="empty-title">当前视图没有作品</div><div class="empty-subtitle">同步完成后，作品会出现在这里</div></div>
            <div v-else class="favorites-grid">
              <div v-for="item in paginatedList" :key="item.aweme_id" class="favorites-card" :class="{invalid: isInvalid(item)}">
                <div class="favorites-cover" :style="item.cover ? {backgroundImage:'url('+item.cover+')',backgroundSize:'cover'} : {}" @click="downloadItem(item)">
                  <div class="video-check" @click.stop><input type="checkbox" :checked="selected.has(itemKey(item))" @change="toggleSelect(item)" :disabled="isInvalid(item)" /></div>
                  <span class="play-icon" v-html="$icons.play"></span>
                  <div v-if="isInvalid(item)" class="invalid-overlay" title="作品已失效"><span>作品已失效</span></div>
                </div>
                <div class="favorites-info">
                  <div class="favorites-title" :title="item.title">{{ item.title || '无标题' }}</div>
                  <div class="favorites-author">{{ item.author?.nickname || '未知作者' }}</div>
                </div>
                <button v-if="!isInvalid(item)" class="btn download-video" @click="downloadItem(item)"><span v-html="$icons.download"></span> 下载</button>
              </div>
            </div>
          </template>
          <!-- 我的收藏夹：左侧边栏选择收藏夹，右侧显示该收藏夹视频 -->
          <template v-if="activeTab==='favorites' && activeSubTab==='folders'">
            <div v-if="filteredList.length===0" class="empty-state"><div class="empty-title">当前收藏夹没有作品</div><div class="empty-subtitle">同步完成后，作品会出现在这里</div></div>
            <div v-else class="favorites-grid">
              <div v-for="item in paginatedList" :key="item.aweme_id" class="favorites-card" :class="{invalid: isInvalid(item)}">
                <div class="favorites-cover" :style="item.cover ? {backgroundImage:'url('+item.cover+')',backgroundSize:'cover'} : {}" @click="downloadItem(item)">
                  <div class="video-check" @click.stop><input type="checkbox" :checked="selected.has(itemKey(item))" @change="toggleSelect(item)" :disabled="isInvalid(item)" /></div>
                  <span class="play-icon" v-html="$icons.play"></span>
                  <div v-if="isInvalid(item)" class="invalid-overlay" title="作品已失效"><span>作品已失效</span></div>
                </div>
                <div class="favorites-info">
                  <div class="favorites-title" :title="item.title">{{ item.title || '无标题' }}</div>
                  <div class="favorites-author">{{ item.author?.nickname || '未知作者' }}</div>
                </div>
                <button v-if="!isInvalid(item)" class="btn download-video" @click="downloadItem(item)"><span v-html="$icons.download"></span> 下载</button>
              </div>
            </div>
          </template>
          <!-- 视频：类似我的喜欢的无侧边栏网格布局 -->
          <template v-else-if="activeTab==='favorites' && activeSubTab==='videos'">
            <div v-if="filteredList.length===0" class="empty-state"><div class="empty-title">当前视图没有作品</div><div class="empty-subtitle">同步完成后，作品会出现在这里</div></div>
            <div v-else class="favorites-grid">
              <div v-for="item in paginatedList" :key="item.aweme_id" class="favorites-card" :class="{invalid: isInvalid(item)}">
                <div class="favorites-cover" :style="item.cover ? {backgroundImage:'url('+item.cover+')',backgroundSize:'cover'} : {}" @click="downloadItem(item)">
                  <div class="video-check" @click.stop><input type="checkbox" :checked="selected.has(itemKey(item))" @change="toggleSelect(item)" :disabled="isInvalid(item)" /></div>
                  <span class="play-icon" v-html="$icons.play"></span>
                  <div v-if="isInvalid(item)" class="invalid-overlay" title="作品已失效"><span>作品已失效</span></div>
                </div>
                <div class="favorites-info">
                  <div class="favorites-title" :title="item.title">{{ item.title || '无标题' }}</div>
                  <div class="favorites-author">{{ item.author?.nickname || '未知作者' }}</div>
                </div>
                <button v-if="!isInvalid(item)" class="btn download-video" @click="downloadItem(item)"><span v-html="$icons.download"></span> 下载</button>
              </div>
            </div>
          </template>
          <!-- 合集 -->
          <div v-else-if="activeTab==='favorites' && activeSubTab==='mixes'" class="video-list">
            <div v-if="filteredList.length===0" class="empty-state"><div class="empty-title">当前视图没有合集</div><div class="empty-subtitle">同步完成后，合集会出现在这里</div></div>
            <div v-for="item in paginatedList" :key="item.mix_id" class="video-card">
              <div class="video-check" @click.stop><input type="checkbox" :checked="selected.has(itemKey(item))" @change="toggleSelect(item)" /></div>
              <div class="video-cover" :style="item.cover ? {backgroundImage:'url('+item.cover+')',backgroundSize:'cover'} : {}"><span class="play-icon" v-html="$icons.play"></span></div>
              <div class="video-info">
                <div class="video-title">{{ item.name }}</div>
                <div class="video-meta">{{ item.video_count || 0 }} 个作品</div>
              </div>
              <button class="btn download-video" @click="downloadMix(item)"><span v-html="$icons.download"></span> 下载</button>
            </div>
          </div>
          <!-- 音乐 -->
          <div v-else-if="activeTab==='favorites' && activeSubTab==='music'" class="music-list">
            <div v-if="filteredList.length===0" class="empty-state"><div class="empty-title">当前视图没有音乐</div><div class="empty-subtitle">同步完成后，音乐会出现在这里</div></div>
            <div v-for="item in paginatedList" :key="item.music_id" class="music-card">
              <div class="video-check" @click.stop><input type="checkbox" :checked="selected.has(itemKey(item))" @change="toggleSelect(item)" /></div>
              <div class="music-cover" :style="item.cover ? {backgroundImage:'url('+item.cover+')',backgroundSize:'cover'} : {}">
                <span class="music-icon" v-html="$icons.music"></span>
              </div>
              <div class="music-info">
                <div class="music-title" :title="item.title">{{ item.title || '未知音乐' }}</div>
                <div class="music-author">{{ item.author?.nickname || '未知作者' }}</div>
                <div class="music-meta" v-if="item.duration || item.usage_count">{{ formatDuration(item.duration) }}<template v-if="item.duration && item.usage_count"> · </template>{{ item.usage_count ? item.usage_count + ' 次使用' : '' }}</div>
              </div>
              <button class="btn btn-icon" v-if="item.play_url" @click="downloadMusic(item)" title="下载音乐"><span v-html="$icons.download"></span></button>
            </div>
          </div>
          <!-- 话题 -->
          <div v-else-if="activeTab==='favorites' && activeSubTab==='topics'" class="topics-view">
            <div v-if="topicsCache.topic" class="topic-header">
              <div class="topic-cover" :style="topicsCache.topic.cover ? {backgroundImage:'url('+topicsCache.topic.cover+')',backgroundSize:'cover'} : {}"></div>
              <div class="topic-meta">
                <div class="topic-name">#{{ topicsCache.topic.name || '话题' }}</div>
                <div class="topic-desc" v-if="topicsCache.topic.description">{{ topicsCache.topic.description }}</div>
                <div class="topic-counts">{{ topicsCache.topic.user_count ? topicsCache.topic.user_count + ' 人参与' : '' }}<template v-if="topicsCache.topic.user_count && topicsCache.topic.view_count"> · </template>{{ topicsCache.topic.view_count ? topicsCache.topic.view_count + ' 次播放' : '' }}</div>
              </div>
            </div>
            <div v-if="filteredList.length===0" class="empty-state"><div class="empty-title">当前话题没有作品</div><div class="empty-subtitle">输入话题 ID 或链接后点击“同步话题”</div></div>
            <div v-else class="favorites-grid">
              <div v-for="item in paginatedList" :key="item.aweme_id" class="favorites-card">
                <div class="favorites-cover" :style="item.cover ? {backgroundImage:'url('+item.cover+')',backgroundSize:'cover'} : {}" @click="downloadItem(item)">
                  <div class="video-check" @click.stop><input type="checkbox" :checked="selected.has(itemKey(item))" @change="toggleSelect(item)" /></div>
                  <span class="play-icon" v-html="$icons.play"></span>
                </div>
                <div class="favorites-info">
                  <div class="favorites-title" :title="item.title">{{ item.title || '无标题' }}</div>
                  <div class="favorites-author">{{ item.author?.nickname || '未知作者' }}</div>
                </div>
                <button class="btn download-video" @click="downloadItem(item)"><span v-html="$icons.download"></span> 下载</button>
              </div>
            </div>
          </div>
        </div>
        <div class="favorites-footer">
          <span>
            已加载 {{ filteredList.length }} / {{ currentList.length }}
            <template v-if="activeTab==='favorites' && activeSubTab==='mixes'"> 个合集</template>
            <template v-else-if="activeTab==='favorites' && activeSubTab==='music'"> 首</template>
            <template v-else> 条</template>
          </span>
        </div>
        <div class="pagination" v-if="filteredList.length > 0">
          <div>共 {{ filteredList.length }} 条 · 第 {{ currentPage }} / {{ totalPages }} 页</div>
          <div class="pages">
            <button :disabled="currentPage <= 1" @click="goPage(currentPage - 1)">‹</button>
            <button :disabled="currentPage >= totalPages" @click="goPage(currentPage + 1)">›</button>
          </div>
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
          <div class="drawer-row"><span>我的收藏（视频）<br><small>1–50,000</small></span><input type="number" v-model.number="s.settings.syncLimits.favorites" min="1" max="50000" /></div>
          <div class="drawer-row"><span>我收藏的合集<br><small>1–50,000</small></span><input type="number" v-model.number="s.settings.syncLimits.collections" min="1" max="50000" /></div>
          <div class="drawer-row"><span>收藏音乐<br><small>1–50,000</small></span><input type="number" v-model.number="s.settings.syncLimits.favoritesMusic" min="1" max="50000" /></div>
          <div class="drawer-row"><span>我的喜欢<br><small>1–50,000</small></span><input type="number" v-model.number="s.settings.syncLimits.likes" min="1" max="50000" /></div>
          <div class="drawer-row"><span>关注博主<br><small>1–50,000</small></span><input type="number" v-model.number="s.settings.syncLimits.following" min="1" max="50000" /></div>
          <div class="drawer-row"><span>话题视频<br><small>1–50,000</small></span><input type="number" v-model.number="s.settings.syncLimits.topics" min="1" max="50000" /></div>
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
          <button class="btn clear-cache" @click="s.clearSyncCache('new_releases')">清空缓存 <span>新发布</span></button>
          <button class="btn clear-cache" @click="s.clearSyncCache('topics')">清空缓存 <span>话题</span></button>
        </div>
      </div>
    </div>
    </template>
    </div>
  `
};

const PageNewReleases = {
  setup() {
    const s = inject('store');
    const search = ref('');
    const selected = ref({});
    const loading = ref(false);
    const filtering = ref(false);
    const showSettings = ref(false);
    const pageSize = ref(50);
    const currentPage = ref(1);
    const pageSizeOptions = [
      { value: 50, label: '50 / 页' },
      { value: 100, label: '100 / 页' },
      { value: 500, label: '500 / 页' },
      { value: 1000, label: '1000 / 页' },
      { value: -1, label: '全部' },
    ];

    const needsLogin = computed(() => !s.user.isLoggedIn);
    const isRunning = computed(() => s.newReleases.status === 'running');
    const isCancelling = computed(() => s.newReleases.status === 'cancelling');
    const isActive = computed(() => isRunning.value || isCancelling.value);
    const isDone = computed(() => s.newReleases.status === 'done');
    const isCancelled = computed(() => s.newReleases.status === 'cancelled');
    const isError = computed(() => s.newReleases.status === 'error');

    watch(isActive, (active) => {
      if (!active && filtering.value) {
        filtering.value = false;
        loading.value = false;
      }
    });

    // 优先使用持久化缓存；运行期间同时叠加实时发现的条目，保证进度可见
    const cache = computed(() => s.syncCache.new_releases || { items: [], updated_at: null, total: 0 });
    const displayItems = computed(() => {
      const runtime = s.newReleases.items || [];
      if (runtime.length > 0) return runtime;
      return cache.value.items || [];
    });

    const filteredItems = computed(() => {
      const q = search.value.trim().toLowerCase();
      if (!q) return displayItems.value;
      return displayItems.value.filter(item => {
        const title = (item.title || '').toLowerCase();
        const author = ((item.author && item.author.nickname) || '').toLowerCase();
        return title.includes(q) || author.includes(q);
      });
    });

    const totalPages = computed(() => {
      if (pageSize.value === -1 || filteredItems.value.length === 0) return 1;
      return Math.ceil(filteredItems.value.length / pageSize.value);
    });

    const paginatedItems = computed(() => {
      if (pageSize.value === -1) return filteredItems.value;
      const start = (currentPage.value - 1) * pageSize.value;
      return filteredItems.value.slice(start, start + pageSize.value);
    });

    watch([() => search.value, () => pageSize.value], () => {
      currentPage.value = 1;
    });

    const selectedCount = computed(() => {
      return Object.values(selected.value).filter(Boolean).length;
    });

    const allSelected = computed(() => {
      if (paginatedItems.value.length === 0) return false;
      return paginatedItems.value.every(item => selected.value[item.aweme_id]);
    });

    const lastSyncTime = computed(() => cache.value.updated_at || null);

    const authorSource = computed(() => s.settings.syncLimits?.newReleasesAuthorSource || 'downloaded');
    const newReleasesDays = computed(() => s.settings.syncLimits?.newReleasesDays || 7);
    const emptySubtitle = computed(() => authorSource.value === 'all'
      ? `关注列表中的博主近 ${newReleasesDays.value} 天内没有未下载的新作品`
      : `已下载过的博主近 ${newReleasesDays.value} 天内没有发布新视频`);

    const syncStatusText = computed(() => {
      if (isCancelling.value) {
        return '正在取消...';
      }
      if (isRunning.value) {
        const p = s.newReleases.progress || {};
        return p.message || '正在检查新发布...';
      }
      if (isError.value) {
        return s.newReleases.error || '检查失败';
      }
      if (isCancelled.value) {
        return '已取消';
      }
      if (lastSyncTime.value) {
        return '已同步 ' + formatTimeLabel(lastSyncTime.value);
      }
      return '从未同步过';
    });

    const countText = computed(() => {
      if (isActive.value) {
        const p = s.newReleases.progress || {};
        const current = p.current || 0;
        const total = p.total || 0;
        return total > 0 ? `${current} / ${total}` : '';
      }
      return `${displayItems.value.length} 个新作品`;
    });

    function goPage(page) {
      if (page < 1) page = 1;
      if (page > totalPages.value) page = totalPages.value || 1;
      currentPage.value = page;
    }

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
        paginatedItems.value.forEach(item => delete next[item.aweme_id]);
      } else {
        paginatedItems.value.forEach(item => { next[item.aweme_id] = true; });
      }
      selected.value = next;
    }

    function downloadItem(item) {
      const url = item.share_url || awemeUrl(item.aweme_id);
      s.startTask(url, item.title || '新发布视频');
    }

    function downloadSelected() {
      const items = displayItems.value.filter(item => selected.value[item.aweme_id]);
      if (items.length === 0) return;
      const urls = items.map(item => item.share_url || awemeUrl(item.aweme_id)).filter(Boolean);
      if (urls.length === 0) return;
      s.startTask(urls, `新发布 ${items.length} 个作品`);
      selected.value = {};
    }

    async function deleteSelected() {
      const ids = Object.keys(selected.value).filter(id => selected.value[id]);
      if (ids.length === 0) return;
      if (!confirm(`确定要从新发布记录中删除选中的 ${ids.length} 个作品？`)) return;
      const idSet = new Set(ids);
      // 同时更新运行时列表与持久化缓存
      s.newReleases.items = (s.newReleases.items || []).filter(item => !idSet.has(String(item.aweme_id)));
      const cached = s.syncCache.new_releases || { items: [], updated_at: null, total: 0 };
      const nextItems = (cached.items || []).filter(item => !idSet.has(String(item.aweme_id)));
      const nextCache = {
        ...cached,
        items: nextItems,
        total: nextItems.length,
        updated_at: cached.updated_at || new Date().toISOString(),
      };
      await s.saveSyncCache('new_releases', nextCache);
      selected.value = {};
      if (currentPage.value > totalPages.value) {
        currentPage.value = totalPages.value || 1;
      }
    }

    function startSync() {
      if (needsLogin.value || isActive.value) return;
      selected.value = {};
      s.startNewReleases();
    }

    async function refreshCache() {
      if (needsLogin.value || loading.value || isActive.value) return;
      // 刷新模式：根据数据库最新下载记录重新过滤本地缓存，不访问抖音接口
      filtering.value = true;
      loading.value = true;
      s.startNewReleases(true);
    }

    onActivated(() => {
      if (!needsLogin.value) {
        s.loadSyncCache('new_releases');
      }
    });

    return {
      s, search, selected, selectedCount, loading, showSettings, needsLogin, isRunning, isCancelling, isActive, isDone, isCancelled, isError,
      cache, displayItems, filteredItems, paginatedItems, allSelected, lastSyncTime, syncStatusText, countText,
      emptySubtitle, authorSource, newReleasesDays, pageSize, pageSizeOptions, currentPage, totalPages,
      toggleSelect, toggleSelectAll, downloadItem, downloadSelected, deleteSelected, startSync, refreshCache, goPage,
    };
  },
  template: `
    <div class="page-header">
      <div class="page-label">New</div>
      <h1>新发布</h1>
      <div class="page-header-actions">
        <button class="btn" :disabled="isActive || needsLogin" @click="startSync">
          <span :class="{spin: isActive}" v-html="$icons.refresh"></span> {{ isActive ? '检查中' : '同步新发布' }}
        </button>
        <button class="btn" :disabled="isActive || loading || needsLogin" @click="refreshCache" title="从本地缓存重新加载">
          <span :class="{spin: loading}" v-html="$icons.rotateCw"></span> {{ loading ? '加载中' : '刷新' }}
        </button>
        <button class="btn btn-icon" @click="showSettings = true" title="新发布设置">
          <span v-html="$icons.settings"></span>
        </button>
        <button class="btn" v-if="isRunning" @click="s.cancelNewReleases()">取消</button>
      </div>
    </div>
    <PageLogin v-if="needsLogin" />
    <template v-else>
      <div class="toolbar" style="padding-top:0">
        <div class="search-box"><span class="icon" v-html="$icons.search"></span><input v-model="search" placeholder="搜索作品标题 / 博主" /></div>
        <button class="btn btn-primary" :disabled="selectedCount===0" @click="downloadSelected">下载选中 ({{ selectedCount }})</button>
        <button class="btn" @click="toggleSelectAll">{{ allSelected ? '取消全选' : '全选本页' }}</button>
        <button class="btn btn-danger" :disabled="selectedCount===0" @click="deleteSelected">删除记录 ({{ selectedCount }})</button>
        <select class="btn page-size-select" v-model.number="pageSize" title="每页显示数量">
          <option v-for="opt in pageSizeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
        <span class="sync-status" :class="{syncing: isActive, error: isError, never: !isActive && !isError && !lastSyncTime && !isCancelled}">
          <span class="status-dot" :class="{spin: isActive}"></span>
          {{ syncStatusText }} · {{ countText }}
        </span>
        <span class="source-tag" :title="authorSource === 'all' ? '检查全部关注博主' : '仅检查已下载过的博主'">{{ authorSource === 'all' ? '全部关注' : '仅已下载' }}</span>
      </div>
      <div class="content">
        <div v-if="displayItems.length===0 && !isActive && isDone" class="empty-state">
          <div class="empty-title">所有博主暂无新作品</div>
          <div class="empty-subtitle">{{ emptySubtitle }}</div>
        </div>
        <div v-else-if="displayItems.length===0 && !isActive && isError" class="empty-state">
          <div class="empty-title">检查失败</div>
          <div class="empty-subtitle">{{ s.newReleases.error || '请稍后重试' }}</div>
        </div>
        <div v-else-if="displayItems.length===0 && !isActive && isCancelled" class="empty-state">
          <div class="empty-title">已取消</div>
          <div class="empty-subtitle">本次检查已取消</div>
        </div>
        <div v-else-if="displayItems.length===0 && !isActive" class="empty-state">
          <div class="big-icon" v-html="$icons.refresh"></div>
          <div>点击上方「同步新发布」开始检查</div>
        </div>
        <div v-else-if="filteredItems.length===0" class="empty-state">
          <div class="empty-title">没有匹配的作品</div>
        </div>
        <div v-else class="video-list">
          <div v-for="item in paginatedItems" :key="item.aweme_id" class="video-card">
            <div class="video-check"><input type="checkbox" :checked="selected[item.aweme_id]" @change="toggleSelect(item)" /></div>
            <div class="video-cover" :style="item.cover ? {backgroundImage:'url('+item.cover+')',backgroundSize:'cover'} : {}"><span class="play-icon" v-html="$icons.play"></span></div>
            <div class="video-info">
              <div class="video-title">{{ item.title || '无标题' }}</div>
              <div class="video-meta">{{ item.author?.nickname || '未知作者' }} · {{ $formatDate(item.create_time) }}</div>
            </div>
            <button class="btn download-video" @click="downloadItem(item)"><span v-html="$icons.download"></span> 下载</button>
          </div>
        </div>
        <div class="pagination" v-if="displayItems.length > 0 && filteredItems.length > 0 && !isActive && pageSize !== -1">
          <div>共 {{ filteredItems.length }} 个作品 · 当前第 {{ currentPage }} / {{ totalPages }} 页</div>
          <div class="pages">
            <button :disabled="currentPage <= 1" @click="goPage(currentPage - 1)">‹</button>
            <button :disabled="currentPage >= totalPages" @click="goPage(currentPage + 1)">›</button>
          </div>
        </div>
      </div>
      <div class="drawer-overlay" v-if="showSettings" @click="showSettings=false"></div>
      <div class="drawer" :class="{open: showSettings}">
        <div class="drawer-header">
          <h3>新发布设置</h3>
          <button class="btn btn-icon" @click="showSettings=false" v-html="$icons.close"></button>
        </div>
        <div class="drawer-body">
          <div class="drawer-section">
            <div class="drawer-section-title"><span class="dot dot-accent"></span>SYNC LIMITS</div>
            <p>只检查已下载过的博主，并只保留设定天数内发布且未下载的作品。</p>
            <div class="drawer-row">
              <span>博主来源<br><small>仅已下载：只关注本地有下载记录的博主</small></span>
              <select v-model="s.settings.syncLimits.newReleasesAuthorSource">
                <option value="downloaded">仅已下载过的博主</option>
                <option value="all">全部关注博主</option>
              </select>
            </div>
            <div class="drawer-row"><span>检查博主数<br><small>1–2,000</small></span><input type="number" v-model.number="s.settings.syncLimits.newReleasesAuthors" min="1" max="2000" /></div>
            <div class="drawer-row"><span>每位博主最多新作品<br><small>1–100</small></span><input type="number" v-model.number="s.settings.syncLimits.newReleasesPerAuthor" min="1" max="100" /></div>
            <div class="drawer-row"><span>只同步近 N 天<br><small>1–365</small></span><input type="number" v-model.number="s.settings.syncLimits.newReleasesDays" min="1" max="365" /></div>
          </div>
          <div class="drawer-section">
            <div class="drawer-section-title"><span class="dot dot-danger"></span>CLEAR CACHE</div>
            <p>仅清除本地新发布缓存，不会影响抖音侧的收藏/喜欢列表。</p>
            <button class="btn clear-cache" @click="s.clearSyncCache('new_releases'); showSettings=false">清空缓存 <span>新发布</span></button>
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
      // 抖音搜索话题链接：/search/%23话题名 或 /search/#话题名
      if (/\/search\/(?:%23|#)[^/?&]+/.test(u) || /[?&]keyword=(?:%23|#)[^&]+/.test(u)) return { type: 'topic', label: '话题' };
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
      if (detected?.type === 'topic') {
        s.startSync('favorites', 'topics', u);
        s.showToast('已开始同步话题');
        url.value = '';
        recognized.value = null;
        return;
      }
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
    const statusFilter = ref('all');
    const search = ref('');
    const selected = ref(new Set());
    const menuOpen = ref(null);
    const sortKey = ref('newest');
    const nowMs = ref(Date.now());

    const tabConfig = {
      download: { label: '下载任务', key: 'tasks', empty: '暂无下载任务', icon: 'download' },
      sync: { label: '同步任务', key: 'syncs', empty: '暂无同步任务', icon: 'refresh' },
      relation: { label: '关注/取关', key: 'relationTasks', empty: '暂无批量关注/取关任务', icon: 'users' },
      report: { label: '报表导出', key: 'reportTasks', empty: '暂无报表导出任务', icon: 'chart' },
      cloud: { label: '云同步', key: 'cloudTasks', empty: '暂无云同步任务', icon: 'cloud' },
      dedup: { label: '去重任务', key: 'dedupTasks', empty: '暂无去重任务', icon: 'copy' },
    };

    const statusOptions = [
      { value: 'all', label: '全部' },
      { value: 'running', label: '进行中' },
      { value: 'completed', label: '已完成' },
      { value: 'failed', label: '失败' },
      { value: 'cancelled', label: '已取消' },
    ];

    const sortOptions = [
      { value: 'newest', label: '最新优先' },
      { value: 'oldest', label: '最早优先' },
      { value: 'status', label: '按状态' },
      { value: 'progress', label: '按进度' },
    ];

    const statusOrder = { running: 0, cancelling: 1, success: 2, error: 3, cancelled: 4 };

    function rawList() {
      return s[tabConfig[activeTab.value].key];
    }

    const statusCounts = computed(() => {
      const list = rawList();
      return {
        all: list.length,
        running: list.filter(t => t.status === 'running' || t.status === 'cancelling').length,
        completed: list.filter(t => t.status === 'success').length,
        failed: list.filter(t => t.status === 'error').length,
        cancelled: list.filter(t => t.status === 'cancelled').length,
      };
    });

    const filteredTasks = computed(() => {
      let list = rawList();
      if (statusFilter.value !== 'all') {
        if (statusFilter.value === 'running') {
          list = list.filter(t => t.status === 'running' || t.status === 'cancelling');
        } else if (statusFilter.value === 'completed') {
          list = list.filter(t => t.status === 'success');
        } else if (statusFilter.value === 'failed') {
          list = list.filter(t => t.status === 'error');
        } else {
          list = list.filter(t => t.status === statusFilter.value);
        }
      }
      const q = search.value.trim().toLowerCase();
      if (q) {
        list = list.filter(t => {
          const text = `${taskTitle(t)} ${taskSubtitle(t)} ${t.step || ''} ${taskLatestLog(t)}`.toLowerCase();
          return text.includes(q);
        });
      }
      const sorted = [...list];
      if (sortKey.value === 'newest') {
        sorted.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
      } else if (sortKey.value === 'oldest') {
        sorted.sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
      } else if (sortKey.value === 'status') {
        sorted.sort((a, b) => (statusOrder[a.status] || 9) - (statusOrder[b.status] || 9));
      } else if (sortKey.value === 'progress') {
        sorted.sort((a, b) => (b.progress || 0) - (a.progress || 0));
      }
      return sorted;
    });

    const allTasks = computed(() => [
      ...s.tasks,
      ...s.syncs,
      ...s.relationTasks,
      ...s.reportTasks,
      ...s.cloudTasks,
      ...s.dedupTasks,
    ]);

    const runningCount = computed(() => allTasks.value.filter(t => t.status === 'running' || t.status === 'cancelling').length);
    const todaySuccess = computed(() => allTasks.value.filter(t => t.status === 'success' && isToday(t.createdAtMs || t.createdAt)).length);
    const todayFailed = computed(() => allTasks.value.filter(t => t.status === 'error' && isToday(t.createdAtMs || t.createdAt)).length);
    const totalCount = computed(() => allTasks.value.length);
    const hasRunning = computed(() => filteredTasks.value.some(t => isRunning(t)));
    const hasFailed = computed(() => filteredTasks.value.some(t => t.status === 'error'));

    function isToday(dateInput) {
      const d = new Date(dateInput);
      const n = new Date();
      return !isNaN(d.getTime()) && d.toDateString() === n.toDateString();
    }

    function switchTab(tab) {
      activeTab.value = tab;
      statusFilter.value = 'all';
      search.value = '';
      sortKey.value = 'newest';
      selected.value = new Set();
      menuOpen.value = null;
      expanded.value = {};
    }

    function clearFilters() {
      statusFilter.value = 'all';
      search.value = '';
      sortKey.value = 'newest';
    }

    function statusText(status) {
      const map = { running: '进行中', cancelling: '取消中', success: '已完成', error: '失败', cancelled: '已取消' };
      return map[status] || status;
    }

    function statusBadgeClass(status) {
      if (status === 'running' || status === 'cancelling') return 'status-running';
      if (status === 'success') return 'status-success';
      if (status === 'error') return 'status-error';
      if (status === 'cancelled') return 'status-cancelled';
      return '';
    }

    function taskTitle(task) {
      if (task.id.startsWith('task-')) return task.name || '下载任务';
      if (task.id.startsWith('sync-')) {
        if (task.kind === 'favorites') {
          const subMap = { folders: '收藏夹', videos: '收藏视频', music: '收藏音乐', mixes: '收藏合集', topics: '话题' };
          return `${subMap[task.subKind] || '收藏'} 同步`;
        }
        const map = { likes: '喜欢', following: '关注', newReleases: '新发布' };
        return `${map[task.kind] || task.kind} 同步`;
      }
      if (task.id.startsWith('relation-')) return task.action === 'follow' ? '批量关注' : '批量取关';
      if (task.id.startsWith('report-')) return '下载报表导出';
      if (task.id.startsWith('cloud-backup-')) return '云端备份';
      if (task.id.startsWith('cloud-restore-')) return '云端恢复';
      if (task.id.startsWith('dedup-')) return '作品去重';
      return '任务';
    }

    function taskSubtitle(task) {
      if (task.id.startsWith('task-')) {
        const links = task.urls?.length || 0;
        return links > 1 ? `${links} 个链接` : '单个链接';
      }
      if (task.id.startsWith('sync-')) {
        if (task.kind === 'newReleases') return `已检查博主 ${task.total || 0} · 新作品 ${task.added || 0}`;
        if (task.status === 'success' || task.status === 'done' || task.status === 'completed' || task.drained) {
          return `已完成 · 共 ${task.added || 0} 条`;
        }
        return `已拉取 ${task.added || 0} 条`;
      }
      if (task.id.startsWith('relation-')) return `${task.total || 0} 位用户`;
      if (task.id.startsWith('report-')) {
        const opts = task.options || {};
        const parts = [];
        if (opts.dateFrom || opts.dateTo) parts.push(`${opts.dateFrom || ''} ~ ${opts.dateTo || ''}`);
        if (opts.groupBy) parts.push(`按 ${opts.groupBy}`);
        return parts.length ? parts.join(' · ') : '导出下载记录报表';
      }
      if (task.id.startsWith('cloud-')) return task.kind === 'backup' ? '备份设置与数据库' : '通过 Token 恢复数据';
      if (task.id.startsWith('dedup-')) {
        const groups = task.duplicateGroups || 0;
        const deleted = task.deletedFiles || 0;
        const freed = task.freedBytes || 0;
        return `${groups} 组重复 · 删除 ${deleted} 个文件 · 释放 ${formatSize(freed)}`;
      }
      return '';
    }

    function taskIcon(task) {
      if (task.id.startsWith('task-')) return 'download';
      if (task.id.startsWith('sync-')) return 'refresh';
      if (task.id.startsWith('relation-')) return 'users';
      if (task.id.startsWith('report-')) return 'chart';
      if (task.id.startsWith('cloud-')) return 'cloud';
      if (task.id.startsWith('dedup-')) return 'copy';
      return 'more';
    }

    function taskUrl(task) {
      if (task.id.startsWith('task-') && task.urls && task.urls.length) return task.urls[0];
      return '';
    }

    function taskTime(task) {
      return relativeTime(task.createdAtMs || task.createdAt);
    }

    function isRunning(task) {
      return task.status === 'running' || task.status === 'cancelling';
    }

    function canRetryFailed(task) {
      if (isRunning(task)) return false;
      if (task.id.startsWith('task-')) return (task.failed || 0) > 0;
      if (task.id.startsWith('relation-') && task.summary && Array.isArray(task.summary.results)) {
        return task.summary.results.some(r => !r.success);
      }
      return false;
    }

    function hasResult(task) {
      return (task.id.startsWith('report-') && task.result && task.result.length) ||
        (task.id.startsWith('cloud-restore-') && task.token);
    }

    function taskLatestLog(task) {
      const logs = task.logs || [];
      if (!logs.length) return '';
      return logs[logs.length - 1];
    }

    function taskDuration(task) {
      const start = task.createdAtMs || new Date(task.createdAt).getTime();
      if (!start) return '';
      const ms = nowMs.value - start;
      return formatDuration(ms);
    }

    function formatDuration(ms) {
      if (ms < 0) ms = 0;
      const sec = Math.floor(ms / 1000);
      if (sec < 60) return `${sec} 秒`;
      const min = Math.floor(sec / 60);
      const s = sec % 60;
      if (min < 60) return `${min}:${s.toString().padStart(2, '0')}`;
      const h = Math.floor(min / 60);
      const m = min % 60;
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }

    function formatSize(bytes) {
      if (!bytes || bytes <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let i = 0;
      let size = bytes;
      while (size >= 1024 && i < units.length - 1) {
        size /= 1024;
        i++;
      }
      return `${size.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
    }

    function taskOutputPath(task) {
      if (task.id.startsWith('task-') && s.settings.outputPath) return s.settings.outputPath;
      return '';
    }

    function buildTaskAuthorPath(task) {
      const base = s.settings.outputPath;
      if (!base) return '';
      const parts = [];
      const ctx = task.downloadContext;
      if (ctx && ctx.category) {
        if (ctx.category === 'likes') {
          parts.push('我的喜欢');
        } else if (ctx.category === 'favorites') {
          parts.push('我的收藏');
          const subNames = { folders: '我的收藏夹', videos: '视频', music: '音乐', mixes: '合集', topics: '话题' };
          if (ctx.subCategory && subNames[ctx.subCategory]) {
            parts.push(subNames[ctx.subCategory]);
          }
          if (ctx.collectionName) parts.push(ctx.collectionName);
          if (ctx.mixName) parts.push(ctx.mixName);
          if (ctx.topicName) parts.push(ctx.topicName);
        }
      }
      const isBatchLike = typeof task.name === 'string' && (task.name.startsWith('批量下载 ') || task.name.startsWith('新发布 '));
      if (task.nickname && !isBatchLike) {
        parts.push(task.nickname);
      }
      if (parts.length === 0) return base;
      return window.electronAPI.pathJoinSync(base, ...parts);
    }

    function openOutput(task) {
      const p = taskOutputPath(task);
      if (p && window.electronAPI && window.electronAPI.openFolder) {
        window.electronAPI.openFolder(buildTaskAuthorPath(task) || p);
      }
      menuOpen.value = null;
    }

    function toggleLog(id) {
      expanded.value[id] = !expanded.value[id];
    }

    function toggleSelect(id) {
      const next = new Set(selected.value);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      selected.value = next;
    }

    function allVisibleSelected() {
      return filteredTasks.value.length > 0 && filteredTasks.value.every(t => selected.value.has(t.id));
    }

    function toggleSelectAll() {
      const next = new Set(selected.value);
      if (allVisibleSelected()) {
        filteredTasks.value.forEach(t => next.delete(t.id));
      } else {
        filteredTasks.value.forEach(t => next.add(t.id));
      }
      selected.value = next;
    }

    function selectAllVisible() {
      const next = new Set(selected.value);
      filteredTasks.value.forEach(t => next.add(t.id));
      selected.value = next;
    }

    function clearSelection() {
      selected.value = new Set();
    }

    function selectedTasks() {
      return filteredTasks.value.filter(t => selected.value.has(t.id));
    }

    function taskArrayFor(task) {
      if (task.id.startsWith('task-')) return s.tasks;
      if (task.id.startsWith('sync-')) return s.syncs;
      if (task.id.startsWith('relation-')) return s.relationTasks;
      if (task.id.startsWith('report-')) return s.reportTasks;
      if (task.id.startsWith('cloud-')) return s.cloudTasks;
      if (task.id.startsWith('dedup-')) return s.dedupTasks;
      if (task.id.startsWith('userWorks-')) return s.userWorks;
      return null;
    }

    function removeTask(task) {
      // 删除前先取消正在运行/取消中的任务，避免后端进程继续运行且前端
      // 收到已删除任务的进度/完成事件导致状态异常。
      if (isRunning(task)) {
        cancelTask(task);
      }
      const arr = taskArrayFor(task);
      if (arr) {
        const key = Object.keys(s).find(k => s[k] === arr);
        if (key) s[key] = arr.filter(t => t.id !== task.id);
      }
      s.saveTaskHistory();
      const next = new Set(selected.value);
      next.delete(task.id);
      selected.value = next;
      menuOpen.value = null;
    }

    function cancelTask(task) {
      if (task.id.startsWith('task-')) s.cancelTask(task.id);
      else if (task.id.startsWith('sync-')) s.cancelSync(task.id);
      else if (task.id.startsWith('relation-')) s.cancelRelationTask(task.id);
      else if (task.id.startsWith('report-')) s.cancelReport(task.id);
      else if (task.id.startsWith('cloud-')) s.cancelCloud(task.id);
      else if (task.id.startsWith('dedup-')) s.cancelDedupTask(task.id);
      else if (task.id.startsWith('userWorks-')) s.cancelUserWorks(task.id);
      menuOpen.value = null;
    }

    function rerunTask(task) {
      const rawTask = Vue.toRaw ? Vue.toRaw(task) : JSON.parse(JSON.stringify(task));
      const currentlyRunning = task.status === 'running' || task.status === 'cancelling';
      if (currentlyRunning) cancelTask(task);
      removeTask(task);
      if (rawTask.id.startsWith('task-')) {
        s.startTask(rawTask.urls, rawTask.name, rawTask.downloadContext);
      } else if (rawTask.id.startsWith('sync-')) {
        if (rawTask.kind === 'newReleases') {
          s.startNewReleases();
        } else {
          s.startSync(rawTask.kind, rawTask.subKind, rawTask.query, {
            limit: rawTask.limit,
            sortStrategy: rawTask.sortStrategy,
          });
        }
      } else if (rawTask.id.startsWith('relation-')) {
        s.startRelationTask(rawTask.action, rawTask.secUids);
      } else if (rawTask.id.startsWith('report-') && rawTask.options) {
        s.exportReport(rawTask.options);
      } else if (rawTask.id.startsWith('cloud-backup-')) {
        s.backupCloud();
      } else if (rawTask.id.startsWith('cloud-restore-') && rawTask.token) {
        s.restoreCloud(rawTask.token);
      } else if (rawTask.id.startsWith('dedup-')) {
        s.startDedupTask(s.settings.outputPath);
      }
      menuOpen.value = null;
    }

    function retryFailed(task) {
      if (task.id.startsWith('task-')) {
        // 仅重试有失败的 URL；没有记录时回退到全部 URL
        const failedUrls = (task.urlResults || [])
          .filter(r => (r.failed || 0) > 0)
          .map(r => r.url)
          .filter(Boolean);
        const urlsToRetry = failedUrls.length > 0 ? failedUrls : task.urls;
        if (urlsToRetry.length > 0) {
          const name = task.name;
          const ctx = task.downloadContext;
          // 重试前先移除旧任务记录，避免新旧记录混淆
          removeTask(task);
          s.startTask(urlsToRetry, name, ctx);
        }
      } else if (task.id.startsWith('relation-') && task.summary && Array.isArray(task.summary.results)) {
        const failed = task.summary.results.filter(r => !r.success).map(r => r.sec_uid).filter(Boolean);
        if (failed.length) {
          const action = task.action;
          // 重试前先移除旧任务记录，避免新旧记录混淆
          removeTask(task);
          s.startRelationTask(action, failed);
        }
      } else {
        rerunTask(task);
      }
      menuOpen.value = null;
    }

    function retryAllFailed() {
      const failed = rawList().filter(t => t.status === 'error');
      menuOpen.value = null;
      runInChunks(failed, retryFailed, 4);
    }

    function copyLink(task) {
      const url = taskUrl(task);
      if (!url) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url);
      } else {
        const ta = document.createElement('textarea');
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      menuOpen.value = null;
    }

    function copyLogs(task) {
      const text = (task.logs || []).join('\n');
      if (!text) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      menuOpen.value = null;
    }

    function exportLog(task) {
      const text = (task.logs || []).join('\n');
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `task-log-${task.id}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      menuOpen.value = null;
    }

    function clearDoneCurrentTab() {
      const key = tabConfig[activeTab.value].key;
      s[key] = s[key].filter(t => t.status !== 'success');
      s.saveTaskHistory();
      selected.value = new Set();
      menuOpen.value = null;
    }

    function batchDelete() {
      selectedTasks().forEach(task => removeTask(task));
      selected.value = new Set();
    }

    // 分批执行数组任务，避免一次性创建大量 reactive 任务或 IPC 调用导致 UI 卡死
    function runInChunks(items, fn, chunkSize) {
      if (!items || items.length === 0) return;
      let i = 0;
      function next() {
        const slice = items.slice(i, i + chunkSize);
        slice.forEach(fn);
        i += chunkSize;
        if (i < items.length) {
          setTimeout(next, 0);
        }
      }
      next();
    }

    function batchRetry() {
      const tasks = selectedTasks().filter(t => !isRunning(t));
      selected.value = new Set();
      // 批量重试优先使用 retryFailed，仅对确实有失败项的任务重试失败部分；
      // 其余任务（无失败记录等）再由 retryFailed 内部回退到 rerunTask
      runInChunks(tasks, retryFailed, 4);
    }

    function batchCancel() {
      selectedTasks().filter(t => isRunning(t)).forEach(cancelTask);
    }

    function batchCancelVisible() {
      filteredTasks.value.filter(t => isRunning(t)).forEach(cancelTask);
      menuOpen.value = null;
    }

    function closeMenuOnOutside(e) {
      if (menuOpen.value && !e.target.closest('.task-menu')) {
        menuOpen.value = null;
      }
    }

    let timer = null;
    onMounted(() => {
      window.addEventListener('click', closeMenuOnOutside);
      timer = setInterval(() => { nowMs.value = Date.now(); }, 1000);
    });
    onUnmounted(() => {
      window.removeEventListener('click', closeMenuOnOutside);
      if (timer) clearInterval(timer);
    });

    return {
      s,
      expanded,
      activeTab,
      statusFilter,
      search,
      selected,
      menuOpen,
      sortKey,
      nowMs,
      tabConfig,
      statusOptions,
      sortOptions,
      statusCounts,
      filteredTasks,
      runningCount,
      todaySuccess,
      todayFailed,
      totalCount,
      hasRunning,
      hasFailed,
      switchTab,
      clearFilters,
      statusText,
      statusBadgeClass,
      taskTitle,
      taskSubtitle,
      taskIcon,
      taskUrl,
      taskTime,
      taskLatestLog,
      taskDuration,
      formatSize,
      taskOutputPath,
      openOutput,
      isRunning,
      canRetryFailed,
      hasResult,
      toggleLog,
      toggleSelect,
      allVisibleSelected,
      toggleSelectAll,
      selectAllVisible,
      clearSelection,
      selectedTasks,
      removeTask,
      cancelTask,
      rerunTask,
      retryFailed,
      retryAllFailed,
      copyLink,
      copyLogs,
      exportLog,
      clearDoneCurrentTab,
      batchDelete,
      batchRetry,
      batchCancel,
      batchCancelVisible,
    };
  },
  template: `
    <div class="page-header">
      <div class="page-label">Tasks</div>
      <h1>任务中心</h1>
    </div>

    <div class="task-stats-summary">
      <div class="summary-card running">
        <div class="summary-icon" :class="{spinning: runningCount > 0}" v-html="$icons.loader"></div>
        <div class="summary-info">
          <div class="summary-value">{{ runningCount }}</div>
          <div class="summary-label">进行中</div>
        </div>
      </div>
      <div class="summary-card success">
        <div class="summary-icon" v-html="$icons.checkCircle"></div>
        <div class="summary-info">
          <div class="summary-value">{{ todaySuccess }}</div>
          <div class="summary-label">今日成功</div>
        </div>
      </div>
      <div class="summary-card failed">
        <div class="summary-icon" v-html="$icons.xCircle"></div>
        <div class="summary-info">
          <div class="summary-value">{{ todayFailed }}</div>
          <div class="summary-label">今日失败</div>
        </div>
      </div>
      <div class="summary-card total">
        <div class="summary-icon" v-html="$icons.more"></div>
        <div class="summary-info">
          <div class="summary-value">{{ totalCount }}</div>
          <div class="summary-label">累计任务</div>
        </div>
      </div>
    </div>

    <div class="toolbar">
      <div class="sub-tabs" style="padding:0;border:none;flex:1">
        <button v-for="(cfg, key) in tabConfig" :key="key" :class="{active: activeTab===key}" @click="switchTab(key)">
          <span class="tab-icon" v-html="$icons[cfg.icon]"></span>
          <span>{{ cfg.label }}</span>
          <span class="tab-badge">{{ s[cfg.key].length }}</span>
        </button>
      </div>
    </div>

    <div class="task-filters">
      <div class="filter-tabs">
        <button v-for="opt in statusOptions" :key="opt.value" :class="{active: statusFilter===opt.value}" @click="statusFilter=opt.value">
          {{ opt.label }}
          <span class="filter-count">{{ statusCounts[opt.value] }}</span>
        </button>
      </div>
      <div class="search-box task-search">
        <span class="icon" v-html="$icons.search"></span>
        <input v-model="search" placeholder="搜索任务、链接或日志" />
        <button v-if="search" class="search-clear" @click="search=''" v-html="$icons.close"></button>
      </div>
      <div class="dropdown sort-dropdown">
        <select v-model="sortKey" title="排序方式">
          <option v-for="opt in sortOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
      </div>
      <button class="btn btn-icon" title="清除筛选" @click="clearFilters">
        <span v-html="$icons.close"></span>
      </button>
    </div>

    <div class="task-actions-bar">
      <button class="btn" @click="selectAllVisible" :disabled="filteredTasks.length === 0">
        <span v-html="$icons.checkSquare" style="width:14px;height:14px;margin-right:4px"></span>全选
      </button>
      <button class="btn" @click="clearDoneCurrentTab" :disabled="statusCounts.completed === 0">
        <span v-html="$icons.trash2" style="width:14px;height:14px;margin-right:4px"></span>清除已完成
      </button>
      <button class="btn" @click="retryAllFailed" :disabled="!hasFailed">
        <span v-html="$icons.zap" style="width:14px;height:14px;margin-right:4px"></span>重试全部失败
      </button>
      <button class="btn" @click="batchCancelVisible" :disabled="!hasRunning">
        <span v-html="$icons.pause" style="width:14px;height:14px;margin-right:4px"></span>暂停全部
      </button>
    </div>

    <div v-if="selected.size > 0" class="task-batch-bar">
      <button class="btn btn-text" @click="clearSelection">退出多选</button>
      <span class="batch-count">已选 {{ selected.size }} 条</span>
      <button class="btn" @click="batchRetry" :disabled="!selectedTasks().some(t => !isRunning(t))">
        <span v-html="$icons.rotateCw" style="width:14px;height:14px;margin-right:4px"></span>批量重试
      </button>
      <button class="btn" @click="batchCancel" :disabled="!selectedTasks().some(t => isRunning(t))">
        <span v-html="$icons.pause" style="width:14px;height:14px;margin-right:4px"></span>批量取消
      </button>
      <button class="btn btn-danger" @click="batchDelete">
        <span v-html="$icons.trash2" style="width:14px;height:14px;margin-right:4px"></span>删除已选
      </button>
    </div>

    <div class="content">
      <div v-if="filteredTasks.length===0" class="empty-state task-empty">
        <div class="big-icon" v-html="$icons[tabConfig[activeTab].icon]"></div>
        <div class="empty-title">{{ tabConfig[activeTab].empty }}</div>
        <div class="empty-hint">任务会在这里集中展示，可随时查看进度、日志与结果</div>
      </div>
      <div v-else class="task-list">
        <div v-for="task in filteredTasks" :key="task.id" class="task-card" :class="['status-'+task.status, {'selected': selected.has(task.id), 'running-pulse': isRunning(task)}]">
          <div class="task-card-main">
            <label class="task-checkbox" @click.stop>
              <input type="checkbox" :checked="selected.has(task.id)" @change="toggleSelect(task.id)" />
            </label>
            <div class="task-icon-wrap" :class="'icon-'+taskIcon(task)" v-html="$icons[taskIcon(task)]"></div>
            <div class="task-info">
              <div class="task-title-row">
                <span class="task-name" :title="taskTitle(task)">{{ taskTitle(task) }}</span>
                <span class="task-status-badge" :class="statusBadgeClass(task.status)">{{ statusText(task.status) }}</span>
                <span v-if="isRunning(task)" class="task-duration" title="已运行时间">
                  <span class="pulse-dot"></span>{{ taskDuration(task) }}
                </span>
                <span v-else class="task-time" :title="task.createdAt">{{ taskTime(task) }}</span>
              </div>
              <div class="task-subtitle">{{ taskSubtitle(task) }}</div>
              <div class="task-step" v-if="task.step">{{ task.step }}</div>
              <div class="task-progress-row">
                <div class="progress-bar"><div class="progress-fill" :class="{animated: isRunning(task)}" :style="{width: (task.progress||0)+'%'}"></div></div>
                <span class="progress-text">{{ task.progress || 0 }}%</span>
              </div>

              <div class="task-stats-chips">
                <template v-if="task.id.startsWith('task-')">
                  <span class="chip">总数 {{ task.total || 0 }}</span>
                  <span class="chip chip-success">成功 {{ task.success || 0 }}</span>
                  <span class="chip chip-failed">失败 {{ task.failed || 0 }}</span>
                  <span class="chip">跳过 {{ task.skipped || 0 }}</span>
                </template>
                <template v-else-if="task.id.startsWith('sync-')">
                  <template v-if="task.status === 'success' || task.status === 'done' || task.status === 'completed' || task.drained">
                    <span class="chip">已完成</span>
                    <span class="chip chip-success">共 {{ task.added || 0 }} 条</span>
                  </template>
                  <template v-else>
                    <span class="chip">上限 {{ task.total || 0 }}</span>
                    <span class="chip chip-success">已拉取 {{ task.added || 0 }} 条</span>
                  </template>
                </template>
                <template v-else-if="task.id.startsWith('relation-')">
                  <span class="chip">目标 {{ task.total || 0 }}</span>
                  <span class="chip chip-success">成功 {{ task.summary?.success || 0 }}</span>
                  <span class="chip chip-failed">失败 {{ task.summary?.failed || 0 }}</span>
                  <span class="chip">跳过 {{ task.summary?.skipped || 0 }}</span>
                </template>
                <template v-else-if="task.id.startsWith('dedup-')">
                  <span class="chip">扫描 {{ task.scanned || 0 }} / {{ task.total || 0 }}</span>
                  <span class="chip chip-failed">重复组 {{ task.duplicateGroups || 0 }}</span>
                  <span class="chip chip-success">删除 {{ task.deletedFiles || 0 }}</span>
                  <span class="chip">释放 {{ formatSize(task.freedBytes || 0) }}</span>
                </template>
              </div>

              <div v-if="!expanded[task.id] && taskLatestLog(task)" class="task-latest-log" :title="taskLatestLog(task)">
                <span v-html="$icons.fileText"></span>{{ taskLatestLog(task) }}
              </div>

              <div v-if="hasResult(task)" class="task-result-area">
                <div v-if="task.id.startsWith('report-') && task.result" class="result-files">
                  <div v-for="f in task.result" :key="f" class="result-file" @click="window.electronAPI.openFolder(f)">
                    <span v-html="$icons.fileText"></span>{{ f }}
                  </div>
                </div>
                <div v-if="task.id.startsWith('cloud-restore-') && task.token" class="result-token">
                  恢复 Token：<code>{{ task.token }}</code>
                </div>
              </div>
            </div>

            <div class="task-card-actions">
              <button v-if="isRunning(task)" class="btn btn-icon" title="取消" @click.stop="cancelTask(task)" v-html="$icons.pause"></button>
              <button v-if="taskOutputPath(task) && task.status==='success'" class="btn btn-icon" title="打开输出目录" @click.stop="openOutput(task)" v-html="$icons.folder"></button>
              <button class="btn btn-icon" :class="{active: expanded[task.id]}" title="查看日志" @click.stop="toggleLog(task.id)" v-html="$icons.fileText"></button>
              <div class="task-menu dropdown" @click.stop>
                <button class="btn btn-icon" title="更多" :class="{active: menuOpen===task.id}" @click="menuOpen = menuOpen===task.id ? null : task.id" v-html="$icons.more"></button>
                <div v-if="menuOpen===task.id" class="task-menu-dropdown">
                  <div class="task-menu-item" @click="rerunTask(task)">
                    <span class="menu-icon" v-html="$icons.rotateCw"></span>再跑一次
                  </div>
                  <div v-if="canRetryFailed(task)" class="task-menu-item" @click="retryFailed(task)">
                    <span class="menu-icon" v-html="$icons.zap"></span>重试失败项
                  </div>
                  <div v-if="taskUrl(task)" class="task-menu-item" @click="copyLink(task)">
                    <span class="menu-icon" v-html="$icons.copy"></span>复制链接
                  </div>
                  <div class="task-menu-item" @click="copyLogs(task)">
                    <span class="menu-icon" v-html="$icons.copy"></span>复制日志
                  </div>
                  <div class="task-menu-item" @click="exportLog(task)">
                    <span class="menu-icon" v-html="$icons.fileDown"></span>导出日志
                  </div>
                  <div class="task-menu-item delete" @click="removeTask(task)">
                    <span class="menu-icon" v-html="$icons.trash2"></span>删除记录
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div v-if="expanded[task.id]" class="task-logs">
            <div v-if="task.logs && task.logs.length" v-for="(log, idx) in task.logs" :key="idx" class="task-log-line">{{ log }}</div>
            <div v-else class="task-log-empty">暂无日志</div>
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

    async function startDedup() {
      if (!s.settings.outputPath) {
        s.showToast('请先设置下载目录');
        return;
      }
      s.showToast('开始去重', 2000);
      s.currentPage = 'tasks';
      await nextTick();
      await s.startDedupTask(s.settings.outputPath);
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

    async function exportReport() {
      const formats = [];
      if (reportFormats.value.excel) formats.push('excel');
      if (reportFormats.value.html) formats.push('html');
      if (formats.length === 0) {
        s.showToast('请至少选择一种导出格式');
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
      s, loading, refresh, startDedup, search, sortKey, authorFilter, dateFilter,
      authors, filteredArchive, previewVideo, openVideo, closeVideo: closePreview,
      showReportModal, reportDateFrom, reportDateTo,
      reportGroupBy, reportFormats, exportReport,
    };
  },
  template: `
    <div class="page-header">
      <div class="page-label">Archive</div>
      <h1>作品档案</h1>
      <div class="sync-bar" style="margin-left:auto;width:auto;gap:8px;justify-content:flex-start;background:transparent;border:none;padding:0">
        <button class="btn" @click="refresh" :disabled="loading"><span v-html="$icons.refresh"></span> 刷新</button>
        <button class="btn" @click="startDedup"><span v-html="$icons.copy"></span> 作品去重</button>
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

    async function logout() {
      await s.logout();
    }

    function runBackup() {
      s.backupCloud();
      s.currentPage = 'tasks';
    }

    function runRestore() {
      if (!restoreToken.value.trim()) {
        s.showToast('请输入恢复 Token');
        return;
      }
      s.restoreCloud(restoreToken.value.trim());
      restoreToken.value = '';
      s.currentPage = 'tasks';
    }

    return {
      s, chooseFolder, logout, showToken, restoreToken, runBackup, runRestore,
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
        <h3>自动同步</h3>
        <p class="settings-desc">打开软件后自动同步勾选的页面，仅对已登录账号生效。</p>
        <div class="setting-checks">
          <label><input type="checkbox" v-model="s.settings.autoSync.following" /> 关注</label>
          <label><input type="checkbox" v-model="s.settings.autoSync.favorites" /> 我的收藏</label>
          <label><input type="checkbox" v-model="s.settings.autoSync.newReleases" /> 新发布</label>
        </div>
        <p class="settings-desc" style="margin-top: 12px; color: var(--danger);">重启软件后生效</p>
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
          <label>单链接最大运行时间（分钟）</label><input type="number" v-model.number="s.settings.queueUrlMaxRuntimeMinutes" min="1" max="180" />
        </div>
        <p class="settings-desc">单个链接（如一个博主主页）的下载任务超过该时间会被强制终止。低速拉取规避风控时可适当调大。</p>
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
          <label><input type="checkbox" v-model="s.settings.downloadPinned" /> 包含置顶视频</label>
          <label><input type="checkbox" v-model="s.settings.database" /> SQLite 去重</label>
          <label><input type="checkbox" v-model="s.settings.folderstyle" /> 文件夹风格归档</label>
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
        <p class="settings-desc">当接口被限制时，用浏览器滚动作者主页兜底采集（仅用于批量关注/取关等关系操作，博主作品列表拉取已改为低速重试，不再使用浏览器兜底）。开启「无头模式」后窗口不可见，遇到验证码将无法人工验证。</p>
        <div class="setting-row setting-row--two-col">
          <label class="setting-check">
            <input type="checkbox" v-model="s.settings.browserFallback.enabled" />
            <span>接口受限时自动打开浏览器采集</span>
          </label>
          <label class="setting-check" :class="{ disabled: !s.settings.browserFallback.enabled }">
            <input type="checkbox" v-model="s.settings.browserFallback.headless" :disabled="!s.settings.browserFallback.enabled" />
            <span>无头模式（不推荐）</span>
          </label>
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
      </div>
      <div class="settings-card">
        <h3>云同步</h3>
        <div class="setting-row" style="align-items:flex-start;">
          <label></label>
          <div class="hint-text">点击“立即备份”会将当前设置（settings.json）和数据库（dy_downloader.db）加密上传到云端，恢复时凭 Token 下载解密。</div>
        </div>
        <div class="setting-row">
          <label>启用云同步</label>
          <label class="setting-checks"><input type="checkbox" v-model="s.settings.cloudSync.enabled" /> 启用</label>
        </div>
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
          <button class="btn btn-primary" @click="runBackup" :disabled="!s.settings.cloudSync.enabled || !s.settings.cloudSync.provider">立即备份</button>
          <input v-model="restoreToken" placeholder="输入恢复 Token" style="flex:1" :disabled="!s.settings.cloudSync.enabled || !s.settings.cloudSync.provider" />
          <button class="btn" @click="runRestore" :disabled="!s.settings.cloudSync.enabled || !s.settings.cloudSync.provider">从 Token 恢复</button>
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
      { key: 'favorites', label: '我的收藏', icon: icons.bookmark },
      { key: 'newReleases', label: '新发布', icon: icons.refresh },
      { section: '本地' },
      { key: 'downloads', label: '下载', icon: icons.download },
      { key: 'batch', label: '批量下载', icon: icons.layers },
      { key: 'tasks', label: '任务中心', icon: icons.more },
      { key: 'archive', label: '作品档案', icon: icons.folder },
      { key: 'settings', label: '设置', icon: icons.settings },
    ];

    store.loadSettings();
    store.recoverStalledSyncs();
    const recoverInterval = setInterval(store.recoverStalledSyncs, 30_000);

    // 设置项修改后自动保存（防抖 300ms）
    let settingsSaveTimer = null;
    watch(() => store.settings, () => {
      if (!store.initialized) return;
      if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
      settingsSaveTimer = setTimeout(() => {
        store.saveSettings();
      }, 300);
    }, { deep: true });

    // 主题变更即时生效（单独监听避免 deep watch 中 newVal/oldVal 引用相同导致比较失效）
    watch(() => store.settings.theme, (theme) => {
      store.applyTheme(theme);
    });

    const cleanupFns = [];
    if (window.electronAPI) {
      cleanupFns.push(window.electronAPI.onDownloadProgress(store.onProgress));
      cleanupFns.push(window.electronAPI.onDownloadLog(store.onLog));
      cleanupFns.push(window.electronAPI.onDownloadFinished(store.onFinished));

      cleanupFns.push(window.electronAPI.onSyncProgress(store.onSyncProgress));
      cleanupFns.push(window.electronAPI.onSyncLog(store.onSyncLog));
      cleanupFns.push(window.electronAPI.onSyncFinished(store.onSyncFinished));

      cleanupFns.push(window.electronAPI.onRelationProgress(store.onRelationProgress));
      cleanupFns.push(window.electronAPI.onRelationLog(store.onRelationLog));
      cleanupFns.push(window.electronAPI.onRelationFinished(store.onRelationFinished));

      cleanupFns.push(window.electronAPI.onReportProgress(store.onReportProgress));
      cleanupFns.push(window.electronAPI.onReportLog(store.onReportLog));
      cleanupFns.push(window.electronAPI.onReportFinished(store.onReportFinished));

      cleanupFns.push(window.electronAPI.onCloudProgress(store.onCloudProgress));
      cleanupFns.push(window.electronAPI.onCloudLog(store.onCloudLog));
      cleanupFns.push(window.electronAPI.onCloudFinished(store.onCloudFinished));

      cleanupFns.push(window.electronAPI.onDedupProgress(store.onDedupProgress));
      cleanupFns.push(window.electronAPI.onDedupLog(store.onDedupLog));
      cleanupFns.push(window.electronAPI.onDedupFinished(store.onDedupFinished));

      cleanupFns.push(window.electronAPI.onUserWorksProgress(store.onUserWorksProgress));
      cleanupFns.push(window.electronAPI.onUserWorksLog(store.onUserWorksLog));
      cleanupFns.push(window.electronAPI.onUserWorksFinished(store.onUserWorksFinished));

      cleanupFns.push(window.electronAPI.onNewReleasesProgress(store.onNewReleasesProgress));
      cleanupFns.push(window.electronAPI.onNewReleasesLog(store.onNewReleasesLog));
      cleanupFns.push(window.electronAPI.onNewReleasesFinished(store.onNewReleasesFinished));

      cleanupFns.push(window.electronAPI.onShortcutTriggered((payload) => {
        if (payload.action === 'pasteDownload' && payload.url) {
          const u = payload.url.trim();
          // 抖音搜索话题链接直接触发话题同步
          if (/\/search\/(?:%23|#)[^/?&]+/.test(u) || /[?&]keyword=(?:%23|#)[^&]+/.test(u)) {
            store.startSync('favorites', 'topics', u);
            store.showToast('已开始同步话题');
          } else {
            store.currentPage = 'downloads';
            setTimeout(() => {
              store.startTask(u, '快捷键粘贴下载');
            }, 100);
          }
        } else if (payload.action === 'pauseAll') {
          store.tasks.filter(t => t.status === 'running').forEach(t => store.cancelTask(t.id));
          store.syncs.filter(t => t.status === 'running').forEach(t => store.cancelSync(t.id));
          store.relationTasks.filter(t => t.status === 'running').forEach(t => store.cancelRelationTask(t.id));
          store.reportTasks.filter(t => t.status === 'running').forEach(t => store.cancelReport(t.id));
          store.cloudTasks.filter(t => t.status === 'running').forEach(t => store.cancelCloud(t.id));
          store.dedupTasks.filter(t => t.status === 'running').forEach(t => store.cancelDedupTask(t.id));
          store.userWorks.filter(t => t.status === 'running').forEach(t => store.cancelUserWorks(t.id));
          if (store.newReleases.status === 'running') store.cancelNewReleases();
        }
      }));
    }

    // 启动后若已登录，自动同步一次收藏、喜欢（新发布需手动触发，避免首次进入页面自动刷新）
    let autoSyncStarted = false;
    watch([() => store.initialized, () => store.user.isLoggedIn], ([initialized, isLoggedIn]) => {
      if (initialized && isLoggedIn && !autoSyncStarted) {
        autoSyncStarted = true;
        setTimeout(() => {
          store.startSync('favorites');
          store.startSync('likes');
        }, 600);
      }
    });

    async function minimize() { if (window.electronAPI) await window.electronAPI.minimize(); }
    async function maximize() {
      if (window.electronAPI) {
        await window.electronAPI.maximize();
        isMaximized.value = await window.electronAPI.isMaximized();
      }
    }
    async function closeWin() { if (window.electronAPI) await window.electronAPI.close(); }

    // 记录每个页面的滚动位置，切换回来后恢复
    const mainRef = ref(null);
    const pageScrollTops = ref({});
    function findScrollable(el) {
      if (!el) return null;
      if (el.scrollHeight > el.clientHeight) return el;
      for (const child of el.children) {
        const found = findScrollable(child);
        if (found) return found;
      }
      return null;
    }
    watch(() => store.currentPage, (newPage, oldPage) => {
      if (mainRef.value && oldPage) {
        const scroller = findScrollable(mainRef.value);
        if (scroller) pageScrollTops.value[oldPage] = scroller.scrollTop;
      }
      nextTick(() => {
        if (mainRef.value && newPage && pageScrollTops.value[newPage] != null) {
          const scroller = findScrollable(mainRef.value);
          if (scroller) scroller.scrollTop = pageScrollTops.value[newPage];
        }
      });
    });

    const showRestartConfirm = ref(false);
    function restartApp() { showRestartConfirm.value = true; }
    async function confirmRestart() {
      if (!window.electronAPI) return;
      showRestartConfirm.value = false;
      await window.electronAPI.restartApp();
    }

    onUnmounted(() => {
      clearInterval(recoverInterval);
      if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
      cleanupFns.forEach((fn) => { if (typeof fn === 'function') fn(); });
    });

    return { store, menu, isMaximized, minimize, maximize, closeWin, restartApp, confirmRestart, showRestartConfirm, icons, mainRef };
  },
  template: `
    <div class="window-frame">
      <div class="title-bar">
        <div class="brand">
          <div class="logo">
            <img src="./icon.png" alt="DRaccoon" />
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
          <div class="sidebar-footer">
            <button class="btn-restart" @click="restartApp" title="重启软件">
              <span class="icon" v-html="icons.rotateCw"></span>
              <span>重启软件</span>
            </button>
          </div>
        </aside>
        <main class="main" ref="mainRef">
          <keep-alive>
            <component :is="'Page' + (store.currentPage.charAt(0).toUpperCase() + store.currentPage.slice(1))"></component>
          </keep-alive>
        </main>
      </div>
      <div v-else class="login-page"><div class="login-card">初始化中...</div></div>
      <div class="copy-toast" v-if="store.toast.show">{{ store.toast.message }}</div>

      <div v-if="showRestartConfirm" class="video-modal confirm-modal" @click.self="showRestartConfirm = false">
        <div class="video-modal-content confirm-modal-content">
          <div class="confirm-modal-header">
            <span class="confirm-modal-icon" v-html="icons.alertCircle"></span>
            <span class="confirm-modal-title">重启软件</span>
          </div>
          <p class="confirm-modal-text">修改代码后需要重启才能生效，确定现在重启吗？</p>
          <div class="modal-actions">
            <button class="btn" @click="showRestartConfirm = false">取消</button>
            <button class="btn btn-primary" @click="confirmRestart">立即重启</button>
          </div>
        </div>
      </div>
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
