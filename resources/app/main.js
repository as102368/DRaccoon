const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Tray,
  Menu,
  globalShortcut,
  clipboard,
  nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, exec, execSync } = require('child_process');
const http = require('http');
const crypto = require('crypto');

// 防止无控制台启动时 console.log 写入断开管道抛出 EPIPE 崩溃主进程
['log', 'error', 'warn', 'info', 'debug'].forEach((method) => {
  const original = console[method];
  if (typeof original !== 'function') return;
  console[method] = (...args) => {
    try {
      original.apply(console, args);
    } catch (e) {
      // ignore broken pipe / closed stream errors
    }
  };
});
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

// 统一应用名称为 DRaccoon，避免在任务栏 / 任务管理器 / userData 目录中显示为 electron
app.setName('DRaccoon');
if (process.platform === 'win32') {
  // 让 Windows 任务栏按 DRaccoon 分组并显示正确图标
  app.setAppUserModelId('com.draccoon.app');
}

// 提升 Chromium 渲染响应，减少后台节流导致的卡顿
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
// 禁用一些可能导致卡顿或多余后台任务的 Chromium 功能
app.commandLine.appendSwitch('disable-features', 'CalculateWindowOcclusion,AutoFreezeBackgroundTab,PaintHolding,Translate,InterestFeedContentSuggestions');
// 将 GPU 进程合并进主进程，减少一个常驻进程（从 4 个降到 3 个）
app.commandLine.appendSwitch('in-process-gpu');
// 禁止 Douyin 网页在后台自动播放视频/音频，避免同步时突然出声+媒体控制通知
app.commandLine.appendSwitch('autoplay-policy', 'user-gesture-required');

const userDataPath = app.getPath('userData');
app.setPath('logs', path.join(userDataPath, 'logs'));

const settingsPath = path.join(userDataPath, 'settings.json');
const jobsPath = path.join(userDataPath, 'jobs');
const cookiesDir = path.join(userDataPath, 'cookies');
const cookieFilePath = path.join(cookiesDir, 'douyin.cookies.json');

function ensureDirs() {
  [userDataPath, jobsPath, cookiesDir].forEach((p) => {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  });
}
ensureDirs();

// 路径沙箱：限制渲染进程传入的路径只能位于允许的根目录内
function resolveAllowedPath(inputPath, allowedRoots) {
  if (!inputPath || typeof inputPath !== 'string') return null;
  try {
    const resolved = path.resolve(inputPath);
    const roots = (Array.isArray(allowedRoots) ? allowedRoots : [allowedRoots]).filter(Boolean);
    if (roots.length === 0) return null;
    for (const root of roots) {
      const rootResolved = path.resolve(root);
      const rel = path.relative(rootResolved, resolved);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        return resolved;
      }
    }
  } catch (e) {
    console.error('resolveAllowedPath error', e);
  }
  return null;
}

function getOutputPath() {
  const settings = getSettingsSync();
  return settings.outputPath || defaultSettings.outputPath || userDataPath;
}

// 任务 ID 白名单：仅允许字母、数字、下划线、连字符，防止路径穿越
function isValidTaskId(taskId) {
  if (!taskId || typeof taskId !== 'string') return false;
  return /^[A-Za-z0-9_-]{1,64}$/.test(taskId);
}

function writeUnifiedCookies(cookieString) {
  try {
    const map = {};
    const attrKeys = new Set(['path', 'domain', 'expires', 'max-age', 'secure', 'httponly', 'samesite']);
    for (const part of (cookieString || '').split(';')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key && !attrKeys.has(key.toLowerCase())) map[key] = value;
    }
    if (Object.keys(map).length === 0) return;
    fs.writeFileSync(cookieFilePath, JSON.stringify(map, null, 2), 'utf-8');
  } catch (e) {
    console.error('写入统一 cookie 文件失败', e);
  }
}

// ========== Python 解释器自动发现 ==========
// Windows 上可能存在 Microsoft Store 的 python.exe 占位 stub，直接调用会返回 9009。
// 这里优先使用 py -3，再回退到 PATH 命令和常见绝对路径，并把可用的解释器缓存下来。
let cachedDispatcherPath = null;

function findBundledDispatcher() {
  if (cachedDispatcherPath) {
    try {
      if (fs.existsSync(cachedDispatcherPath)) return cachedDispatcherPath;
    } catch (e) {}
    cachedDispatcherPath = null;
  }

  const candidates = [];
  if (app.isPackaged) {
    // 打包后 dispatcher.exe 通常与 DRaccoon.exe 同级或在 dispatcher/ 子目录中
    const appDir = path.dirname(process.resourcesPath);
    candidates.push(
      path.join(appDir, 'dispatcher.exe'),
      path.join(appDir, 'dispatcher', 'dispatcher.exe'),
      path.join(process.resourcesPath, 'dispatcher.exe'),
      path.join(process.resourcesPath, 'dispatcher', 'dispatcher.exe')
    );
  }

  // 开发环境也允许通过构建产物测试 dispatcher
  candidates.push(
    path.join(__dirname, '..', 'scripts', 'assets', 'dist', 'dispatcher', 'dispatcher.exe'),
    path.join(__dirname, '..', '..', 'scripts', 'assets', 'dist', 'dispatcher', 'dispatcher.exe')
  );

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        cachedDispatcherPath = p;
        console.log('使用打包调度器:', p);
        return p;
      }
    } catch (e) {}
  }
  return null;
}

function isDispatcherMode(pythonPath) {
  return !!pythonPath && path.basename(pythonPath).toLowerCase() === 'dispatcher.exe';
}

function resolvePythonLauncher(executable) {
  if (!executable || typeof executable !== 'string') return null;
  const lower = executable.toLowerCase();
  if (!lower.includes('pythoncore-')) return null;
  const coreDir = path.dirname(executable);
  const pythonRoot = path.dirname(coreDir);
  const launcher = path.join(pythonRoot, 'bin', 'python.exe');
  try {
    if (fs.existsSync(launcher)) return launcher;
  } catch (e) {}
  return null;
}

function resolvePythonSpawnArgs(pythonPath, scriptPath, extraArgs = []) {
  if (isDispatcherMode(pythonPath)) {
    const scriptName = path.basename(scriptPath, path.extname(scriptPath));
    return { cmd: pythonPath, args: [scriptName, ...extraArgs] };
  }
  return { cmd: pythonPath, args: [scriptPath, ...extraArgs] };
}

async function testPythonExecutable(cmd, args = ['-c', 'import sys; print(sys.executable)']) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cmd, args, {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
    } catch (e) {
      return resolve(null);
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        process.kill(proc.pid, 'SIGTERM');
      } catch (e) {
        // ignore
      }
      resolve(null);
    }, 5000);

    proc.stdout.on('data', (data) => {
      stdout += data.toString('utf-8');
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString('utf-8');
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        const executable = lines[0] || cmd;
        resolve(executable);
      } else {
        resolve(null);
      }
    });
  });
}

async function findPythonExecutable() {
  // 打包应用优先使用同目录的 dispatcher.exe，避免依赖系统 Python
  const dispatcher = findBundledDispatcher();
  if (dispatcher) return dispatcher;

  if (cachedPythonPath) {
    const stillWorks = await testPythonExecutable(cachedPythonPath);
    if (stillWorks) return cachedPythonPath;
    cachedPythonPath = null;
  }

  const settings = getSettingsSync();
  const configuredPath = settings && settings.pythonPath;

  const home = require('os').homedir();
  const candidates = [];

  if (configuredPath) {
    candidates.push({ cmd: configuredPath, args: ['-c', 'import sys; print(sys.executable)'] });
  }

  // Windows py 启动器通常能正确定位已安装的 Python，优于 PATH 中可能存在的 Store stub
  candidates.push({ cmd: 'py', args: ['-3', '-c', 'import sys; print(sys.executable)'] });
  candidates.push({ cmd: 'python', args: ['-c', 'import sys; print(sys.executable)'] });
  candidates.push({ cmd: 'python3', args: ['-c', 'import sys; print(sys.executable)'] });
  candidates.push({ cmd: 'py', args: ['-c', 'import sys; print(sys.executable)'] });

  // 常见绝对路径（Windows）
  const absolutePaths = [
    path.join(home, 'AppData', 'Local', 'Python', 'bin', 'python.exe'),
    path.join(home, 'AppData', 'Local', 'Python', 'pythoncore-3.14-64', 'python.exe'),
    path.join(home, 'python-sdk', 'python3.13.2', 'python.exe'),
    path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python314', 'python.exe'),
    path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'),
    path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
    path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'),
    path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'python.exe'),
    'C:\\Program Files\\Python314\\python.exe',
    'C:\\Program Files\\Python313\\python.exe',
    'C:\\Program Files\\Python312\\python.exe',
    'C:\\Program Files\\Python311\\python.exe',
    'C:\\Program Files\\Python310\\python.exe',
    'C:\\Program Files (x86)\\Python314\\python.exe',
    'C:\\Program Files (x86)\\Python313\\python.exe',
    'C:\\Program Files (x86)\\Python312\\python.exe',
    'C:\\Program Files (x86)\\Python311\\python.exe',
    'C:\\Program Files (x86)\\Python310\\python.exe',
  ];

  for (const p of absolutePaths) {
    candidates.push({ cmd: p, args: ['-c', 'import sys; print(sys.executable)'] });
  }

  for (const { cmd, args } of candidates) {
    const executable = await testPythonExecutable(cmd, args);
    if (executable) {
      // 某些安装器（如 ActiveState / pythoncore）将真实解释器放在 pythoncore-* 目录，
      // 直接 spawn 该路径在打包应用中可能出现 ENOENT；优先使用外层 bin\python.exe 启动器。
      const launcher = resolvePythonLauncher(executable);
      const pythonToUse = (launcher && (await testPythonExecutable(launcher, ['-c', 'import sys; print(sys.executable); import aiohttp']))) ? launcher : executable;
      // 再确认一次该解释器能导入后端依赖 aiohttp
      const hasDeps = await testPythonExecutable(pythonToUse, ['-c', 'import sys; print(sys.executable); import aiohttp']);
      if (hasDeps) {
        cachedPythonPath = pythonToUse;
        console.log('使用 Python:', pythonToUse);
        return pythonToUse;
      }
    }
  }

  // 退而求其次：返回一个能跑通 Python 自身测试的解释器，让脚本自己报依赖错误
  for (const { cmd, args } of candidates) {
    const executable = await testPythonExecutable(cmd, args);
    if (executable) {
      cachedPythonPath = executable;
      console.warn('Python 解释器缺少 aiohttp 等依赖:', executable);
      return executable;
    }
  }

  return null;
}

const defaultSettings = {
  outputPath: path.join(require('os').homedir(), 'Downloads', 'DouyinDownloaded'),
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
  videoQuality: 'highest',
  queueUrlMaxRuntimeMinutes: 30,
  syncLimits: {
    favorites: 1000,
    collections: 200,
    likes: 1000,
    favoritesMusic: 1000,
    following: 2000,
    topics: 200,
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

function deepMerge(target, source) {
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
        target[key] = {};
      }
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

let mainWindow;
let tray = null;
let loginWindow = null;
const activeDownloads = new Map();
const downloadQueues = new Map(); // rootTaskId -> DownloadQueue
const activeSyncs = new Map();
const activeUserWorks = new Map();
let userWorksLock = null; // 作者作品任务全局锁，防止多作者并发触发风控
const activeNewReleases = new Map();
const activeBridges = new Map();
// Electron 自带 Chromium 采集桥接：仅在桌面端主程序运行时启动
let bridgePort = 0;
let bridgeToken = '';
let bridgeServer = null;
let bridgeCollectLock = null; // 防止采集窗口并发打开
let bridgeDetailLock = null; // 防止单作品详情窗口并发打开
let bridgeFetchLock = null; // 防止通用页面通道并发打开

// 所有会跑后端业务（可能请求抖音 API）的子进程都要带上桥接变量，
// 否则后端 page_bridge 不可用 → 直连被 Argus 403（同步任务曾因此全空）。
function bridgeEnvVars() {
  return {
    DOUZY_BRIDGE_PORT: bridgePort ? String(bridgePort) : '',
    DOUZY_BRIDGE_TOKEN: bridgeToken,
  };
}

// 主进程日志：Electron 侧的桥接行为此前完全不可见（GUI 控制台无法留存），
// 失败排查全靠猜。写 logs/main.log 供事后定位。
function writeMainLog(line) {
  try {
    const dir = path.join(userDataPath, 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'main.log'),
      `[${new Date().toISOString()}] ${line}\n`,
      'utf-8'
    );
  } catch (e) {}
}
// 启动期崩溃排查：把未捕获异常/未处理 Promise 拒绝写入 main.log（GUI 控制台不留痕迹）。
process.on('uncaughtException', (err) => {
  try { writeMainLog(`[fatal] uncaughtException: ${err && err.stack ? err.stack : err}`); } catch (e) {}
  console.error('[fatal] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  try { writeMainLog(`[fatal] unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`); } catch (e) {}
  console.error('[fatal] unhandledRejection:', reason);
});

const trackedChildProcesses = new Set();
let cachedPythonPath = null;

// ========== 敏感信息脱敏（JS 侧） ==========
const SENSITIVE_COOKIE_NAMES = new Set([
  'sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'uid_tt', 'uid_tt_ss',
  'passport_auth_status', 'passport_auth_status_ss', 'passport_assist_user',
  'passport_csrf_token', 'ttwid', 'msToken', 'xg_player_user_id', 'odin_tt',
  'd_ticket', 'csrftoken',
]);

function maskPhone(text) {
  return text.replace(/1[3-9]\d{9}/g, (m) => m.slice(0, 3) + '****' + m.slice(-4));
}

function maskCookies(text) {
  return text.replace(/([a-zA-Z0-9_-]+)(=)([^;\s]+)/g, (match, name, sep, value) => {
    if (SENSITIVE_COOKIE_NAMES.has(name.toLowerCase()) || value.length >= 16) {
      return `${name}${sep}***`;
    }
    return match;
  });
}

function maskAuthorization(text) {
  return text
    .replace(/(authorization\s*:\s*)([^\s]+)/gi, '$1***')
    .replace(/(bearer\s+)([^\s]+)/gi, '$1***');
}

function maskKeyValues(text) {
  return text.replace(/([a-zA-Z0-9_-]+)(=)([^\s&;]+)/g, (match, name, sep, value) => {
    const key = name.toLowerCase().replace(/[_-]/g, '');
    if (['accesskeyid', 'accesskeysecret', 'secretid', 'secretkey', 'apikey', 'api_key'].includes(key)) {
      return `${name}${sep}***`;
    }
    return match;
  });
}

function redactText(text) {
  if (typeof text !== 'string') text = String(text);
  text = maskPhone(text);
  text = maskCookies(text);
  text = maskAuthorization(text);
  text = maskKeyValues(text);
  return text;
}

function redactObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = String(k).toLowerCase();
    if (['cookie', 'cookies', 'authorization', 'api_key', 'apikey', 'api-key',
         'accesskey', 'access_key', 'accesskeyid', 'access_key_id',
         'accesskeysecret', 'access_key_secret', 'secretkey', 'secret_key',
         'secret_id', 'secretid', 'token', 'sessionid', 'password', 'passwd', 'pwd'].includes(key)) {
      result[k] = v ? `${String(v).slice(0, 4)}***${String(v).slice(-4)}` : '';
    } else if (typeof v === 'object') {
      result[k] = redactObject(v);
    } else if (typeof v === 'string') {
      result[k] = redactText(v);
    } else {
      result[k] = v;
    }
  }
  return result;
}

// ========== 窗口与托盘 ==========
function getTrayIconPath() {
  const iconPng = path.join(__dirname, 'renderer', 'icon.png');
  if (fs.existsSync(iconPng)) return iconPng;
  return null;
}

function getWindowIconPath() {
  const iconPng = path.join(__dirname, 'renderer', 'icon.png');
  if (fs.existsSync(iconPng)) return iconPng;
  return null;
}

function createTray() {
  if (tray) return;
  const iconPath = getTrayIconPath();
  let icon = null;
  if (iconPath && fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
    if (process.platform === 'darwin') icon = icon.resize({ width: 16, height: 16 });
  }
  tray = new Tray(icon || nativeImage.createEmpty());
  tray.setToolTip('DRaccoon');
  updateTrayMenu();
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    }
  });
}

function updateTrayMenu() {
  if (!tray) return;
  const template = [
    {
      label: mainWindow && mainWindow.isVisible() ? '隐藏主窗口' : '显示主窗口',
      click: () => toggleMainWindow(),
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function toggleMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
  updateTrayMenu();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1000,
    minHeight: 640,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0b0d14',
    icon: getWindowIconPath() || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('close', () => {
    if (tray) {
      updateTrayMenu();
    }
  });

  mainWindow.on('show', () => {
    updateTrayMenu();
  });

  mainWindow.on('hide', () => {
    updateTrayMenu();
  });
}

// ========== 主题 ==========
function getSettingsSync() {
  let settings = structuredClone(defaultSettings);
  try {
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf-8').replace(/^\uFEFF/, '');
      const saved = JSON.parse(raw);
      settings = deepMerge(settings, saved);
    }
  } catch (e) {
    console.error('读取设置失败', e);
  }
  return settings;
}

function saveSettingsSync(settings) {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (e) {
    console.error('保存设置失败', e);
  }
}

// ========== 全局快捷键 ==========
function registerGlobalShortcuts() {
  const settings = getSettingsSync();
  if (!settings.shortcuts || !settings.shortcuts.enabled) return;
  const { pasteDownload, toggleWindow, pauseAll } = settings.shortcuts;

  function register(name, accelerator, handler) {
    if (!accelerator) return;
    try {
      globalShortcut.register(accelerator, handler);
    } catch (e) {
      console.error(`注册快捷键失败 ${name}: ${accelerator}`, e);
    }
  }

  register('pasteDownload', pasteDownload, () => {
    const text = clipboard.readText();
    if (text && /douyin\.com|v\.douyin\.com|iesdouyin\.com/.test(text)) {
      sendToRenderer('shortcut:triggered', { action: 'pasteDownload', url: text });
    } else {
      sendToRenderer('shortcut:triggered', { action: 'pasteDownload', url: '' });
    }
  });

  register('toggleWindow', toggleWindow, () => {
    toggleMainWindow();
  });

  register('pauseAll', pauseAll, () => {
    sendToRenderer('shortcut:triggered', { action: 'pauseAll' });
  });
}

function unregisterGlobalShortcuts() {
  globalShortcut.unregisterAll();
}

function migrateCookiesToUnifiedLocation() {
  try {
    if (fs.existsSync(cookieFilePath)) return;
    const settings = getSettingsSync();
    const cookieString = settings && settings.cookieString;
    if (typeof cookieString === 'string' && cookieString.length > 10 && !cookieString.includes('***')) {
      writeUnifiedCookies(cookieString);
    }
  } catch (e) {
    console.error('迁移 cookie 到统一位置失败', e);
  }
}

// ========== 应用生命周期 ==========
app.whenReady().then(() => {
  migrateCookiesToUnifiedLocation();
  cleanupSyncCacheByRetention();
  // 必须在创建窗口/任务之前启动：后端 Python 子进程依赖 DOUZY_BRIDGE_PORT/TOKEN，
  // 未启动时这些变量为空 → 后端直连抖音被 Argus 403（曾导致全部功能不可用）。
  // 关键：此处任何异常都不得阻断后续 createWindow/createTray，否则主程序会直接退出。
  try {
    startBridgeServer();
  } catch (e) {
    try { writeMainLog(`[fatal] startBridgeServer 抛错: ${e && e.stack ? e.stack : e}`); } catch (e2) {}
    console.error('[bridge] startBridgeServer failed:', e);
  }
  createWindow();
  createTray();
  registerGlobalShortcuts();

  if (process.platform === 'darwin' && app.dock && app.dock.setIcon) {
    const dockIcon = path.join(__dirname, 'renderer', 'icon.png');
    if (fs.existsSync(dockIcon)) app.dock.setIcon(dockIcon);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else if (mainWindow && !mainWindow.isVisible()) {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  cleanupAllChildProcesses();
  // 关闭页面通道常驻隐藏窗口与桥接服务，避免残留进程
  try {
    if (bridgeFetchWindow && !bridgeFetchWindow.isDestroyed()) bridgeFetchWindow.destroy();
  } catch (e) {}
  bridgeFetchWindow = null;
  bridgeFetchReady = false;
  try {
    if (bridgeNavWindow && !bridgeNavWindow.isDestroyed()) bridgeNavWindow.destroy();
  } catch (e) {}
  bridgeNavWindow = null;
  try { if (bridgeServer) bridgeServer.close(); } catch (e) {}
});

app.on('will-quit', () => {
  unregisterGlobalShortcuts();
  cleanupAllChildProcesses();
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

// ========== IPC：窗口控制 ==========
ipcMain.handle('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.handle('window-close', () => {
  app.quit();
});

ipcMain.handle('window-is-maximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});

ipcMain.handle('app:restart', () => {
  app.relaunch();
  app.quit();
});

// ========== IPC：设置 ==========
ipcMain.handle('settings:get', () => {
  let settings = structuredClone(defaultSettings);
  try {
    if (fs.existsSync(settingsPath)) {
      const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      settings = deepMerge(settings, saved);
    }
  } catch (e) {
    console.error('读取设置失败', e);
  }
  if (!settings.outputPath) {
    settings.outputPath = defaultSettings.outputPath;
  }
  if (!settings.syncLimits) {
    settings.syncLimits = structuredClone(defaultSettings.syncLimits);
  }
  if (!settings.shortcuts) {
    settings.shortcuts = structuredClone(defaultSettings.shortcuts);
  }
  if (!settings.relation) {
    settings.relation = structuredClone(defaultSettings.relation);
  }
  if (!settings.cloudSync) {
    settings.cloudSync = structuredClone(defaultSettings.cloudSync);
  }
  if (!settings.autoSync) {
    settings.autoSync = structuredClone(defaultSettings.autoSync);
  }
  // 返回给渲染进程的设置必须保留原始 cookie，否则后续保存会把脱敏值写回文件
  return settings;
});

ipcMain.handle('settings:set', (_event, settings) => {
  try {
    // 与默认值深度合并，防止渲染进程只传部分字段时丢失已有配置（包括 cookie）
    const merged = deepMerge(structuredClone(defaultSettings), settings);
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2), 'utf-8');
    const cookieString = merged.cookieString;
    if (typeof cookieString === 'string' && cookieString.length > 10 && !cookieString.includes('***')) {
      writeUnifiedCookies(cookieString);
    }
    unregisterGlobalShortcuts();
    registerGlobalShortcuts();
    return true;
  } catch (e) {
    console.error('保存设置失败', e);
    return false;
  }
});

// ========== IPC：工具 ==========
ipcMain.handle('path:join', (_event, segments) => {
  if (!Array.isArray(segments)) return '';
  const safeSegments = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (typeof s !== 'string') continue;
    if (s === '..' || s.startsWith('..') || s.includes('/..') || s.includes('\\..')) continue;
    // 仅允许第一个段为绝对路径（作为基础目录），后续段必须为相对路径
    if (i > 0 && path.isAbsolute(s)) continue;
    safeSegments.push(s);
  }
  return path.join(...safeSegments);
});

ipcMain.handle('clipboard:writeText', (_event, text) => {
  try {
    clipboard.writeText(String(text || ''));
    return { success: true };
  } catch (e) {
    console.error('clipboard:writeText failed', e);
    return { success: false, error: e && e.message };
  }
});

ipcMain.on('path:join-sync', (_event, segments) => {
  if (!Array.isArray(segments)) {
    _event.returnValue = '';
    return;
  }
  const safeSegments = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (typeof s !== 'string') continue;
    if (s === '..' || s.startsWith('..') || s.includes('/..') || s.includes('\\..')) continue;
    // 仅允许第一个段为绝对路径（作为基础目录），后续段必须为相对路径
    if (i > 0 && path.isAbsolute(s)) continue;
    safeSegments.push(s);
  }
  _event.returnValue = path.join(...safeSegments);
});

// ========== IPC：目录与档案 ==========
ipcMain.handle('folder:select', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('folder:open', (_event, dirPath) => {
  const allowed = resolveAllowedPath(dirPath, [getOutputPath(), userDataPath]);
  if (!allowed) return;

  // 精确目录存在则直接打开
  if (fs.existsSync(allowed) && fs.statSync(allowed).isDirectory()) {
    shell.openPath(allowed);
    return;
  }

  // 精确目录不存在时，在父目录中按目标文件夹名做模糊匹配
  //（抖音对文件夹名会做 sanitize，前端传入的昵称可能与实际文件夹名不完全一致）
  const targetName = path.basename(allowed);
  let parent = path.dirname(allowed);
  while (parent && (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory())) {
    const nextParent = path.dirname(parent);
    if (nextParent === parent) break;
    parent = nextParent;
  }
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) return;

  try {
    const folders = fs.readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    const exact = folders.find((f) => f === targetName);
    if (exact) {
      shell.openPath(path.join(parent, exact));
      return;
    }
    const normalizedTarget = targetName.toLowerCase().replace(/[\\/:*?"<>|_\s~～]+/g, '');
    if (normalizedTarget) {
      const scored = folders
        .map((f) => {
          const normalized = f.toLowerCase().replace(/[\\/:*?"<>|_\s~～]+/g, '');
          let score = 0;
          if (normalized === normalizedTarget) score = 100;
          else if (normalized.includes(normalizedTarget)) score = 50 + normalizedTarget.length;
          else if (normalizedTarget.includes(normalized)) score = 10 + normalized.length;
          return { f, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      if (scored.length > 0) {
        shell.openPath(path.join(parent, scored[0].f));
        return;
      }
    }
    shell.openPath(parent);
  } catch (e) {
    console.error('folder:open error', e);
  }
});

function listVideos(dirPath) {
  const videoExts = new Set(['.mp4', '.mov', '.mkv', '.avi', '.flv', '.wmv', '.webm', '.m4v']);
  try {
    return fs.readdirSync(dirPath)
      .filter((f) => videoExts.has(path.extname(f).toLowerCase()))
      .map((f) => ({ name: f, path: path.join(dirPath, f) }));
  } catch (e) {
    return [];
  }
}

ipcMain.handle('archive:list', (_event, dirPath) => {
  const target = resolveAllowedPath(dirPath, [getOutputPath()]) || getOutputPath();
  if (!fs.existsSync(target)) return [];
  const items = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const fullPath = path.join(target, entry.name);
      const files = [];
      const videos = [];
      try {
        for (const f of fs.readdirSync(fullPath)) {
          files.push(f);
        }
        videos.push(...listVideos(fullPath));
      } catch (e) {
        // ignore
      }
      const stat = fs.statSync(fullPath);
      items.push({
        name: entry.name,
        path: fullPath,
        type: 'folder',
        files,
        videos,
        videoCount: videos.length,
        mtime: stat.mtime.toISOString(),
      });
    }
  }
  return items.sort((a, b) => b.mtime.localeCompare(a.mtime));
});

ipcMain.handle('archive:delete', (_event, dirPath) => {
  const allowed = resolveAllowedPath(dirPath, [getOutputPath()]);
  if (!allowed || !fs.existsSync(allowed)) return false;
  try {
    const stat = fs.statSync(allowed);
    if (!stat.isDirectory()) return false;
    fs.rmSync(allowed, { recursive: true, force: true });
    return true;
  } catch (e) {
    console.error('删除档案失败', e);
    return false;
  }
});

ipcMain.handle('archive:status', async (_event, payload) => {
  const { dbPath, secUids } = payload || {};
  const allowedDbPath = resolveAllowedPath(dbPath, [getOutputPath()]);
  if (!allowedDbPath || !Array.isArray(secUids) || secUids.length === 0) {
    return {};
  }
  const pythonPath = await findPythonExecutable();
  if (!pythonPath) {
    return {};
  }
  const taskId = `archive-status-${Date.now()}`;
  const jobFile = writeJobFile(taskId, { dbPath: allowedDbPath, secUids });
  const scriptPath = path.join(getPythonRoot(), 'archive_status_bridge.py');
  const { cmd, args } = resolvePythonSpawnArgs(pythonPath, scriptPath, ['--job', jobFile, '--task-id', taskId]);

  return new Promise((resolve) => {
    let stdoutBuffer = '';
    let finishedData = null;
    let settled = false;
    const proc = spawn(cmd, args, {
      cwd: isDispatcherMode(pythonPath) ? userDataPath : getPythonRoot(),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...bridgeEnvVars() },
    });

    const finish = (data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { fs.unlinkSync(jobFile); } catch (e) {}
      try { killProcessTree(proc.pid); } catch (e) {}
      resolve(data);
    };

    const timeout = setTimeout(() => {
      finish({});
    }, 30_000);

    proc.stdout.on('data', (data) => {
      stdoutBuffer += data.toString('utf-8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.event === 'finished' && parsed.task_id === taskId) {
            finishedData = parsed;
          }
        } catch (e) {
          // ignore non-JSON lines
        }
      }
    });

    proc.on('close', () => {
      if (finishedData && finishedData.success && typeof finishedData.data === 'object') {
        finish(finishedData.data);
      } else {
        finish({});
      }
    });

    proc.on('error', () => {
      finish({});
    });
  });
});

ipcMain.handle('video:open', (_event, filePath) => {
  const allowed = resolveAllowedPath(filePath, [getOutputPath()]);
  if (!allowed || !fs.existsSync(allowed)) return;
  const videoExts = new Set(['.mp4', '.mov', '.mkv', '.avi', '.flv', '.wmv', '.webm', '.m4v']);
  if (!videoExts.has(path.extname(allowed).toLowerCase())) return;
  shell.openPath(allowed);
});

function isValidSyncKind(kind) {
  return typeof kind === 'string' && /^[a-zA-Z0-9_-]+$/.test(kind);
}

function getSyncCachePath(kind) {
  if (!isValidSyncKind(kind)) return null;
  const outputPath = getOutputPath();
  return path.join(outputPath, '.sync', `${kind}.json`);
}

function readSyncCache(kind) {
  const cachePath = getSyncCachePath(kind);
  if (!cachePath || !fs.existsSync(cachePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  } catch (e) {
    return null;
  }
}

function cleanupSyncCacheByRetention() {
  try {
    const settings = getSettingsSync();
    const retention = settings.retention || 'forever';
    if (retention === 'forever') return;
    const days = parseInt(String(retention).replace(/\D/g, ''), 10);
    if (!days || days <= 0) return;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const syncDir = path.join(getOutputPath(), '.sync');
    if (!fs.existsSync(syncDir)) return;
    for (const file of fs.readdirSync(syncDir)) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(syncDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const updatedAt = data.updated_at;
        if (!updatedAt) continue;
        const ts = new Date(updatedAt).getTime();
        if (!isNaN(ts) && ts < cutoff) {
          fs.unlinkSync(filePath);
          console.log('清理过期同步缓存:', filePath);
        }
      } catch (e) {
        // 忽略单个文件读取/解析失败
      }
    }
  } catch (e) {
    console.error('清理同步缓存失败', e);
  }
}

ipcMain.handle('sync:get', (_event, kind) => {
  return readSyncCache(kind);
});

ipcMain.handle('sync:clear', (_event, kind) => {
  const cachePath = getSyncCachePath(kind);
  if (!cachePath) return false;
  try {
    if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
    return true;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('sync:save', (_event, kind, data) => {
  const cachePath = getSyncCachePath(kind);
  if (!cachePath) return false;
  try {
    const syncDir = path.dirname(cachePath);
    if (!fs.existsSync(syncDir)) fs.mkdirSync(syncDir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(data), 'utf-8');
    return true;
  } catch (e) {
    console.error('保存同步缓存失败', cachePath, e);
    return false;
  }
});

// ========== 通用 Python 桥接 ==========
function getBackendRoot() {
  return path.join(__dirname, '..', 'backend');
}

function getPythonRoot() {
  return path.join(__dirname, '..', 'python');
}

async function runPythonBridge(scriptRelativePath, taskId, jobFile, cwd, progressChannel, logChannel, finishedChannel, activeMap, onFinished = null, options = {}) {
  if (!isValidTaskId(taskId)) {
    try { fs.unlinkSync(jobFile); } catch (e) {}
    return { started: false, error: 'taskId 格式无效' };
  }
  const pythonPath = await findPythonExecutable();
  if (!pythonPath) {
    return { started: false, error: '找不到可用的 Python 解释器，请在设置中配置 pythonPath 或安装 Python' };
  }
  if (activeMap.has(taskId)) {
    try { fs.unlinkSync(jobFile); } catch (e) {}
    return { started: false, error: '任务已在运行' };
  }

  // 允许调用方自定义进度/日志发送函数（例如队列任务需要把子任务事件重定向到根任务）
  const sendProgress = options.sendProgress || ((payload) => sendToRenderer(progressChannel, payload));
  const sendLog = options.sendLog || ((payload) => sendToRenderer(logChannel, payload));

  // 捕获后端在日志中输出的 finished 事件数据，确保最终状态以权威汇总为准，
  // 避免前端因进度事件与 finished 事件到达顺序不一致而错误标记状态。
  let finishedPayload = null;
  const handleProgressPayload = (payload) => {
    const data = payload && payload.data ? payload.data : {};
    if (data.event === 'finished') {
      finishedPayload = data;
    }
    sendProgress(payload);
  };

  const scriptPath = path.isAbsolute(scriptRelativePath) ? scriptRelativePath : path.join(getPythonRoot(), scriptRelativePath);

  // 将 stdout/stderr 重定向到日志文件并由主进程轮询读取，避免 Electron GUI
  // 进程在 Windows 上 spawn Python 时 pipe/close 事件不可靠导致前端无输出。
  const bridgeLogDir = path.join(userDataPath, 'logs', 'bridges');
  try {
    if (!fs.existsSync(bridgeLogDir)) fs.mkdirSync(bridgeLogDir, { recursive: true });
  } catch (e) {
    // 日志目录创建失败仍继续，回退到默认行为
  }
  const outPath = path.join(bridgeLogDir, `${taskId}.stdout.log`);
  const errPath = path.join(bridgeLogDir, `${taskId}.stderr.log`);
  try {
    fs.writeFileSync(outPath, '', 'utf-8');
    fs.writeFileSync(errPath, '', 'utf-8');
  } catch (fdErr) {
    try { fs.unlinkSync(jobFile); } catch (e) {}
    return { started: false, error: `创建桥接日志文件失败: ${fdErr.message}` };
  }

  const { cmd, args } = resolvePythonSpawnArgs(pythonPath, scriptPath, ['--job', jobFile, '--task-id', taskId, '--stdout-log', outPath, '--stderr-log', errPath]);

  let proc;
  try {
    proc = spawn(cmd, args, {
      // dispatcher 模式脚本路径由 dispatcher.exe 内部解析，cwd 必须用存在的 userDataPath；
      // 普通 Python 模式才尊重调用方传入的 cwd 或回退到 getPythonRoot()。
      cwd: isDispatcherMode(pythonPath) ? userDataPath : (cwd || getPythonRoot()),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', DOUZY_USER_DATA: userDataPath, DOUZY_OUTPUT_PATH: getOutputPath(), DOUZY_BRIDGE_PORT: bridgePort ? String(bridgePort) : '', DOUZY_BRIDGE_TOKEN: bridgeToken },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (spawnErr) {
    try { fs.unlinkSync(jobFile); } catch (e) {}
    // 保留日志文件用于排查启动失败
    return { started: false, error: `启动 Python 桥接进程失败: ${spawnErr.message}` };
  }
  trackProcess(proc);

  const state = { proc, startTime: Date.now(), finished: false };
  activeMap.set(taskId, state);

  const { maxRuntimeMs = 0, stallMs = 0 } = options;
  let lastOutputAt = Date.now();
  let maxRuntimeTimer = null;
  let stallTimer = null;

  const bumpOutputTime = () => {
    lastOutputAt = Date.now();
  };

  const stopWatchdogs = () => {
    if (maxRuntimeTimer) {
      clearTimeout(maxRuntimeTimer);
      maxRuntimeTimer = null;
    }
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  const startWatchdogs = () => {
    stopWatchdogs();
    if (stallMs > 0) {
      const checkStall = () => {
        if (state.finished) return;
        const idle = Date.now() - lastOutputAt;
        if (idle >= stallMs) {
          sendLog({ taskId, line: `任务超过 ${stallMs}ms 无输出，视为卡死，强制终止` });
          killProcessTree(proc.pid);
          setTimeout(() => finishOnce(124), 500);
          return;
        }
        stallTimer = setTimeout(checkStall, Math.max(1000, stallMs - idle));
      };
      stallTimer = setTimeout(checkStall, Math.max(1000, stallMs));
    }
    if (maxRuntimeMs > 0) {
      maxRuntimeTimer = setTimeout(() => {
        if (state.finished) return;
        const minutes = Math.round(maxRuntimeMs / 60000);
        sendLog({ taskId, line: `任务超过最大运行时间 ${minutes} 分钟，强制终止` });
        killProcessTree(proc.pid);
        setTimeout(() => finishOnce(123), 500);
      }, maxRuntimeMs);
    }
  };

  startWatchdogs();

  // 保留 pipe 兜底，用于捕获重定向失败时的输出。
  proc.stdout.on('data', (data) => {
    bumpOutputTime();
    const lines = data.toString('utf-8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        handleProgressPayload({ taskId, data: parsed });
      } catch (e) {
        sendLog({ taskId, line: redactText(line) });
      }
    }
  });

  proc.stderr.on('data', (data) => {
    bumpOutputTime();
    const lines = data.toString('utf-8').split(/\r?\n/);
    for (const line of lines) {
      if (line.trim()) {
        sendLog({ taskId, line: redactText(line) });
      }
    }
  });

  const fileBuffers = { out: '', err: '' };
  const filePositions = { out: 0, err: 0 };

  const drainFile = (filePath, key, isErr) => {
    try {
      if (!fs.existsSync(filePath)) return;
      const stats = fs.statSync(filePath);
      if (stats.size <= filePositions[key]) return;
      bumpOutputTime();
      const fd = fs.openSync(filePath, 'r');
      try {
        const buffer = Buffer.alloc(stats.size - filePositions[key]);
        fs.readSync(fd, buffer, 0, buffer.length, filePositions[key]);
        filePositions[key] = stats.size;
        fileBuffers[key] += buffer.toString('utf-8');
        const lines = fileBuffers[key].split(/\r?\n/);
        fileBuffers[key] = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            handleProgressPayload({ taskId, data: parsed });
          } catch (e) {
            sendLog({ taskId, line: redactText(line) });
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      // 轮询读取失败不应阻塞主流程
    }
  };

  const pollInterval = setInterval(() => {
    drainFile(outPath, 'out', false);
    drainFile(errPath, 'err', true);
  }, 500);

  // 保留 stdout/stderr 日志以便排查失败原因（此前任务结束即删除，导致下载/采集
  // 失败时完全无据可查）。仅删除 job 文件，日志文件保留在 logs/bridges/ 下，
  // 由 startBridgeServer 启动时做数量轮转（保留最近 N 个）。
  const cleanupFiles = () => {
    try { fs.unlinkSync(jobFile); } catch (e) {}
  };

  const finishOnce = (code) => {
    if (state.finished) return;
    state.finished = true;
    stopWatchdogs();
    clearInterval(pollInterval);
    drainFile(outPath, 'out', false);
    drainFile(errPath, 'err', true);
    activeMap.delete(taskId);
    cleanupFiles();
    const finishedData = finishedPayload && typeof finishedPayload === 'object'
      ? Object.fromEntries(Object.entries(finishedPayload).filter(([k]) => k !== 'event' && k !== 'task_id' && k !== 'task_type'))
      : null;
    sendToRenderer(finishedChannel, { taskId, code, data: finishedData });
    if (typeof onFinished === 'function') {
      try {
        onFinished(code, finishedData);
      } catch (e) {
        console.error(`[runPythonBridge] onFinished error for ${taskId}:`, e);
      }
    }
  };

  proc.on('exit', (code) => {
    // 给 close 事件一点时间触发；若未触发则主动收尾。
    setTimeout(() => finishOnce(code), 300);
  });
  proc.on('close', (code) => finishOnce(code));
  proc.on('error', (err) => {
    sendLog({ taskId, line: redactText(`桥接进程异常: ${err.message}`) });
    finishOnce(1);
  });

  return { started: true };
}

function writeJobFile(taskId, payload) {
  const jobFile = path.join(jobsPath, `${taskId}.json`);
  try {
    if (!fs.existsSync(jobsPath)) {
      fs.mkdirSync(jobsPath, { recursive: true });
    }
    fs.writeFileSync(jobFile, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (err) {
    console.error(`[writeJobFile] failed to write ${jobFile}: ${err.message}`);
    throw err;
  }
  return jobFile;
}

function cancelTask(taskId, activeMap) {
  const task = activeMap.get(taskId);
  if (!task || !task.proc) return false;
  if (task.proc.killed || task.proc.exitCode !== null) {
    // 进程已经结束，但尚未触发 finishOnce 收尾，仍然返回 true 让前端得到反馈。
    return true;
  }
  try {
    killProcessTree(task.proc.pid);
    return true;
  } catch (e) {
    console.error(`[cancelTask] ${taskId} failed`, e);
    return false;
  }
}

// ========== IPC：下载超时保护 ==========
const DOWNLOAD_MAX_RUNTIME_MS = 10 * 60 * 1000; // 单个下载任务最大运行 10 分钟
const DOWNLOAD_STALL_MS = 90 * 1000;            // 90 秒无输出视为卡死

// 队列中单 URL 下载的超时保护，单个链接卡住不应阻塞后续链接
const QUEUE_URL_STALL_MS = 60 * 1000;           // 60 秒无输出视为卡死

function getQueueUrlMaxRuntimeMs() {
  const settings = getSettingsSync();
  const minutes = Number(settings && settings.queueUrlMaxRuntimeMinutes) || 30;
  return Math.max(1, minutes) * 60 * 1000;
}

// 全局下载调度：所有下载任务（批量重试、批量下载等）统一排队，一次只执行一个根任务，
// 防止多个任务同时 spawn 大量 Python 子进程导致程序卡死。
const globalDownloadQueue = []; // 等待执行的 DownloadQueue
let activeDownloadQueue = null; // 当前正在执行的 DownloadQueue

function enqueueDownload(queue) {
  if (activeDownloadQueue) {
    globalDownloadQueue.push(queue);
    queue.waiting = true;
    // 排队数按「任务项」计算：包含当前正在执行的任务 + 排在本任务前面的任务
    const ahead = globalDownloadQueue.length;
    sendToRenderer('download:progress', {
      taskId: queue.rootTaskId,
      data: { event: 'step', step: '排队中', detail: `前面还有 ${ahead} 个下载任务` },
    });
    sendToRenderer('download:log', {
      taskId: queue.rootTaskId,
      line: `进入全局下载队列，当前前面还有 ${ahead} 个任务`,
    });
  } else {
    activeDownloadQueue = queue;
    queue._execute();
  }
}

function dequeueNextDownload() {
  activeDownloadQueue = null;
  if (globalDownloadQueue.length === 0) return;
  const next = globalDownloadQueue.shift();
  next.waiting = false;
  activeDownloadQueue = next;
  next._execute();
  // 当前执行任务开始后，刷新剩余排队任务的 ahead 计数
  globalDownloadQueue.forEach((queue, index) => {
    const ahead = 1 + index; // 当前执行任务 + 排在前面的任务
    sendToRenderer('download:progress', {
      taskId: queue.rootTaskId,
      data: { event: 'step', step: '排队中', detail: `前面还有 ${ahead} 个下载任务` },
    });
  });
}

// ========== 下载队列：批量下载拆分为单链接串行执行，失败自动跳过 ==========
class DownloadQueue {
  constructor(rootTaskId, urls, config, cookies, downloadContext) {
    this.rootTaskId = rootTaskId;
    this.urls = urls.slice();
    this.config = config;
    this.cookies = cookies;
    this.downloadContext = downloadContext;
    this.pending = urls.slice();
    this.running = false;
    this.waiting = false;
    this.cancelled = false;
    this.currentSubId = null;
    this.processedCount = 0;
    this.totalSuccess = 0;
    this.totalFailed = 0;
    this.totalSkipped = 0;
  }

  start() {
    if (this.running || this.waiting) return;
    downloadQueues.set(this.rootTaskId, this);
    enqueueDownload(this);
  }

  async _execute() {
    this.running = true;
    try {
      if (this.cancelled) {
        this._finish(1);
        return;
      }
      sendToRenderer('download:progress', {
        taskId: this.rootTaskId,
        data: { event: 'queue_init', total: this.urls.length },
      });
      sendToRenderer('download:log', {
        taskId: this.rootTaskId,
        line: `下载队列启动，共 ${this.urls.length} 个链接，将逐个处理`,
      });
      const code = await this._runLoop();
      this._finish(code);
    } catch (err) {
      sendToRenderer('download:log', {
        taskId: this.rootTaskId,
        line: `队列执行异常：${err && err.message ? err.message : err}`,
      });
      this._finish(1);
    } finally {
      this.running = false;
      this.waiting = false;
      downloadQueues.delete(this.rootTaskId);
      dequeueNextDownload();
    }
  }

  _finish(code) {
    const data = {
      urls_count: this.urls.length,
      total_success: this.totalSuccess,
      total_failed: this.totalFailed,
      total_skipped: this.totalSkipped,
    };
    sendToRenderer('download:finished', { taskId: this.rootTaskId, code, data });
  }

  async _runLoop() {
    while (this.pending.length > 0 && !this.cancelled) {
      this.processedCount += 1;
      const url = this.pending.shift();
      const subId = `${this.rootTaskId}--${this.processedCount}`;
      this.currentSubId = subId;

      sendToRenderer('download:log', {
        taskId: this.rootTaskId,
        line: `[队列] ${this.processedCount}/${this.urls.length} ${url}`,
      });

      const perUrlTimeoutMinutes = Number(getSettingsSync().queueUrlMaxRuntimeMinutes) || 30;
      const jobFile = writeJobFile(subId, {
        task_type: 'download',
        urls: [url],
        config: this.config,
        cookies: this.cookies,
        downloadContext: this.downloadContext,
        cookieFile: cookieFilePath,
        perUrlTimeoutMinutes,
      });

      const sendProgressAsRoot = (payload) => {
        const data = payload && payload.data ? payload.data : {};
        // 子任务的完成事件由队列统一发送，避免前端提前结束根任务
        if (data.event === 'finished') return;
        // 用队列真实序号覆盖 Python 内部单 URL 的 1/1 显示
        if (data.event === 'url_start') {
          data.index = this.processedCount;
          data.total = this.urls.length;
        }
        sendToRenderer('download:progress', { ...payload, taskId: this.rootTaskId });
      };
      const sendLogAsRoot = (payload) => {
        sendToRenderer('download:log', { ...payload, taskId: this.rootTaskId });
      };

      await this._runOne(subId, jobFile, sendProgressAsRoot, sendLogAsRoot);
      this.currentSubId = null;
    }
    if (this.cancelled) return 1;
    // 任意子任务失败或完全没有处理成功/跳过时，返回非 0 让 exit code 语义正确
    if (this.totalFailed > 0) return 1;
    if (this.totalSuccess + this.totalSkipped === 0 && this.urls.length > 0) return 1;
    return 0;
  }

  _runOne(subId, jobFile, sendProgressAsRoot, sendLogAsRoot) {
    return new Promise((resolve) => {
      runPythonBridge(
        'download_bridge.py',
        subId,
        jobFile,
        getPythonRoot(),
        'download:progress',
        'download:log',
        'download:finished',
        activeDownloads,
        (code, data) => {
          if (data && typeof data === 'object') {
            this.totalSuccess += Number(data.total_success) || 0;
            this.totalFailed += Number(data.total_failed) || 0;
            this.totalSkipped += Number(data.total_skipped) || 0;
            // 子任务明确报告失败但计数全为 0 时（如后端异常未统计），
            // 至少把当前 URL 计为失败，防止根任务被误判为成功。
            if (data.success === false && this.totalFailed === 0) {
              this.totalFailed += 1;
            }
          } else if (code !== 0) {
            // 子任务异常退出（超时、卡死、崩溃）且没有返回结果，
            // 至少把当前正在处理的 URL 计为失败，避免根任务被误标为成功。
            this.totalFailed += 1;
          }
          resolve(code);
        },
        {
          maxRuntimeMs: getQueueUrlMaxRuntimeMs(),
          stallMs: QUEUE_URL_STALL_MS,
          sendProgress: sendProgressAsRoot,
          sendLog: sendLogAsRoot,
        }
      )
        .then((result) => {
          if (!result || !result.started) {
            const reason = result && result.error ? result.error : '未知错误';
            sendLogAsRoot({ taskId: this.rootTaskId, line: `子任务启动失败：${reason}` });
            this.totalFailed += 1;
            resolve(1);
          }
        })
        .catch((err) => {
          sendLogAsRoot({ taskId: this.rootTaskId, line: `子任务启动异常：${err && err.message ? err.message : err}` });
          this.totalFailed += 1;
          resolve(1);
        });
    });
  }

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    if (this.waiting) {
      const idx = globalDownloadQueue.indexOf(this);
      if (idx >= 0) globalDownloadQueue.splice(idx, 1);
      this.waiting = false;
      downloadQueues.delete(this.rootTaskId);
      sendToRenderer('download:log', {
        taskId: this.rootTaskId,
        line: '排队任务已取消',
      });
      this._finish(1);
      return;
    }
    if (this.currentSubId) {
      cancelTask(this.currentSubId, activeDownloads);
    }
    sendToRenderer('download:log', {
      taskId: this.rootTaskId,
      line: '用户取消下载队列，当前及剩余任务已停止',
    });
  }
}

// ========== IPC：下载 ==========
ipcMain.handle('download:start', async (_event, payload) => {
  const { taskId, urls, config, cookies, downloadContext } = payload;
  if (!urls || urls.length === 0) {
    return { started: false, error: '没有 URL' };
  }
  if (downloadQueues.has(taskId)) {
    return { started: false, error: '下载任务已在运行' };
  }
  const queue = new DownloadQueue(taskId, urls, config, cookies, downloadContext);
  queue.start();
  return { started: true };
});

ipcMain.handle('download:cancel', (_event, taskId) => {
  const queue = downloadQueues.get(taskId);
  if (queue) {
    queue.cancel();
    return true;
  }
  return cancelTask(taskId, activeDownloads);
});

// ========== IPC：同步 ==========
const SYNC_MAX_RUNTIME_MS = 10 * 60 * 1000; // 同步最大运行 10 分钟
const SYNC_STALL_MS = 3 * 60 * 1000;        // 3 分钟无输出视为卡住

const syncLogDir = path.join(userDataPath, 'logs');
function writeSyncLog(line) {
  try {
    if (!fs.existsSync(syncLogDir)) fs.mkdirSync(syncLogDir, { recursive: true });
    const ts = new Date().toISOString();
    fs.appendFileSync(path.join(syncLogDir, 'sync.log'), `[${ts}] ${line}\n`, 'utf-8');
  } catch (e) {
    // 日志写入失败不应影响主流程
  }
}

ipcMain.handle('sync:start', async (_event, payload) => {
  const { syncId, kind, subKind, config, cookies, limits } = payload;

  const pythonPath = await findPythonExecutable();
  if (!pythonPath) {
    return { started: false, error: '找不到可用的 Python 解释器，请在设置中配置 pythonPath 或安装 Python' };
  }
  if (!syncId || activeSyncs.has(syncId)) {
    return { started: false, error: '同步任务已在运行或 syncId 无效' };
  }

  const jobFile = writeJobFile(syncId, { kind, subKind, config, cookies, limits, query: payload.query, cookieFile: cookieFilePath });
  const backendRoot = getBackendRoot();
  const syncPath = path.join(backendRoot, 'sync_service.py');

  writeSyncLog(`[sync:start] ${syncId} ${kind} python=${pythonPath} job=${jobFile}`);
  writeSyncLog(`[sync:start] ${syncId} cwd=${backendRoot} syncPath=${syncPath}`);

  // 将 stdout/stderr 日志文件路径传给 Python，由 Python 直接写入文件。
  // Electron GUI 进程直接 spawn Python 时，pipe/exit 事件在某些环境下不会触发，
  // 因此让 Python 自己写日志文件，主进程通过轮询文件获取进度；同时监听进程事件作为补充。
  const syncOutPath = path.join(syncLogDir, `${syncId}.stdout.log`);
  const syncErrPath = path.join(syncLogDir, `${syncId}.stderr.log`);
  try {
    fs.writeFileSync(syncOutPath, '', 'utf-8');
    fs.writeFileSync(syncErrPath, '', 'utf-8');
  } catch (fdErr) {
    writeSyncLog(`[sync:start] ${syncId} 创建输出文件失败: ${fdErr.message}`);
    try { fs.unlinkSync(jobFile); } catch (e) {}
    return { started: false, error: `创建同步日志文件失败: ${fdErr.message}` };
  }

  const { cmd, args } = resolvePythonSpawnArgs(pythonPath, syncPath, ['--sync-job', jobFile, '--stdout-log', syncOutPath, '--stderr-log', syncErrPath]);

  let proc;
  try {
    proc = spawn(cmd, args, {
      cwd: isDispatcherMode(pythonPath) ? userDataPath : backendRoot,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...bridgeEnvVars() },
      windowsHide: true,
      // 保留 pipe 作为兜底，但主要输出通过 Python 自写的日志文件获取。
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (spawnErr) {
    writeSyncLog(`[sync:start] ${syncId} spawn 失败: ${spawnErr.message}`);
    try { fs.unlinkSync(jobFile); } catch (e) {}
    return { started: false, error: `启动同步进程失败: ${spawnErr.message}` };
  }
  trackProcess(proc);
  writeSyncLog(`[sync:start] ${syncId} spawn object created pid=${proc.pid || 'unknown'}`);

  proc.on('spawn', () => {
    writeSyncLog(`[sync:start] ${syncId} spawn event fired pid=${proc.pid || 'unknown'}`);
  });

  // 消费 pipe，防止 Windows 上管道缓冲区满导致子进程卡住；
  // Python 正常会将输出写入日志文件，这里主要捕获重定向失败时的错误。
  proc.stdout.on('data', (data) => {
    const text = data.toString('utf-8').trim();
    if (text) writeSyncLog(`[sync:pipe:stdout] ${syncId} ${redactText(text)}`);
  });
  proc.stderr.on('data', (data) => {
    const text = data.toString('utf-8').trim();
    if (text) {
      writeSyncLog(`[sync:pipe:stderr] ${syncId} ${redactText(text)}`);
      sendToRenderer('sync:log', { syncId, line: redactText(text) });
    }
  });

  const syncState = { proc, startTime: Date.now(), lastActivity: Date.now(), finished: false };
  activeSyncs.set(syncId, syncState);

  let finishOnce = (code, reason) => {
    if (syncState.finished) return;
    syncState.finished = true;
    clearInterval(pollInterval);
    drainFile(syncOutPath, 'out', false);
    drainFile(syncErrPath, 'err', true);
    activeSyncs.delete(syncId);
    clearTimeout(maxRuntimeTimer);
    clearTimeout(stallTimer);
    try { fs.unlinkSync(jobFile); } catch (e) {}
    try { fs.unlinkSync(syncOutPath); } catch (e) {}
    try { fs.unlinkSync(syncErrPath); } catch (e) {}
    writeSyncLog(`[sync:finished] ${syncId} code=${code} reason=${reason || 'normal'}`);
    sendToRenderer('sync:finished', { syncId, code, kind });
    cleanupSyncCacheByRetention();
  };

  const maxRuntimeTimer = setTimeout(() => {
    writeSyncLog(`[sync:timeout] ${syncId} 超过 ${SYNC_MAX_RUNTIME_MS}ms 强制终止`);
    if (proc && !proc.killed) {
      killProcessTree(proc.pid);
    }
    // 如果 close/exit 事件未触发，主动 finish
    setTimeout(() => finishOnce(124, 'max-runtime'), 500);
  }, SYNC_MAX_RUNTIME_MS);

  const startStallTimer = () => setTimeout(() => {
    writeSyncLog(`[sync:stall] ${syncId} 超过 ${SYNC_STALL_MS}ms 无输出`);
    if (proc && !proc.killed) {
      killProcessTree(proc.pid);
    }
    setTimeout(() => finishOnce(125, 'stall'), 500);
  }, SYNC_STALL_MS);

  const resetStallTimer = () => {
    clearTimeout(stallTimer);
    return startStallTimer();
  };

  let stallTimer = startStallTimer();

  // 轮询读取 Python 自己写入的日志文件
  const filePositions = { out: 0, err: 0 };
  const drainFile = (filePath, key, isErr) => {
    try {
      if (!fs.existsSync(filePath)) return;
      const stats = fs.statSync(filePath);
      if (stats.size <= filePositions[key]) return;
      const fd = fs.openSync(filePath, 'r');
      try {
        const buffer = Buffer.alloc(stats.size - filePositions[key]);
        fs.readSync(fd, buffer, 0, buffer.length, filePositions[key]);
        filePositions[key] = stats.size;
        const text = buffer.toString('utf-8');
        if (!text) return;
        syncState.lastActivity = Date.now();
        stallTimer = resetStallTimer();
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          if (!line.trim()) continue;
          writeSyncLog(`[sync:${isErr ? 'stderr' : 'stdout'}] ${syncId} ${redactText(line)}`);
          if (isErr) {
            sendToRenderer('sync:log', { syncId, line: redactText(line) });
          } else {
            try {
              const parsed = JSON.parse(line);
              sendToRenderer('sync:progress', { syncId, data: parsed });
              // 如果 Python 已报告完成或错误，立即结束任务，不再等待 exit 事件
              if (parsed && (parsed.event === 'sync_done' || parsed.event === 'sync_error')) {
                setImmediate(() => finishOnce(parsed.event === 'sync_done' ? 0 : 1, parsed.event));
              }
            } catch (e) {
              sendToRenderer('sync:log', { syncId, line: redactText(line) });
            }
          }
        }
      } finally {
        try { fs.closeSync(fd); } catch (e) {}
      }
    } catch (e) {
      writeSyncLog(`[sync:poll] ${syncId} ${key} error: ${e.message}`);
    }
  };

  const pollInterval = setInterval(() => {
    drainFile(syncOutPath, 'out', false);
    drainFile(syncErrPath, 'err', true);
  }, 500);

  proc.on('error', (err) => {
    writeSyncLog(`[sync:error] ${syncId} ${err.message}`);
    finishOnce(126, 'error');
  });

  proc.on('exit', (code) => {
    writeSyncLog(`[sync:exit] ${syncId} code=${code}`);
    finishOnce(code, 'exit');
  });

  proc.on('close', (code) => {
    writeSyncLog(`[sync:close] ${syncId} code=${code}`);
    finishOnce(code, 'close');
  });

  return { started: true };
});

ipcMain.handle('sync:cancel', (_event, syncId) => {
  return cancelTask(syncId, activeSyncs);
});

// ========== Electron 自带 Chromium 采集桥接 ==========
// 桌面端主程序在本地启动一个仅监听 127.0.0.1 的 HTTP 服务，暴露 /v1/browser-collect
// 与 /v1/browser-detail。后端进程（同一台机器上的 dispatcher.exe）通过该端口请求，
// 由 Electron 用自身真实 Chromium 打开抖音页面并拦截 aweme/post / aweme/detail 接口，
// 避免 Playwright 自动化被 Argus 风控。
function startBridgeServer() {
  try {
    bridgeToken = crypto.randomBytes(24).toString('hex');
  } catch (e) {
    bridgeToken = 'draccoon-bridge-default-token';
  }

  bridgeServer = http.createServer((req, res) => {
    const sendJson = (code, obj) => {
      try {
        const body = JSON.stringify(obj);
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(body);
      } catch (e) {
        try { res.end('{"ok":false,"error":"internal"}'); } catch (e2) {}
      }
    };

    if (req.method === 'POST' && req.url && req.url.startsWith('/v1/browser-collect')) {
      let raw = '';
      let aborted = false;
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 8 * 1024 * 1024) {
          aborted = true;
          req.destroy();
        }
      });
      req.on('end', async () => {
        if (aborted) {
          sendJson(413, { ok: false, error: 'payload too large' });
          return;
        }
        let payload = {};
        try {
          payload = JSON.parse(raw || '{}');
        } catch (e) {
          sendJson(400, { ok: false, error: 'invalid json' });
          return;
        }
        if (!payload || payload.token !== bridgeToken) {
          sendJson(403, { ok: false, error: 'invalid token' });
          return;
        }
        if (bridgeCollectLock) {
          writeMainLog(`[bridge] browser-collect 拒绝(409)：已有采集任务在运行 lock=${bridgeCollectLock}`);
          sendJson(409, { ok: false, error: '已有采集任务在运行' });
          return;
        }
        bridgeCollectLock = payload.secUid || 'unknown';
        try {
          const result = await collectUserWorksViaBrowser(payload.secUid, {
            maxScrolls: Number(payload.maxScrolls) || 240,
            idleRounds: Number(payload.idleRounds) || 8,
            waitTimeoutSeconds: Number(payload.waitTimeoutSeconds) || 600,
            headless: Boolean(payload.headless),
            kind: payload.kind === 'like' ? 'like' : 'post',
          });
          writeMainLog(
            `[bridge] browser-collect secUid=${String(payload.secUid || '').slice(0, 20)} kind=${payload.kind || 'post'} ` +
              `silent=${Boolean(payload.headless)} ` +
              `ok=${!!(result && result.ok)} ids=${result && Array.isArray(result.aweme_ids) ? result.aweme_ids.length : 0} ` +
              `error=${(result && result.error) || ''}`
          );
          sendJson(200, result);
        } catch (err) {
          console.error('[bridge] browser-collect error:', err);
          sendJson(500, { ok: false, error: err && err.message ? err.message : String(err) });
        } finally {
          bridgeCollectLock = null;
        }
      });
      req.on('error', () => {
        try { sendJson(400, { ok: false, error: 'request error' }); } catch (e) {}
      });
    } else if (req.method === 'POST' && req.url && req.url.startsWith('/v1/browser-detail')) {
      let raw = '';
      let aborted = false;
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 8 * 1024 * 1024) {
          aborted = true;
          req.destroy();
        }
      });
      req.on('end', async () => {
        if (aborted) {
          sendJson(413, { ok: false, error: 'payload too large' });
          return;
        }
        let payload = {};
        try {
          payload = JSON.parse(raw || '{}');
        } catch (e) {
          sendJson(400, { ok: false, error: 'invalid json' });
          return;
        }
        if (!payload || payload.token !== bridgeToken) {
          sendJson(403, { ok: false, error: 'invalid token' });
          return;
        }
        if (bridgeDetailLock) {
          sendJson(409, { ok: false, error: '已有详情任务在运行' });
          return;
        }
        bridgeDetailLock = payload.awemeId || 'unknown';
        try {
          const result = await collectAwemeDetailViaBrowser(payload.awemeId, {
            waitTimeoutSeconds: Number(payload.waitTimeoutSeconds) || 120,
          });
          writeMainLog(
            `[bridge] browser-detail awemeId=${payload.awemeId} ok=${result && result.ok} ` +
              `hasDetail=${!!(result && result.detail)} error=${(result && result.error) || ''}`
          );
          sendJson(200, result);
        } catch (err) {
          console.error('[bridge] browser-detail error:', err);
          sendJson(500, { ok: false, error: err && err.message ? err.message : String(err) });
        } finally {
          bridgeDetailLock = null;
        }
      });
      req.on('error', () => {
        try { sendJson(400, { ok: false, error: 'request error' }); } catch (e) {}
      });
    } else if (req.method === 'POST' && req.url && req.url.startsWith('/v1/browser-fetch-batch')) {
      // 批量页面通道：一次窗口内并发发起多个带签名的抖音接口请求（用于作品详情批量补拉）。
      // 注意：必须排在 /v1/browser-fetch 分支之前，否则会被 startsWith 优先吞掉。
      // 逐个作品开新窗口抓详情（约 20s/个）是历史性能瓶颈，这里改为"一个已就绪页面 +
      // 页内并发 XHR"，几十个详情只需数秒，且完全不弹窗。
      let rawBatch = '';
      let abortedBatch = false;
      req.on('data', (chunk) => {
        rawBatch += chunk;
        if (rawBatch.length > 8 * 1024 * 1024) {
          abortedBatch = true;
          req.destroy();
        }
      });
      req.on('end', async () => {
        if (abortedBatch) {
          sendJson(413, { ok: false, error: 'payload too large' });
          return;
        }
        let payload = {};
        try {
          payload = JSON.parse(rawBatch || '{}');
        } catch (e) {
          sendJson(400, { ok: false, error: 'invalid json' });
          return;
        }
        if (!payload || payload.token !== bridgeToken) {
          sendJson(403, { ok: false, error: 'invalid token' });
          return;
        }
        const items = Array.isArray(payload.items) ? payload.items.filter((it) => it && it.key && it.url) : [];
        if (!items.length) {
          sendJson(400, { ok: false, error: '缺少 items' });
          return;
        }
        if (bridgeFetchLock) {
          sendJson(409, { ok: false, error: '已有页面通道请求在运行' });
          return;
        }
        bridgeFetchLock = 'fetch-batch';
        try {
          const results = await fetchBatchViaPageBridge(items, payload.ua || '', payload.concurrency);
          const okCount = Object.values(results || {}).filter((r) => Number(r.status) === 200).length;
          writeMainLog(
            `[bridge] browser-fetch-batch total=${items.length} ok=${okCount} ` +
              `path=${String(items[0].url).split('?')[0]}`
          );
          sendJson(200, { ok: true, results: results || {} });
        } catch (err) {
          console.error('[bridge] browser-fetch-batch error:', err);
          sendJson(500, { ok: false, error: err && err.message ? err.message : String(err) });
        } finally {
          bridgeFetchLock = null;
        }
      });
      req.on('error', () => {
        try { sendJson(400, { ok: false, error: 'request error' }); } catch (e) {}
      });
    } else if (req.method === 'POST' && req.url && req.url.startsWith('/v1/browser-fetch')) {
      // 通用页面通道：由桌面端内置登录窗口代为发起带签名的抖音接口请求。
      // 对标上游 Douzy 的 page_bridge.fetch(path, params)：在已加载 douyin.com 的页面内
      // 用 window.fetch 发起同源请求，由页面 SDK 自动补充 x-secsdk-web-signature / uifid，
      // 从而绕过 ArgusSecurityPlugin 对直连请求的 403 门禁。返回 {status, text}。
      let raw = '';
      let aborted = false;
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 8 * 1024 * 1024) {
          aborted = true;
          req.destroy();
        }
      });
      req.on('end', async () => {
        if (aborted) {
          sendJson(413, { ok: false, error: 'payload too large' });
          return;
        }
        let payload = {};
        try {
          payload = JSON.parse(raw || '{}');
        } catch (e) {
          sendJson(400, { ok: false, error: 'invalid json' });
          return;
        }
        if (!payload || payload.token !== bridgeToken) {
          sendJson(403, { ok: false, error: 'invalid token' });
          return;
        }
        const targetUrl = payload.url;
        if (!targetUrl) {
          sendJson(400, { ok: false, error: '缺少 url' });
          return;
        }
        if (bridgeFetchLock) {
          sendJson(409, { ok: false, error: '已有页面通道请求在运行' });
          return;
        }
        bridgeFetchLock = 'fetch';
        try {
          const result = await fetchViaPageBridge(targetUrl, payload.ua || '');
          writeMainLog(
            `[bridge] browser-fetch status=${result && result.status} len=${(result && result.text || '').length} ` +
              `path=${String(targetUrl).split('?')[0]}`
          );
          sendJson(200, { ok: true, status: result.status, text: result.text || '' });
        } catch (err) {
          console.error('[bridge] browser-fetch error:', err);
          sendJson(500, { ok: false, error: err && err.message ? err.message : String(err) });
        } finally {
          bridgeFetchLock = null;
        }
      });
      req.on('error', () => {
        try { sendJson(400, { ok: false, error: 'request error' }); } catch (e) {}
      });
    } else {
      sendJson(404, { ok: false, error: 'not found' });
    }
  });

  bridgeServer.on('error', (err) => {
    console.error('[bridge] server error:', err);
  });

  bridgeServer.listen(0, '127.0.0.1', () => {
    bridgePort = bridgeServer.address().port;
    writeMainLog(`[bridge] 桥接服务已启动 port=${bridgePort}`);
    console.log('[bridge] Electron 采集桥接服务已启动，端口:', bridgePort);
    // 轮转 logs/bridges，避免下载任务日志（现已保留）无限堆积
    try {
      const bd = path.join(userDataPath, 'logs', 'bridges');
      if (fs.existsSync(bd)) {
        const files = fs.readdirSync(bd)
          .map((n) => ({ n, t: fs.statSync(path.join(bd, n)).mtimeMs }))
          .sort((a, b) => b.t - a.t);
        for (const f of files.slice(30)) {
          try { fs.unlinkSync(path.join(bd, f.n)); } catch (e) {}
        }
      }
    } catch (e) {}
  });
}

// 「我的喜欢 / 我的收藏 / 我的合集 / 我的音乐」等自身账号下载时，前端不会传 sec_uid，
// 而应用此前也从未保存过自身 sec_uid —— 这是 sec_uid 长期获取不到的根因。
// 这里在运行时解析自身 sec_uid，按三级兜底：
//   1) 已持久化的 self_user.json（登录成功后写入）；
//   2) 用已保存 Cookie 打开登录态窗口访问 /user/self，抖音会 302 到自己的主页，
//      从最终 URL 里提取 sec_uid（服务端重定向，不依赖渲染）；
//   3) 打开首页，从页面 HTML 里正则提取 /user/<sec_uid>。
// 解析成功后立即写回 self_user.json，后续任务直接命中第 1 级。
async function resolveSelfSecUid() {
  const selfUserPath = path.join(userDataPath, 'cookies', 'self_user.json');
  try {
    if (fs.existsSync(selfUserPath)) {
      const saved = JSON.parse(fs.readFileSync(selfUserPath, 'utf-8') || '{}');
      if (saved && saved.sec_uid) return saved.sec_uid;
    }
  } catch (e) {
    console.error('[bridge] 读取 self_user.json 失败', e);
  }

  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false, // 只需取 URL / HTML，不需渲染
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, webSecurity: true },
  });
  // 静默窗口：禁止出声，避免后台解析 sec_uid 时触发媒体播放通知
  try { win.webContents.setAudioMuted(true); } catch (e) {}

  const saveSelf = (sec) => {
    try {
      fs.mkdirSync(path.join(userDataPath, 'cookies'), { recursive: true });
      fs.writeFileSync(selfUserPath, JSON.stringify({ sec_uid: sec, nickname: '', unique_id: '', saved_at: Date.now() }, null, 2), 'utf-8');
      console.log('[bridge] 已解析并保存自身 sec_uid=', sec.slice(0, 12) + '...');
    } catch (e) {
      console.error('[bridge] 保存自身 sec_uid 失败', e);
    }
  };

  try {
    win.webContents.setUserAgent(ua);
    // 注入已保存的抖音 Cookie，确保窗口处于登录态（未登录时 /user/self 不会重定向到个人主页）
    try {
      if (fs.existsSync(cookieFilePath)) {
        const unified = JSON.parse(fs.readFileSync(cookieFilePath, 'utf-8') || '{}');
        const sets = [];
        for (const [name, value] of Object.entries(unified || {})) {
          if (!name) continue;
          sets.push(win.webContents.session.cookies.set({ url: 'https://www.douyin.com', name, value: String(value), secure: true }).catch(() => {}));
        }
        await Promise.all(sets);
      }
    } catch (e) {
      console.error('[bridge] 解析自身 sec_uid：注入 Cookie 失败', e);
    }

    const candidates = ['https://www.douyin.com/user/self', 'https://www.douyin.com/'];
    for (const url of candidates) {
      try {
        await win.webContents.loadURL(url, { userAgent: ua, waitUntil: 'dom-content-loaded' });
        await new Promise((r) => setTimeout(r, 1500));
        const finalUrl = win.webContents.getURL() || '';
        let match = finalUrl.match(/\/user\/([A-Za-z0-9_\-]{20,})/);
        if (!match) {
          const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML.slice(0, 300000)');
          match = String(html || '').match(/\/user\/(MS4w[A-Za-z0-9_\-]{20,})/);
        }
        if (match && match[1]) {
          saveSelf(match[1]);
          return match[1];
        }
        writeMainLog(`[bridge] 解析自身 sec_uid：${url} 未提取到（finalUrl=${finalUrl.slice(0, 80)}）`);
      } catch (e) {
        writeMainLog(`[bridge] 解析自身 sec_uid失败 url=${url} err=${e && e.message ? e.message : String(e)}`);
      }
    }
  } finally {
    try { if (!win.isDestroyed()) win.destroy(); } catch (e) {}
  }
  return null;
}

// 用 DRaccoon 桌面端自带的真实 Chromium 打开抖音用户主页，拦截 aweme/post 接口返回，
// 通过 CDP（webContents.debugger）抓取响应体，返回作品 aweme_id / 详情 / 统计。
async function collectUserWorksViaBrowser(secUid, opts = {}) {
  const maxScrolls = Math.max(1, Number(opts.maxScrolls) || 240);
  const idleRounds = Math.max(1, Number(opts.idleRounds) || 8);
  const waitTimeoutSeconds = Math.max(30, Number(opts.waitTimeoutSeconds) || 600);
  // 静默模式说明（关键）：直接 show:false 的隐藏窗口会被 Chromium 判定为不可见，
  // 页面不渲染、懒加载/滚动不触发，CDP 根本拦截不到数据（历史实测结论）。
  // 因此"静默"改为：**窗口照常渲染，但放到屏幕外 + 不进任务栏 + 透明度 0**，
  // 用户完全看不到窗口，而页面视口/懒加载/CDP 拦截照常工作。
  // 2026-09-30：采集窗口一律静默（屏幕外渲染），不再弹出可见窗口打扰用户 ——
  // 用户反馈"总是弹出浏览器"。需要人工过验证码时，设置环境变量
  // DOUZY_SHOW_COLLECT_WINDOW=1 强制可见。
  const silentMode = String(process.env.DOUZY_SHOW_COLLECT_WINDOW || '') !== '1';
  const showWindow = true; // 始终 show:true，静默靠"移出屏幕+透明"实现，保证渲染

  // 自身账号下载（我的喜欢/收藏/合集/音乐）前端不传 sec_uid，运行时解析自身 sec_uid。
  let effectiveSecUid = secUid;
  if (!effectiveSecUid) {
    try {
      effectiveSecUid = await resolveSelfSecUid();
    } catch (e) {
      console.error('[bridge] 解析自身 sec_uid 异常', e);
    }
  }
  if (!effectiveSecUid) {
    return { ok: false, error: '缺少 secUid，且未能从登录态解析到自身账号 sec_uid：请确认已在软件内登录抖音（Cookie 有效）后重试', aweme_ids: [], items: {}, stats: {} };
  }

  // 每个 Tab 的候选页面参数 + 优先拦截的接口：
  // 抖音各 Tab 的实际接口路径变动频繁（曾出现 music/list 404、mix/aweme 403），
  // 因此除了按 kind 精确匹配，末尾再做「任意 /aweme/v1/web/ 响应里带 aweme_list」的兜底，
  // 保证接口路径换了也能采到。
  const KIND_COLLECT_CONFIG = {
    post: { tabs: [''], filters: ['/aweme/v1/web/aweme/post/'] },
    like: { tabs: ['?from_tab_name=like'], filters: ['/aweme/v1/web/aweme/favorite/'] },
    collect: {
      tabs: ['?from_tab_name=collect', '?showTab=collect'],
      filters: ['/aweme/v1/web/collects/video/list/', '/aweme/v1/web/aweme/listcollection/'],
    },
    collectmix: {
      tabs: ['?from_tab_name=collect', '?showTab=collect'],
      filters: ['/aweme/v1/web/mix/listcollection/'],
    },
    mix: {
      tabs: ['?from_tab_name=mix', '?showTab=mix'],
      filters: ['/aweme/v1/web/mix/list/', '/aweme/v1/web/mix/listcollection/', '/aweme/v1/web/mix/aweme/'],
    },
    music: {
      tabs: ['?from_tab_name=music', '?showTab=music'],
      filters: ['/aweme/v1/web/music/list/', '/aweme/v1/web/music/listcollection/', '/aweme/v1/web/music/aweme/'],
    },
  };
  const kind = KIND_COLLECT_CONFIG[opts.kind] ? String(opts.kind) : 'post';
  const kindCfg = KIND_COLLECT_CONFIG[kind];
  const candidateUrls = kindCfg.tabs.map(
    (tab) => `https://www.douyin.com/user/${effectiveSecUid}${tab}`
  );
  // 同一 kind 多个候选页逐个尝试（由末尾递归切换 tabIndex），取到数据即停。
  const tabIndex = Math.max(0, Math.min(Number(opts.tabIndex) || 0, candidateUrls.length - 1));
  const targetUrl = candidateUrls[tabIndex];
  const apiPathFilters = kindCfg.filters;
  const matchesApi = (url) => {
    if (!url || url.indexOf('/aweme/v1/web/') === -1) return false;
    if (url.indexOf('/aweme/v1/web/aweme/feed/') !== -1) return false; // 排除推荐流
    if (url.indexOf('/search/') !== -1) return false;
    for (const f of apiPathFilters) {
      if (url.indexOf(f) !== -1) return true;
    }
    // 兜底：抖音换了接口路径时，只要是 web 接口就先取回来，再由 JSON 结构判定
    return true;
  };
  const collectedIds = new Map(); // aweme_id -> item
  const stats = { post_items: 0, post_pages: 0, selected_ids: 0 };

  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    show: showWindow,
    // 静默模式：放到屏幕外（远超出任何显示器），用户看不见；窗口仍参与渲染，
    // 视口尺寸、懒加载、滚动、CDP 拦截全部照常工作 —— 这是"静默但能采到"的关键。
    ...(silentMode ? { x: -32000, y: -32000, skipTaskbar: true } : {}),
    title: 'DRaccoon 作品采集',
    icon: getWindowIconPath() || undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webSecurity: true,
    },
  });
  // 静默窗口：阻止抖音视频自动出声，避免后台采集时弹出媒体播放通知
  try { win.webContents.setAudioMuted(true); } catch (e) {}

  // 静默模式再加一层保险：完全透明，即便被搬到屏幕内也看不见。
  if (silentMode) {
    try { win.setOpacity(0); } catch (e) {}
    try { win.setSkipTaskbar(true); } catch (e) {}
  }

  let finished = false;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    try {
      if (win.webContents && !win.webContents.isDestroyed()) {
        const dbg = win.webContents.debugger;
        if (dbg && dbg.isAttached && dbg.isAttached()) {
          try { dbg.detach(); } catch (e) {}
        }
      }
    } catch (e) {}
    try { if (!win.isDestroyed()) win.destroy(); } catch (e) {}
  };

  try {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    win.webContents.setUserAgent(ua);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // 拦截非抖音导航，避免误跳转弹窗
    const isAllowed = (url) => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && (parsed.hostname === 'douyin.com' || parsed.hostname === 'www.douyin.com' || parsed.hostname.endsWith('.douyin.com'));
      } catch (e) { return false; }
    };
    win.webContents.on('will-navigate', (event, url) => {
      if (!isAllowed(url)) event.preventDefault();
    });

    const antiDetect = `(function(){ var ua='${ua.replace(/'/g, "\\'")}'; try{Object.defineProperty(navigator,'userAgent',{get:function(){return ua;}});}catch(e){} try{Object.defineProperty(navigator,'webdriver',{get:function(){return false;}});}catch(e){} try{if(window.chrome&&window.chrome.runtime){delete window.chrome.runtime;}}catch(e){} })();`;

    // ===== 关键修复：先导航、后 attach 调试器 =====
    // 旧顺序：dbg.attach('1.3') → Network.enable → loadURL。
    // 在刚创建的 about:blank 目标上 attach 后，loadURL 会触发渲染目标被替换/回收，
    // 导致紧接着的 Network.enable 抛 "target closed while handling command"，CDP 拦截全程失效。
    // 新顺序：先注入 Cookie + loadURL 让页面真正渲染（目标存活），再 attach + Network.enable，
    // 此时目标稳定，不再 target closed。首屏接口即便被 CDP 错过，也由末尾页内直读兜底。

    // 1) 注入登录 Cookie（必须在导航前，保证页面一打开即登录态）
    try {
      if (fs.existsSync(cookieFilePath)) {
        const unified = JSON.parse(fs.readFileSync(cookieFilePath, 'utf-8') || '{}');
        if (unified && typeof unified === 'object') {
          const cookieUrl = 'https://www.douyin.com';
          const sets = [];
          for (const [name, value] of Object.entries(unified)) {
            if (!name) continue;
            sets.push(
              win.webContents.session.cookies
                .set({ url: cookieUrl, name, value: String(value), secure: true })
                .catch(() => {})
            );
          }
          await Promise.all(sets);
          console.log(`[bridge] 已注入 ${sets.length} 个抖音 Cookie 到采集窗口`);
        }
      }
    } catch (e) {
      console.error('[bridge] 注入 Cookie 失败', e);
    }

    // 2) 首页预热（思路参考 parse-video-py）：先访问抖音首页刷新风控 Cookie
    //    （ttwid / UIFID / __ac_nonce 等指纹），再打开目标页。抖音会对"直接进入列表页/
    //    详情页且指纹未刷新"的请求静默拦截或只返回残缺数据，预热可显著提高采集成功率。
    try {
      await win.webContents.loadURL('https://www.douyin.com/', {
        userAgent: ua,
        waitUntil: 'domcontentloaded',
      });
      await new Promise((r) => setTimeout(r, 1200));
      writeMainLog(`[bridge] collect 首页预热完成（kind=${kind}）`);
    } catch (e) {
      writeMainLog(`[bridge] collect 首页预热失败（忽略，继续）：${e && e.message}`);
    }

    // 3) 导航到目标页并等待渲染（此时渲染目标已存活，CDP 尚未 attach）
    try {
      await win.webContents.loadURL(targetUrl, { userAgent: ua, waitUntil: 'domcontentloaded' });
    } catch (e) {
      console.error('[bridge] 加载主页失败', e);
    }
    try { await win.webContents.executeJavaScript(antiDetect); } catch (e) {}
    // 首屏接口与懒加载的稳定等待，给页面时间发起第一个 aweme 请求（CDP 尚未 attach，由末尾页内直读兜底）
    await new Promise((r) => setTimeout(r, 4000));

    // 3) 页面已加载、目标稳定，再 attach 调试器并启用 Network 拦截
    const dbg = win.webContents.debugger;
    try {
      dbg.attach('1.3');
    } catch (e) {
      cleanup();
      return { ok: false, error: `debugger attach 失败: ${e.message}`, aweme_ids: [], items: {}, stats };
    }
    dbg.on('message', (event, method, params) => {
      if (method === 'Network.responseReceived') {
        const resp = (params && params.response) || {};
            const url = resp.url || '';
            if (matchesApi(url)) {
          dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId })
            .then(({ body, base64Encoded }) => {
              let text = body || '';
              if (base64Encoded) {
                try { text = Buffer.from(body, 'base64').toString('utf-8'); } catch (e) {}
              }
              try {
                const data = JSON.parse(text);
                const list = data && data.aweme_list;
                if (Array.isArray(list)) {
                  stats.post_pages += 1;
                  for (const item of list) {
                    if (!item || typeof item !== 'object') continue;
                    const id = item.aweme_id ? String(item.aweme_id) : null;
                    if (!id) continue;
                    if (!collectedIds.has(id)) {
                      collectedIds.set(id, item);
                      stats.post_items += 1;
                    }
                  }
                }
              } catch (e) {}
            })
            .catch(() => {});
        }
      }
    });
    try {
      await dbg.sendCommand('Network.enable');
    } catch (e) {
      cleanup();
      return { ok: false, error: `Network.enable 失败: ${e.message}`, aweme_ids: [], items: {}, stats };
    }
    writeMainLog(`[bridge] collect 调试器已 attach 且 Network.enable ok（kind=${kind}）`);

    // 首屏接口（aweme/post、aweme/favorite 等）在 loadURL 后、attach 前已发出，CDP 错过。
    // reload 让其在 CDP 监听下重放，从而抓到完整 aweme_list（含 video.play_addr /
    // image_post_info 等下载地址）——否则只能拿到 DOM 兜底的空 id，下载阶段无地址可下。
    // （2026-10-01 起抖音把"页内注入 XHR/直连"全封 403，唯一可靠的完整 aweme 来源就是
    //  页面自身加载时发出的接口，必须在 CDP 监听下重放才能截获。）
    try {
      await win.webContents.reload();
      writeMainLog(`[bridge] collect 已 reload 重放首屏请求（kind=${kind}）`);
    } catch (e) {
      writeMainLog(`[bridge] collect reload 失败：${e && e.message}`);
    }
    await new Promise((r) => setTimeout(r, 4500));

    // 关键修复（2026-10-03）：离屏窗口会被 Chromium 视为 occluded/hidden，
    // 抖音首页的 IntersectionObserver 懒加载不会触发 —— 此前每次采集只抓到首屏约 8 条就因
    // idleRounds 提前停止，导致"同步/下载不全"。这里在滚动采集前把窗口移回屏幕内
    // （保持 opacity:0 对用户不可见、ignoreMouseEvents 不挡点击），让懒加载正常翻页，
    // 从而抓到完整作品列表。这是绕过 Argus 风控的关键：数据全部来自真实浏览器自身加载。
    if (silentMode) {
      try { win.setIgnoreMouseEvents(true); } catch (e) {}
      try { win.setOpacity(0); } catch (e) {}
      try { win.setPosition(60, 60); } catch (e) {}
    }

    // 滚动采集循环
    // 2026-10-10 关键修复：抖音改版后页面改为内部容器滚动（.route-scroll-container），
    // documentElement.scrollHeight 恒等于视口高（实测 840），window.scrollTo 完全无效 ——
    // 此前每次采集只抓到首屏约 8 条就提前退出（ids 恒为 8 的真正根因，与窗口可见性无关）。
    // 修复：滚动目标改为「路由容器优先 + window 兜底」，且高度监测取同一容器的
    // scrollHeight（否则稳定性判定永远成立，几轮后就 break）。
    const scrollStepJs = `(function(){
      var c = document.querySelector('.route-scroll-container');
      if (c && c.scrollHeight > c.clientHeight) {
        c.scrollTop = c.scrollHeight;
        return JSON.stringify({ via: 'container', sh: c.scrollHeight, st: c.scrollTop });
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
      return JSON.stringify({ via: 'window', sh: document.documentElement.scrollHeight });
    })()`;
    const measureHeightJs = `(function(){
      var c = document.querySelector('.route-scroll-container');
      if (c && c.scrollHeight > c.clientHeight) return c.scrollHeight;
      return document.documentElement.scrollHeight;
    })()`;
    let lastHeight = 0;
    let domStable = 0;
    let lastCount = 0;
    let countStable = 0;
    const deadline = Date.now() + waitTimeoutSeconds * 1000;
    for (let i = 0; i < maxScrolls; i++) {
      if (Date.now() > deadline) break;
      if (win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) break;
      try {
        const sr = await win.webContents.executeJavaScript(scrollStepJs);
        if (i === 0 || i % 10 === 0) {
          writeMainLog(`[bridge] collect 滚动 step=${i} ${sr}（kind=${kind}）`);
        }
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 2500));
      let height = lastHeight;
      try {
        height = Number(await win.webContents.executeJavaScript(measureHeightJs)) || lastHeight;
      } catch (e) {}
      if (height === lastHeight) domStable += 1; else { domStable = 0; lastHeight = height; }

      const count = collectedIds.size;
      if (count === lastCount) countStable += 1; else { countStable = 0; lastCount = count; }

      // 页面高度稳定且连续无新内容则停止：无论 CDP 是否已采到，末尾页内直读都会兜底，
      // 避免单页/少量作品账号空转滚到 deadline（此前 count>0 条件会让单页账号白滚 ~10 分钟）。
      if (domStable >= idleRounds && countStable >= idleRounds) break;
    }

    // 结束前再等待未完成的响应解析，并做一次"页面内直读"抽取。
    // 借鉴 douyin-dl 用户脚本：直接从已渲染卡片的 React 数据(props.awemeInfo / itemInfo)
    // 里取 aweme 对象，天然带 playAddr 下载地址，无需再请求详情接口。与 CDP 拦截互补：
    // CDP 为主、页内直读补漏并补全可下载地址。
    await new Promise((r) => setTimeout(r, 2000));
    let domMap = {};
    try {
      domMap = await win.webContents.executeJavaScript(`(function(){
        function pick(o, keys){ var r={}; if(!o||typeof o!=='object') return r; keys.forEach(function(k){ if(o[k]!==undefined) r[k]=o[k]; }); return r; }
        function findAweme(node){
          if(!node) return null;
          for(var d=0; d<4; d++){
            node = node.parentNode;
            if(!node) break;
            var rk = null;
            for(var k in node){ if(k.indexOf('__reactProps$')===0){ rk=k; break; } }
            if(rk){
              var p = node[rk] || {};
              var a = p.awemeInfo || (p.itemInfo && (p.itemInfo.awemeInfo||p.itemInfo)) || p.aweme || null;
              if(a && (a.awemeId || (a.video&&a.video.awemeId))) return a;
            }
          }
          return null;
        }
        var out = {};
        var cards = document.querySelectorAll('a[href*="/video/"], a[href*="/note/"], [data-e2e="user-post-item"]');
        for(var i=0;i<cards.length;i++){
          var card = cards[i];
          var href = card.getAttribute('href') || '';
          var awemeId = null;
          var mm = href.match(/\\/(?:video|note)\\/(\\d+)/);
          if(mm) awemeId = mm[1];
          var aweme = findAweme(card);
          if(!awemeId && aweme) awemeId = aweme.awemeId || (aweme.video&&aweme.video.awemeId);
          if(!awemeId) continue;
          awemeId = String(awemeId);
          if(out[awemeId]) continue;
          if(aweme){
            out[awemeId] = {
              awemeId: awemeId,
              desc: aweme.desc || '',
              createTime: aweme.createTime || aweme.create_time || 0,
              author: pick(aweme.author || {}, ['sec_uid','nickname','unique_id','uid']),
              video: pick(aweme.video || {}, ['playAddr','bitRate','playApi','cover','originCover','duration']),
              music: pick(aweme.music || {}, ['playUrl','title','author']),
              statistics: pick(aweme.statistics || {}, ['diggCount','commentCount','shareCount','collectCount'])
            };
          } else {
            out[awemeId] = { awemeId: awemeId };
          }
        }
        return out;
      })()`);
    } catch (e) {}
    if (domMap && typeof domMap === 'object') {
      const hasUrl = (o) => o && ((o.video && Array.isArray(o.video.playAddr) && o.video.playAddr.length) || (o.video && o.video.playApi));
      for (const [id, domItem] of Object.entries(domMap)) {
        if (!collectedIds.has(id)) {
          collectedIds.set(id, domItem);
        } else {
          // CDP 条目缺少可下载地址、而页内条目有时，补全 video 下载信息（保留 CDP 其它字段）
          const existing = collectedIds.get(id);
          if (!hasUrl(existing) && hasUrl(domItem)) {
            if (!existing.video) existing.video = {};
            if (Array.isArray(domItem.video && domItem.video.playAddr)) existing.video.playAddr = domItem.video.playAddr;
            if (domItem.video && domItem.video.playApi) existing.video.playApi = domItem.video.playApi;
            if (Array.isArray(domItem.video && domItem.video.bitRate)) existing.video.bitRate = domItem.video.bitRate;
          }
        }
      }
    }

    const aweme_ids = Array.from(collectedIds.keys());
    const items = {};
    for (const [id, item] of collectedIds.entries()) {
      items[id] = item;
    }
    stats.selected_ids = aweme_ids.length;

    cleanup();
    // 该 kind 配了多个候选 Tab 时，当前页没采到数据就换下一个候选页再试一次
    if (aweme_ids.length === 0 && tabIndex + 1 < candidateUrls.length) {
      writeMainLog(
        `[bridge] collect kind=${kind} 候选页 ${tabIndex + 1}/${candidateUrls.length} 未采到数据，尝试下一个候选页`
      );
      return await collectUserWorksViaBrowser(secUid, { ...opts, tabIndex: tabIndex + 1 });
    }
    return { ok: true, aweme_ids, items, stats };
  } catch (err) {
    cleanup();
    return { ok: false, error: err && err.message ? err.message : String(err), aweme_ids: [], items: {}, stats };
  }
}

// 用 DRaccoon 桌面端自带的真实 Chromium 打开抖音单作品详情页（/video/{awemeId} 或 /note/{awemeId}），
// 拦截 aweme/detail 接口返回，并从页面 SSR / React props 中提取完整 aweme 对象，返回给后端下载器。
async function collectAwemeDetailViaBrowser(awemeId, opts = {}) {
  const waitTimeoutSeconds = Math.max(30, Number(opts.waitTimeoutSeconds) || 120);
  // 静默模式说明（与 collectUserWorksViaBrowser 同一结论，历史实测 36/37 失败的根因）：
  // 直接 show:false 的隐藏窗口会被 Chromium 判定为不可见 —— 页面不渲染、JS 不执行、
  // 接口不发、React 水合数据也没有，详情页详情必然取不到。
  // 因此"静默"改为：**窗口照常渲染，但放到屏幕外 + 不进任务栏 + 透明度 0**。
  const forceVisible = !!opts.forceVisible;
  const silentMode = !forceVisible && String(process.env.DOUZY_SHOW_COLLECT_WINDOW || '') !== '1';

  if (!awemeId) {
    return { ok: false, error: '缺少 awemeId', detail: null };
  }

  const targetUrls = [
    `https://www.douyin.com/video/${awemeId}`,
    `https://www.douyin.com/note/${awemeId}`,
  ];

  let detail = null;

  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    // 始终 show:true，静默靠"移出屏幕+透明"实现，保证页面真的渲染
    show: true,
    ...(silentMode ? { x: -32000, y: -32000, skipTaskbar: true } : {}),
    title: 'DRaccoon 作品详情采集',
    icon: getWindowIconPath() || undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webSecurity: true,
    },
  });
  // 静默/隐藏窗口：阻止详情页视频自动出声+媒体通知
  try { win.webContents.setAudioMuted(true); } catch (e) {}
  if (silentMode) {
    try { win.setOpacity(0); } catch (e) {}
    try { win.setSkipTaskbar(true); } catch (e) {}
  }

  let finished = false;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    try {
      if (win.webContents && !win.webContents.isDestroyed()) {
        const dbg = win.webContents.debugger;
        if (dbg && dbg.isAttached && dbg.isAttached()) {
          try { dbg.detach(); } catch (e) {}
        }
      }
    } catch (e) {}
    try { if (!win.isDestroyed()) win.destroy(); } catch (e) {}
  };

  try {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    win.webContents.setUserAgent(ua);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    const isAllowed = (url) => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && (parsed.hostname === 'douyin.com' || parsed.hostname === 'www.douyin.com' || parsed.hostname.endsWith('.douyin.com'));
      } catch (e) { return false; }
    };
    win.webContents.on('will-navigate', (event, url) => {
      if (!isAllowed(url)) event.preventDefault();
    });

    const antiDetect = `(function(){ var ua='${ua.replace(/'/g, "\\'")}'; try{Object.defineProperty(navigator,'userAgent',{get:function(){return ua;}});}catch(e){} try{Object.defineProperty(navigator,'webdriver',{get:function(){return false;}});}catch(e){} try{if(window.chrome&&window.chrome.runtime){delete window.chrome.runtime;}}catch(e){} })();`;

    // ===== 关键修复：先导航、后 attach 调试器（同 collectUserWorksViaBrowser）=====
    // 旧顺序 attach → Network.enable → loadURL 会在 about:blank 目标上 attach 后，
    // 被 loadURL 触发的渲染目标替换/回收，导致 Network.enable 报 "target closed"。
    // 改为先注入 Cookie + 依次 loadURL 目标页，再 attach + Network.enable；首个详情请求
    // 即便被 CDP 错过，也由下方页内直读兜底。
    // 1) 注入登录 Cookie（导航前）
    try {
      if (fs.existsSync(cookieFilePath)) {
        const unified = JSON.parse(fs.readFileSync(cookieFilePath, 'utf-8') || '{}');
        if (unified && typeof unified === 'object') {
          const cookieUrl = 'https://www.douyin.com';
          const sets = [];
          for (const [name, value] of Object.entries(unified)) {
            if (!name) continue;
            sets.push(
              win.webContents.session.cookies
                .set({ url: cookieUrl, name, value: String(value), secure: true })
                .catch(() => {})
            );
          }
          await Promise.all(sets);
          console.log(`[bridge] 已注入 ${sets.length} 个抖音 Cookie 到详情窗口`);
        }
      }
    } catch (e) {
      console.error('[bridge] 详情窗口注入 Cookie 失败', e);
    }

    const deadline = Date.now() + waitTimeoutSeconds * 1000;
    let attached = false;
    const dbg = win.webContents.debugger;

    // 首页预热（同 collectUserWorksViaBrowser）：刷新风控 Cookie / 指纹，
    // 避免详情页的 aweme/detail 接口被静默拦截。
    try {
      await win.webContents.loadURL('https://www.douyin.com/', {
        userAgent: ua,
        waitUntil: 'domcontentloaded',
      });
      await new Promise((r) => setTimeout(r, 1200));
      writeMainLog('[bridge] detail 首页预热完成');
    } catch (e) {
      writeMainLog(`[bridge] detail 首页预热失败（忽略，继续）：${e && e.message}`);
    }

    for (const targetUrl of targetUrls) {
      if (Date.now() > deadline) break;
      if (win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) break;
      if (detail) break;

      try {
        await win.webContents.loadURL(targetUrl, { userAgent: ua, waitUntil: 'domcontentloaded' });
      } catch (e) {
        console.error('[bridge] 加载详情页失败', targetUrl, e);

        continue;
      }
      try { await win.webContents.executeJavaScript(antiDetect); } catch (e) {}

      // 首次导航成功后再 attach 调试器（此时渲染目标稳定，不再 target closed）
      if (!attached) {
        try {
          dbg.attach('1.3');
          attached = true;
        } catch (e) {
          writeMainLog(`[bridge] detail debugger attach 失败: ${e && e.message ? e.message : e}`);
        }
        dbg.on('message', (event, method, params) => {
          if (method === 'Network.responseReceived') {
            const resp = (params && params.response) || {};
            const url = resp.url || '';
            if (url.indexOf('/aweme/v1/web/aweme/detail/') !== -1) {
              dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId })
                .then(({ body, base64Encoded }) => {
                  let text = body || '';
                  if (base64Encoded) {
                    try { text = Buffer.from(body, 'base64').toString('utf-8'); } catch (e) {}
                  }
              try {
                const data = JSON.parse(text);
                const item = data && (data.aweme_detail || (data.item_list && data.item_list[0]));
                if (item && typeof item === 'object') {
                  detail = item;
                  writeMainLog(`[bridge] detail CDP 捕获 aweme/detail 响应 awemeId=${awemeId}`);
                }
              } catch (e) {}
                })
                .catch(() => {});
            }
          }
        });
        try {
          await dbg.sendCommand('Network.enable');
          writeMainLog('[bridge] detail 调试器已 attach 且 Network.enable ok');
          // ===== 关键修复（2026-09-30 探针实证）=====
          // 抖音视频页会在首次渲染时立刻发出 /aweme/v1/web/aweme/detail/（200、含 aweme_detail），
          // 而 CDP 只能在 loadURL 完成后才能 attach —— 详情请求永远发生在监听开始之前，必然错过。
          // 页面水合数据（_ROUTER_DATA/RENDER_DATA/__pace_f）里都没有完整 aweme 对象（实测均取不到）。
          // 因此 attach + Network.enable 之后立刻 reload 一次，让详情请求在 CDP 监听下重放。
          try {
            await win.webContents.reload();
            await new Promise((r) => setTimeout(r, 2500));
          } catch (e) {
            writeMainLog(`[bridge] detail reload 失败: ${e && e.message ? e.message : e}`);
          }
        } catch (e) {
          writeMainLog(`[bridge] detail Network.enable 失败: ${e && e.message ? e.message : e}`);
        }
      }

      // 轮询等待 detail：CDP 捕获或页内直读任一命中即返回（每 500ms 一次，单页最多 15s，
      // reload 重放需要额外时间，从 12s 放宽到 15s），避免固定 sleep 既等太久又可能错过时机。
      const pollDeadline = Date.now() + 15000;
      while (Date.now() < pollDeadline) {
        if (detail) break;
        if (win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) break;

        // 页内直读：覆盖抖音现行水合数据（_ROUTER_DATA / __pace_f / RENDER_DATA）+
        // 旧版 SSR 全局 + React props / fiber，从中找匹配 awemeId 且含 video 的对象
        try {
          const pageDetail = await win.webContents.executeJavaScript(`(function(){
            var awemeId = ${JSON.stringify(String(awemeId))};
            function matchId(id){ return id!==undefined && id!==null && String(id)===String(awemeId); }
            function deepFind(obj, depth){
              depth = depth || 0;
              if(depth>16 || !obj || typeof obj!=='object') return null;
              if(Array.isArray(obj)){
                for(var i=0;i<obj.length;i++){ var f=deepFind(obj[i],depth+1); if(f) return f; }
                return null;
              }
              if(matchId(obj.aweme_id||obj.awemeId) && obj.video) return obj;
              if(obj.awemeInfo && matchId(obj.awemeInfo.awemeId||obj.awemeInfo.aweme_id)) return obj.awemeInfo;
              if(obj.aweme_detail && matchId(obj.aweme_detail.aweme_id||obj.aweme_detail.awemeId)) return obj.aweme_detail;
              for(var k in obj){ var f=deepFind(obj[k],depth+1); if(f) return f; }
              return null;
            }
            var sources = [window._ROUTER_DATA, window.__pace_f, window._SSR_HYDRATED_DATA, window.__INITIAL_STATE__, window.__INITIAL_DATA__, window.render_data];
            for(var i=0;i<sources.length;i++){ var f=deepFind(sources[i]); if(f) return f; }
            try {
              var rd = document.querySelector('script#RENDER_DATA');
              if (rd && rd.textContent) {
                var pj = JSON.parse(decodeURIComponent(rd.textContent));
                var rf = deepFind(pj);
                if (rf) return rf;
              }
            } catch(e) {}
            var all = document.querySelectorAll('*');
            var props = [];
            for(var i=0;i<all.length;i++){
              var el = all[i];
              for(var k in el){
                if(k.indexOf('__reactProps$')===0 || k.indexOf('__reactInternalInstance$')===0){
                  props.push(el[k]);
                }
              }
            }
            for(var i=0;i<props.length;i++){ var f=deepFind(props[i]); if(f) return f; }
            return null;
          })()`);
          if (pageDetail && typeof pageDetail === 'object' && (pageDetail.video || pageDetail.aweme_id || pageDetail.awemeId)) {
            detail = pageDetail;
            break;
          }
        } catch (e) {}
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    cleanup();
    if (!detail) {
      // 失败重试分级（尽量不打扰用户）：
      // 1) 先静默重建窗口再试一次（reload 重放偶发失败时有效）；
      // 2) 仍失败才弹可见窗口重试（个别环境屏幕外渲染不可用）。
      if (silentMode && !opts._silentRetry) {
        writeMainLog(`[bridge] detail 静默窗口未取到详情，静默重建重试一次 awemeId=${awemeId}`);
        const retrySilent = await collectAwemeDetailViaBrowser(awemeId, {
          ...opts,
          _silentRetry: true,
        });
        if (retrySilent && retrySilent.ok) return retrySilent;
      }
      if (silentMode && !opts._visibleRetry) {
        writeMainLog(`[bridge] detail 静默重试仍失败，最后改用可见窗口重试 awemeId=${awemeId}`);
        const retry = await collectAwemeDetailViaBrowser(awemeId, {
          ...opts,
          _visibleRetry: true,
          forceVisible: true,
        });
        if (retry && retry.ok) return retry;
      }
      return { ok: false, error: '未能从页面或接口获取作品详情', detail: null };
    }
    return { ok: true, detail };
  } catch (err) {
    cleanup();
    return { ok: false, error: err && err.message ? err.message : String(err), detail: null };
  }
}

// 通用页面通道：在桌面端内置的抖音登录窗口（已注入 Cookie）内，用 page SDK 代为发起
// 带签名的接口请求，从而绕过 ArgusSecurityPlugin 对直连请求的 403 门禁。对标上游 Douzy
// 的 page_bridge.fetch(path, params)。
// 实测（2026-09-19 main.log，port=17903）：SDK 并不会自动给注入的 window.fetch 补签名，
// 全部 403"页面 SDK 未给注入 fetch 补签名"。因此改为三级降级：
//   1) 页面内 XHR（字节系 SDK 部分版本 hook XMLHttpRequest 补签名）；
//   2) 页面内 fetch（原方案，保留兜底）；
//   3) 直接导航到已签名 API URL —— 浏览器顶层导航无法附加自定义头，Argus 对 document
//      导航通常不做 x-secsdk-web-signature 校验，用 document.body.innerText 读 JSON 响应。
// 使用常驻隐藏窗口复用（分页类接口会连续调用几十次，不能每次都重载 douyin.com）。
let bridgeFetchWindow = null;
let bridgeFetchReady = false;
let bridgeFetchWindowUa = '';
let bridgeNavWindow = null;

async function getBridgeFetchWindow(signUa) {
  const alive = bridgeFetchWindow
    && !bridgeFetchWindow.isDestroyed()
    && bridgeFetchWindow.webContents
    && !bridgeFetchWindow.webContents.isDestroyed();
  if (alive && signUa && bridgeFetchWindowUa && bridgeFetchWindowUa !== signUa) {
    // a_bogus 与签名时的 UA 绑定：UA 变化必须销毁重建，否则服务端校验必然失败
    try { bridgeFetchWindow.destroy(); } catch (e) {}
    bridgeFetchWindow = null;
    bridgeFetchReady = false;
    return getBridgeFetchWindow(signUa);
  }
  if (alive) {
    try {
      const currentUrl = bridgeFetchWindow.webContents.getURL() || '';
      if (currentUrl.indexOf('douyin.com') !== -1) return bridgeFetchWindow;
    } catch (e) {}
  }
  // 重建
  try { if (bridgeFetchWindow && !bridgeFetchWindow.isDestroyed()) bridgeFetchWindow.destroy(); } catch (e) {}
  bridgeFetchWindow = null;
  bridgeFetchReady = false;

  const showWindow = !!process.env.DOUZY_SHOW_COLLECT_WINDOW;
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    show: showWindow,
    title: 'DRaccoon 页面通道',
    icon: getWindowIconPath() || undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webSecurity: true,
    },
  });
  // 静默/隐藏窗口：阻止抖音视频自动出声+媒体通知
  try { win.webContents.setAudioMuted(true); } catch (e) {}

  win.on('closed', () => {
    if (bridgeFetchWindow === win) {
      bridgeFetchWindow = null;
      bridgeFetchReady = false;
    }
  });

  const ua = signUa || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  bridgeFetchWindowUa = ua;
  win.webContents.setUserAgent(ua);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const isAllowed = (url) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && (parsed.hostname === 'douyin.com' || parsed.hostname === 'www.douyin.com' || parsed.hostname.endsWith('.douyin.com'));
    } catch (e) { return false; }
  };
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowed(url)) event.preventDefault();
  });

  const antiDetect = `(function(){ var ua='${ua.replace(/'/g, "\\'")}'; try{Object.defineProperty(navigator,'userAgent',{get:function(){return ua;}});}catch(e){} try{Object.defineProperty(navigator,'webdriver',{get:function(){return false;}});}catch(e){} try{if(window.chrome&&window.chrome.runtime){delete window.chrome.runtime;}}catch(e){} })();`;

  // 注入已保存的抖音登录 Cookie，确保页面处于登录态
  try {
    if (fs.existsSync(cookieFilePath)) {
      const unified = JSON.parse(fs.readFileSync(cookieFilePath, 'utf-8') || '{}');
      if (unified && typeof unified === 'object') {
        const cookieUrl = 'https://www.douyin.com';
        const sets = [];
        for (const [name, value] of Object.entries(unified)) {
          if (!name) continue;
          sets.push(
            win.webContents.session.cookies
              .set({ url: cookieUrl, name, value: String(value), secure: true })
              .catch(() => {})
          );
        }
        await Promise.all(sets);
      }
    }
  } catch (e) {
    console.error('[bridge] 页面通道注入 Cookie 失败', e);
  }

  // 加载 douyin.com 让风控 SDK 初始化（约 1.8s，仅在窗口创建时执行一次）
  await win.webContents.loadURL('https://www.douyin.com', { userAgent: ua, waitUntil: 'domcontentloaded' });
  try { await win.webContents.executeJavaScript(antiDetect); } catch (e) {}
  await new Promise((r) => setTimeout(r, 1800));

  // 用户实测：隐藏窗口里风控 SDK 常常不初始化（表现为 Argus 403），而"打开可见窗口再关闭"
  // 即可正常取到数据。因此轮询等待 SDK/风控 Cookie 就绪，超时则短暂显示窗口强制激活。
  const sdkReadyProbe = async () => {
    try {
      const cks = await win.webContents.session.cookies.get({ url: 'https://www.douyin.com' });
      const names = new Set((cks || []).map((c) => String(c.name || '').toLowerCase()));
      if (names.has('uifid') && names.has('__security_mc_1_s_sdk_crypt_sdk')) return true;
    } catch (e) {}
    try {
      const v = await win.webContents.executeJavaScript(
        `(function(){try{return !!(window.byted_acrawler||window.__security_mc_1_s_sdk||window._bytedSecSdk);}catch(e){return false;}})()`
      );
      return !!v;
    } catch (e) { return false; }
  };

  let sdkReady = false;
  for (let i = 0; i < 8; i++) {
    sdkReady = await sdkReadyProbe();
    if (sdkReady) break;
    await new Promise((r) => setTimeout(r, 1200));
  }
  if (!sdkReady && !showWindow) {
    writeMainLog('[bridge] 隐藏窗口内风控 SDK 未就绪，短暂显示窗口以激活 SDK');
    try { win.show(); win.focus(); } catch (e) {}
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 1200));
      sdkReady = await sdkReadyProbe();
      if (sdkReady) break;
    }
    try { win.hide(); } catch (e) {}
  }

  // 把窗口会话里刷新后的风控 Cookie（uifid / sec-sdk）回写到统一 cookie 文件，供后续任务复用
  try {
    const ck = await win.webContents.session.cookies.get({ url: 'https://www.douyin.com' });
    if (ck && ck.length) {
      writeUnifiedCookies(ck.map((c) => `${c.name}=${c.value}`).join('; '));
      writeMainLog(`[bridge] 已回写窗口会话 Cookie count=${ck.length}`);
    }
  } catch (e) {
    console.error('[bridge] 回写会话 Cookie 失败', e);
  }

  writeMainLog(`[bridge] 页面通道窗口就绪 sdkReady=${sdkReady} ua=${String(ua).slice(0, 40)}`);
  bridgeFetchWindow = win;
  bridgeFetchReady = true;
  return win;
}

// 第三级降级：直接把已签名的 API URL 当作页面导航加载（隐藏窗口），
// 响应 JSON 会渲染为 document.body 文本，直接读出。
// 顶层导航无法附加自定义请求头，因此 Argus 对 document 导航通常不做 secsdk 签名校验。
async function fetchViaNavigation(targetUrl, signUa) {
  try {
    let win = bridgeNavWindow;
    if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) {
      win = new BrowserWindow({
        width: 1024,
        height: 768,
        show: !!process.env.DOUZY_SHOW_COLLECT_WINDOW,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
          webSecurity: true,
        },
      });
      // 静默/隐藏窗口：阻止抖音视频自动出声+媒体通知
      try { win.webContents.setAudioMuted(true); } catch (e) {}
      win.on('closed', () => {
        if (bridgeNavWindow === win) bridgeNavWindow = null;
      });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      bridgeNavWindow = win;
    }
    const ua = signUa || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    try { win.webContents.setUserAgent(ua); } catch (e) {}
    await win.loadURL(targetUrl, { userAgent: ua });
    await new Promise((r) => setTimeout(r, 600));
    let text = '';
    try {
      text = await win.webContents.executeJavaScript('(document.body && document.body.innerText) || ""');
    } catch (e) {
      text = '';
    }
    const t = String(text || '');
    let status = 0;
    if (t.indexOf('ArgusSecurityPlugin') !== -1) {
      status = 403;
    } else if (t.trim()) {
      try { JSON.parse(t); status = 200; } catch (e) { status = 0; }
    }
    return { status, text: t };
  } catch (e) {
    return { status: 0, text: '', error: String(e) };
  }
}

async function fetchViaPageBridge(targetUrl, signUa) {
  const xhrScript = `(async function(){
    try {
      var r = await new Promise(function(resolve){
        try {
          var xhr = new XMLHttpRequest();
          xhr.open('GET', ${JSON.stringify(targetUrl)}, true);
          xhr.withCredentials = true;
          xhr.timeout = 30000;
          xhr.onload = function(){ resolve({ status: xhr.status, text: xhr.responseText }); };
          xhr.onerror = function(){ resolve({ status: 0, text: '' }); };
          xhr.ontimeout = function(){ resolve({ status: 0, text: '' }); };
          xhr.send(null);
        } catch (e) { resolve({ status: -1, text: '', error: String(e) }); }
      });
      return r;
    } catch (e) { return { status: -1, text: '', error: String(e) }; }
  })()`;
  const fetchScript = `(async function(){
    try {
      var r = await fetch(${JSON.stringify(targetUrl)}, { credentials: 'include', headers: { 'Accept': 'application/json' } });
      var t = await r.text();
      return { status: r.status, text: t };
    } catch (e) {
      return { status: -1, text: '', error: String(e) };
    }
  })()`;

  const isOk = (r) => r
    && Number(r.status) === 200
    && String(r.text || '').indexOf('ArgusSecurityPlugin') === -1
    && String(r.text || '').trim().length > 0;

  try {
    let win = await getBridgeFetchWindow(signUa);
    let result = null;
    try {
      // 1) 页面内 XHR：部分字节系 SDK hook XMLHttpRequest 自动补签名
      result = await win.webContents.executeJavaScript(xhrScript);
      if (isOk(result)) {
        writeMainLog(`[bridge] 页面通道成功(XHR) len=${String(result.text).length} path=${String(targetUrl).split('?')[0]}`);
        return { status: 200, text: result.text };
      }
      // 2) 页面内 fetch：原方案兜底
      result = await win.webContents.executeJavaScript(fetchScript);
      if (isOk(result)) {
        writeMainLog(`[bridge] 页面通道成功(fetch) len=${String(result.text).length} path=${String(targetUrl).split('?')[0]}`);
        return { status: 200, text: result.text };
      }
    } catch (e) {
      // 页面可能已 crash / 失效：销毁后重建一次再试
      try { if (!win.isDestroyed()) win.destroy(); } catch (e2) {}
      bridgeFetchWindow = null;
      bridgeFetchReady = false;
      try {
        win = await getBridgeFetchWindow(signUa);
        result = await win.webContents.executeJavaScript(xhrScript);
        if (isOk(result)) return { status: 200, text: result.text };
        result = await win.webContents.executeJavaScript(fetchScript);
        if (isOk(result)) return { status: 200, text: result.text };
      } catch (e3) {}
    }
    // 3) 导航降级：直接加载签名 URL 读取响应体
    const nav = await fetchViaNavigation(targetUrl, signUa);
    if (isOk(nav)) {
      writeMainLog(`[bridge] 页面通道成功(导航) len=${String(nav.text).length} path=${String(targetUrl).split('?')[0]}`);
      return { status: 200, text: nav.text };
    }
    const last = (result && Number(result.status) !== 0) ? result : nav;
    const text = (last && last.text) || '';
    if (String(text).indexOf('ArgusSecurityPlugin') !== -1) {
      writeMainLog(
        `[bridge] 页面通道三级尝试均被 Argus 拒绝 status=${(last && last.status) || 0} ` +
        `path=${String(targetUrl).split('?')[0]}`
      );
    } else {
      writeMainLog(
        `[bridge] 页面通道三级尝试均失败 xhrFetchStatus=${(result && result.status) || 0} ` +
        `navStatus=${(nav && nav.status) || 0} path=${String(targetUrl).split('?')[0]}`
      );
    }
    return { status: (last && last.status) || 0, text };
  } catch (err) {
    console.error('[bridge] 页面通道请求异常', err);
    return { status: 0, text: '' };
  }
}

// 批量页面通道：在同一个已就绪的 douyin.com 页面内并发发起多个签名 URL 请求。
// 用于「作品详情补拉」——此前每个作品都要新开一个 Chromium 窗口去抓 aweme/detail，
// 单条 20s 起且频繁失败；改为页内并发 XHR 后，几十条详情通常数秒内完成、全程无窗口。
async function fetchBatchViaPageBridge(items, signUa, concurrencyRaw) {
  const list = Array.isArray(items) ? items : [];
  const out = {};
  if (!list.length) return out;
  const limit = Math.max(1, Math.min(8, Number(concurrencyRaw) || 5));
  const script = `(async function(){
    var items = ${JSON.stringify(list)};
    var limit = ${limit};
    function one(it){
      return new Promise(function(resolve){
        try {
          var xhr = new XMLHttpRequest();
          xhr.open('GET', it.url, true);
          xhr.withCredentials = true;
          xhr.timeout = 30000;
          xhr.onload = function(){ resolve({ key: it.key, status: xhr.status, text: xhr.responseText || '' }); };
          xhr.onerror = function(){ resolve({ key: it.key, status: 0, text: '' }); };
          xhr.ontimeout = function(){ resolve({ key: it.key, status: 0, text: '' }); };
          xhr.send(null);
        } catch (e) {
          resolve({ key: it.key, status: -1, text: '', error: String(e) });
        }
      });
    }
    var queue = items.slice();
    var results = [];
    async function worker(){
      while (queue.length) {
        var it = queue.shift();
        if (!it) break;
        try { results.push(await one(it)); } catch (e) { results.push({ key: it.key, status: -1, text: '' }); }
      }
    }
    var workers = [];
    for (var i = 0; i < limit; i++) workers.push(worker());
    await Promise.all(workers);
    return results;
  })()`;

  try {
    let win = await getBridgeFetchWindow(signUa);
    let arr = null;
    try {
      arr = await win.webContents.executeJavaScript(script);
    } catch (e) {
      // 页面可能 crash / 失效：销毁后重建一次再试
      try { if (!win.isDestroyed()) win.destroy(); } catch (e2) {}
      bridgeFetchWindow = null;
      bridgeFetchReady = false;
      try {
        win = await getBridgeFetchWindow(signUa);
        arr = await win.webContents.executeJavaScript(script);
      } catch (e3) {
        arr = null;
      }
    }
    if (Array.isArray(arr)) {
      for (const entry of arr) {
        if (!entry || entry.key === undefined) continue;
        const text = String(entry.text || '');
        const ok = Number(entry.status) === 200 && text.indexOf('ArgusSecurityPlugin') === -1 && text.trim().length > 0;
        out[String(entry.key)] = { status: ok ? 200 : (Number(entry.status) || 0), text };
      }
    }
  } catch (err) {
    console.error('[bridge] 批量页面通道异常', err);
  }
  // 未返回的补空结果，便于调用方识别并回退
  for (const it of list) {
    if (out[String(it.key)] === undefined) out[String(it.key)] = { status: 0, text: '' };
  }
  return out;
}

// ========== IPC：博主作品列表 ==========
ipcMain.handle('userWorks:start', async (_event, payload) => {
  const { taskId, secUid, nickname, cookies, limit, expectedTotal, proxy, config, forceRefresh, retry } = payload;
  console.log(`[userWorks:start] taskId=${taskId} secUid=${secUid ? secUid.slice(0, 30) : 'none'} limit=${limit} expectedTotal=${expectedTotal} forceRefresh=${forceRefresh} retry=${retry}`);
  if (!secUid) {
    return { started: false, error: '缺少 secUid' };
  }
  // 全局串行：多个作者同时请求会叠加成高频请求，极易触发风控
  if (userWorksLock) {
    return { started: false, error: '已有其他作者作品任务在运行，请等待完成后再试' };
  }
  userWorksLock = taskId;

  let jobFile;
  try {
    jobFile = writeJobFile(taskId, {
      task_type: 'user_works',
      sec_uid: secUid,
      nickname: nickname || '',
      cookies,
      limit: limit || 0,
      expected_total: expectedTotal || 0,
      retry: Boolean(retry),
      proxy: proxy || '',
      config,
      cookieFile: cookieFilePath,
      force_refresh: Boolean(forceRefresh),
    });
  } catch (err) {
    console.error(`[userWorks:start] failed to create job file: ${err.message}`);
    userWorksLock = null;
    return { started: false, error: `创建任务文件失败：${err.message}` };
  }

  const releaseLock = (code) => {
    if (userWorksLock === taskId) {
      userWorksLock = null;
      console.log(`[userWorks:start] lock released taskId=${taskId} code=${code}`);
    }
  };

  const result = await runPythonBridge(
    'user_works_bridge.py',
    taskId,
    jobFile,
    getPythonRoot(),
    'userWorks:progress',
    'userWorks:log',
    'userWorks:finished',
    activeUserWorks,
    releaseLock
  );
  if (!result.started) {
    releaseLock();
  }
  return result;
});

ipcMain.handle('userWorks:cancel', (_event, taskId) => {
  return cancelTask(taskId, activeUserWorks);
});

// ========== IPC：新发布 ==========
ipcMain.handle('newReleases:start', async (_event, payload) => {
  const { taskId, config, cookies, limits, proxy, filterOnly } = payload;
  const jobFile = writeJobFile(taskId, {
    task_type: 'new_releases',
    config,
    cookies,
    limits,
    proxy: proxy || '',
    cookieFile: cookieFilePath,
    filter_only: Boolean(filterOnly),
  });
  return runPythonBridge(
    'new_releases_bridge.py',
    taskId,
    jobFile,
    getPythonRoot(),
    'newReleases:progress',
    'newReleases:log',
    'newReleases:finished',
    activeNewReleases
  );
});

ipcMain.handle('newReleases:cancel', (_event, taskId) => {
  return cancelTask(taskId, activeNewReleases);
});

// ========== IPC：登录 ==========
const DOUYIN_LOGIN_URL = 'https://www.douyin.com/';
const DOUYIN_USER_URL_RE = /^https:\/\/www\.douyin\.com\/user\//;

function cookiesToString(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

function hasLoginCookies(cookies) {
  const names = new Set(cookies.map((c) => c.name));
  // sessionid 是已登录的最直接标志；扫码登录后可能先拿到 ttwid + passport_csrf_token
  return names.has('sessionid') || (names.has('passport_csrf_token') && names.has('ttwid'));
}

async function validateCookiesWithBackend(cookieString) {
  const backendRoot = getBackendRoot();
  const script = path.join(backendRoot, 'login_service.py');

  // 把 cookie 写到临时文件，避免命令行过长 / 特殊字符转义问题
  const tempCookieFile = path.join(app.getPath('temp'), `douzy-cookie-${Date.now()}.txt`);
  try {
    fs.writeFileSync(tempCookieFile, cookieString || '', 'utf-8');
  } catch (e) {
    return { valid: false, reason: `无法写入临时 Cookie 文件：${e.message}` };
  }

  const pythonPath = await findPythonExecutable();
  if (!pythonPath) {
    try { fs.unlinkSync(tempCookieFile); } catch (e) {}
    return { valid: false, reason: '找不到可用的 Python 解释器，请在设置中配置 pythonPath 或安装 Python' };
  }

  const loginLogDir = path.join(userDataPath, 'logs', 'login');
  try {
    if (!fs.existsSync(loginLogDir)) fs.mkdirSync(loginLogDir, { recursive: true });
  } catch (e) {}
  const outPath = path.join(loginLogDir, `login-${Date.now()}.stdout.log`);
  const errPath = path.join(loginLogDir, `login-${Date.now()}.stderr.log`);

  const { cmd, args } = resolvePythonSpawnArgs(pythonPath, script, [
    '--cookie-file', tempCookieFile,
    '--stdout-log', outPath,
    '--stderr-log', errPath,
  ]);

  const result = await new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      // dispatcher 模式自行解析脚本路径，无需以 backendRoot 为工作目录；
      // 使用可写的 userDataPath，避免打包后 resources/backend 不存在导致 ENOENT，
      // 同时让 CookieManager 的 .cookies.json 写到固定位置。
      cwd: isDispatcherMode(pythonPath) ? userDataPath : backendRoot,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...bridgeEnvVars() },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    trackProcess(proc);

    let pipeStdout = '';
    let pipeStderr = '';
    let settled = false;

    const readLogFile = (p) => {
      try {
        if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
      } catch (e) {}
      return '';
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        process.kill(proc.pid, 'SIGTERM');
      } catch (e) {
        // ignore
      }
      resolve({ valid: false, reason: '校验脚本执行超时（60 秒）', timedOut: true });
    }, 60000);

    proc.stdout.on('data', (data) => {
      pipeStdout += data.toString('utf-8');
    });

    proc.stderr.on('data', (data) => {
      pipeStderr += data.toString('utf-8');
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ valid: false, reason: err.message });
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 优先从日志文件读取结果（打包后的 windowed dispatcher 可能无法通过 pipe 输出）
      const stdout = readLogFile(outPath) || pipeStdout;
      const stderr = readLogFile(errPath) || pipeStderr;
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      const last = lines.length > 0 ? lines[lines.length - 1] : '';
      console.log(`login_service.py [${pythonPath}] exit=${code} lastStdout=${last.slice(0, 200)} stderr=${stderr.slice(0, 500)}`);
      try {
        fs.unlinkSync(outPath);
      } catch (e) {}
      try {
        fs.unlinkSync(errPath);
      } catch (e) {}
      try {
        const parsed = last ? JSON.parse(last) : null;
        if (parsed && typeof parsed.valid === 'boolean') {
          resolve({ ...parsed });
        } else {
          resolve({ valid: false, reason: stderr.trim() || '校验脚本无有效输出' });
        }
      } catch (e) {
        resolve({ valid: false, reason: stderr.trim() || e.message });
      }
    });
  });

  try { fs.unlinkSync(tempCookieFile); } catch (e) {}
  return result;
}

function isDouyinDomain(domain) {
  if (!domain) return false;
  const normalized = domain.startsWith('.') ? domain.slice(1) : domain;
  return normalized === 'douyin.com' || normalized.endsWith('.douyin.com');
}

async function getDouyinCookies(session) {
  let all = [];
  try {
    all = await session.cookies.get({});
  } catch (e) {
    console.error('获取 cookies 失败', e);
    return [];
  }
  const douyinCookies = all.filter((c) => isDouyinDomain(c.domain));
  const map = new Map();
  for (const c of douyinCookies) {
    const key = `${c.domain}|${c.path}|${c.name}`;
    map.set(key, c);
  }
  return Array.from(map.values());
}

// 从抖音页面水合数据 / React props 中提取当前登录用户信息，
// 作为后端校验的超时/失败兜底，避免 Python 脚本启动慢导致登录卡住。
async function getUserInfoFromPage(loginWin) {
  try {
    const user = await loginWin.webContents.executeJavaScript(`(function(){
      function pickAvatar(u){
        var av = u.avatar || u.avatar_thumb || u.avatar_medium || u.avatar_larger || u.avatarUri || u.avatar_url || u.user_avatar || u.headImg || u.head_url || u.cover;
        if (!av) return '';
        if (typeof av === 'string') return av;
        return av.url || av.uri || av.imgUrl || av.src || av.avatar_url || av.avatarUrl || av.cover || '';
      }
      function hasUser(u){
        return u && typeof u === 'object' && u.sec_uid && u.nickname;
      }
      function deepFind(obj, depth){
        depth = depth || 0;
        if (depth > 14 || !obj || typeof obj !== 'object') return null;
        if (Array.isArray(obj)) {
          for (var i = 0; i < obj.length; i++) {
            var f = deepFind(obj[i], depth + 1);
            if (f) return f;
          }
          return null;
        }
        if (hasUser(obj)) return obj;
        for (var k in obj) {
          var f = deepFind(obj[k], depth + 1);
          if (f) return f;
        }
        return null;
      }
      var sources = [window._SSR_HYDRATED_DATA, window.__INITIAL_STATE__, window.__INITIAL_DATA__, window._ROUTER_DATA, window.render_data, window.__pace_data];
      for (var i = 0; i < sources.length; i++) {
        var f = deepFind(sources[i]);
        if (f) return {
          sec_uid: String(f.sec_uid),
          nickname: String(f.nickname || ''),
          avatar: pickAvatar(f),
          unique_id: String(f.unique_id || f.uniqueId || f.short_id || f.shortId || '')
        };
      }
      try {
        var rd = document.querySelector('script#RENDER_DATA');
        if (rd && rd.textContent) {
          var pj = JSON.parse(decodeURIComponent(rd.textContent));
          var rf = deepFind(pj);
          if (rf) return {
            sec_uid: String(rf.sec_uid),
            nickname: String(rf.nickname || ''),
            avatar: pickAvatar(rf),
            unique_id: String(rf.unique_id || rf.uniqueId || rf.short_id || rf.shortId || '')
          };
        }
      } catch (e) {}
      var all = document.querySelectorAll('*');
      var props = [];
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        for (var k in el) {
          if (k.indexOf('__reactProps$') === 0 || k.indexOf('__reactInternalInstance$') === 0) {
            props.push(el[k]);
          }
        }
      }
      for (var i = 0; i < props.length; i++) {
        var f = deepFind(props[i]);
        if (f) return {
          sec_uid: String(f.sec_uid),
          nickname: String(f.nickname || ''),
          avatar: pickAvatar(f),
          unique_id: String(f.unique_id || f.uniqueId || f.short_id || f.shortId || '')
        };
      }
      return null;
    })()`);
    if (user && user.sec_uid) {
      return user;
    }
  } catch (e) {
    console.error('从页面提取用户信息失败', e);
  }
  return null;
}

// 登录窗口内注入的"完成登录"按钮脚本
const LOGIN_BUTTON_SCRIPT = `
(function() {
  if (document.getElementById('douzy-login-complete-btn')) return;
  var btn = document.createElement('button');
  btn.id = 'douzy-login-complete-btn';
  btn.textContent = '我已完成登录';
  btn.style.cssText = [
    'position: fixed',
    'right: 20px',
    'bottom: 20px',
    'z-index: 999999',
    'padding: 10px 18px',
    'background: #1fb7d6',
    'color: #fff',
    'border: none',
    'border-radius: 6px',
    'font-size: 14px',
    'font-weight: 600',
    'cursor: pointer',
    'box-shadow: 0 4px 12px rgba(0,0,0,0.3)',
    'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
  ].join(';');
  btn.addEventListener('click', async () => {
    if (window.electronAPI && window.electronAPI.completeLogin) {
      btn.textContent = '正在校验…';
      btn.disabled = true;
      btn.style.opacity = '0.7';
      try {
        await window.electronAPI.completeLogin();
      } catch (e) {
        btn.textContent = '我已完成登录';
        btn.disabled = false;
        btn.style.opacity = '1';
      }
    }
  });
  document.body.appendChild(btn);
})();
`;

async function tryLoginWithExistingCookies() {
  // 如果 settings.json 里已有 cookieString，先尝试直接校验，避免每次都弹浏览器窗口。
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) || {};
  } catch (e) {
    return { success: false };
  }
  const cookieString = settings.cookieString || '';
  if (!cookieString.trim() || cookieString.includes('***')) {
    return { success: false };
  }
  try {
    const result = await validateCookiesWithBackend(cookieString);
    if (result.valid) {
      writeUnifiedCookies(cookieString);
      return { success: true, cookieString, user: result.user };
    }
  } catch (e) {
    console.log('尝试用已有 Cookie 自动登录失败:', e.message || e);
  }
  return { success: false };
}

// 登录成功后持久化自身用户信息（sec_uid / nickname / unique_id），
// 供「我的喜欢 / 新发布」等自身账号下载在 sec_uid 未从前端传入时兜底使用。
function saveSelfUser(user) {
  try {
    const dir = path.join(userDataPath, 'cookies');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'self_user.json');
    const data = {
      sec_uid: String(user.sec_uid || ''),
      nickname: String(user.nickname || ''),
      unique_id: String(user.unique_id || user.uniqueId || ''),
      saved_at: Date.now(),
    };
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
    console.log('[auth] 已保存自身用户信息 sec_uid=', data.sec_uid.slice(0, 12) + '...');
  } catch (e) {
    console.error('[auth] 保存自身用户信息失败', e);
  }
}

ipcMain.handle('auth:loginWithBrowser', async () => {
  if (!mainWindow) return { success: false, reason: '主窗口未初始化' };

  // 优先复用已保存的 Cookie；校验通过则直接登录，不再弹出浏览器窗口。
  const existing = await tryLoginWithExistingCookies();
  if (existing.success) {
    if (existing.user && existing.user.sec_uid) {
      try { saveSelfUser(existing.user); } catch (e) {}
    }
    return existing;
  }

  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return { success: false, reason: '登录窗口已在打开' };
  }

  return new Promise((resolve) => {
    const loginWin = new BrowserWindow({
      width: 960,
      height: 760,
      title: '登录抖音',
      icon: getWindowIconPath() || undefined,
      webPreferences: {
        preload: path.join(__dirname, 'login-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });

    loginWindow = loginWin;
    let resolved = false;

    loginWin.once('ready-to-show', () => {
      loginWin.show();
      loginWin.focus();
    });

    function showLoginToast(message, type = 'warning') {
      if (loginWin.isDestroyed()) return;
      const color = type === 'error' ? '#ff4d6d' : '#f59e0b';
      loginWin.webContents.executeJavaScript(`
        (function() {
          let toast = document.getElementById('douzy-login-toast');
          if (!toast) {
            toast = document.createElement('div');
            toast.id = 'douzy-login-toast';
            toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:999999;padding:10px 18px;background:${color};color:#fff;border-radius:6px;font-size:14px;max-width:80%;word-break:break-all;box-shadow:0 4px 12px rgba(0,0,0,0.3);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
            document.body.appendChild(toast);
          }
          toast.textContent = ${JSON.stringify(message)};
          toast.style.background = '${color}';
          toast.style.display = 'block';
          setTimeout(() => { if (toast) toast.style.display = 'none'; }, 5000);
        })();
      `).catch(() => {});
    }

    function resetLoginButton() {
      if (loginWin.isDestroyed()) return;
      loginWin.webContents.executeJavaScript(`
        (function() {
          const btn = document.getElementById('douzy-login-complete-btn');
          if (btn) { btn.textContent = '我已完成登录'; btn.disabled = false; btn.style.opacity = '1'; }
        })();
      `).catch(() => {});
    }

    async function doCheckAndFinish() {
      if (resolved) return;
      try {
        const cookies = await getDouyinCookies(loginWin.webContents.session);
        const cookieNames = cookies.map((c) => c.name);
        console.log('检测到抖音 cookies:', cookieNames.join(', '));
        if (!cookies.length) {
          showLoginToast('未检测到抖音域 cookie，请确认当前页面是抖音且已登录');
          resetLoginButton();
          return;
        }
        if (!hasLoginCookies(cookies)) {
          const missing = ['sessionid', 'ttwid', 'passport_csrf_token'].filter((k) => !cookieNames.includes(k));
          showLoginToast(`检测到 ${cookieNames.length} 个 cookie，但缺少登录标识：${missing.join('、')}，请完成登录后再试`);
          resetLoginButton();
          return;
        }
        const cookieString = cookiesToString(cookies);

        // 优先从当前抖音页面直接提取登录用户信息，避免 Python 后端脚本启动/网络延迟导致超时。
        console.log('尝试从页面提取用户信息...');
        const pageUser = await getUserInfoFromPage(loginWin);
        if (pageUser && pageUser.sec_uid) {
          console.log('页面提取用户信息成功:', pageUser.nickname, pageUser.sec_uid);
          writeUnifiedCookies(cookieString);
          finish({ success: true, cookieString, user: pageUser });
          return;
        }

        // 页面提取失败再回退到后端校验（超时已延长到 60 秒）
        console.log('页面提取失败，正在后端校验 cookies...');
        const result = await validateCookiesWithBackend(cookieString);
        if (result.valid) {
          console.log('Cookie 校验通过，用户:', result.user ? result.user.nickname : 'unknown');
          writeUnifiedCookies(cookieString);
          finish({ success: true, cookieString, user: result.user });
          return;
        }
        console.log('Cookie 校验未通过:', result.reason);
        showLoginToast(`校验未通过：${result.reason || 'Cookie 可能已过期'}`, 'error');
        resetLoginButton();
      } catch (e) {
        console.error('检测登录状态失败', e);
        showLoginToast(`检测失败：${e.message || '未知错误'}`, 'error');
        resetLoginButton();
      }
    }

    function finish(result) {
      if (resolved) return;
      resolved = true;
      loginWindow = null;
      // 登录成功后持久化自身用户信息（sec_uid 等），供「我的喜欢 / 新发布」等
      // 自身账号下载在 sec_uid 未从前端传入时兜底使用。
      if (result && result.user && result.user.sec_uid) {
        try {
          saveSelfUser(result.user);
        } catch (e) {
          console.error('[auth] 保存自身用户信息失败', e);
        }
      }
      try {
        ipcMain.removeHandler('auth:completeLogin');
      } catch (e) {
        // ignore
      }
      if (!loginWin.isDestroyed()) loginWin.close();
      resolve(result);
    }

    loginWin.webContents.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    );

    // 判断登录窗口内 URL 是否允许：抖音 http/https + 页面内部协议
    function isAllowedLoginUrl(url) {
      try {
        const parsed = new URL(url);
        const isDouyin = parsed.hostname === 'douyin.com' || parsed.hostname === 'www.douyin.com' || parsed.hostname.endsWith('.douyin.com');
        const isHttp = parsed.protocol === 'https:' || parsed.protocol === 'http:';
        // 允许页面内部协议/锚点/空链接，避免误拦二维码生成、登录方式切换等正常交互
        const isInternal = ['javascript:', 'about:', 'blob:', 'data:', 'mailto:', 'tel:'].includes(parsed.protocol);
        return isInternal || (isDouyin && isHttp);
      } catch (e) {
        // 空或相对路径视为内部链接，允许
        return true;
      }
    }

    // 阻止登录窗口弹出外部浏览器/自定义协议（如 bitbrowser://），但允许抖音域弹窗/标签
    loginWin.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedLoginUrl(url)) {
        return { action: 'allow', overrideBrowserWindowOptions: { parent: loginWin } };
      }
      console.log('登录窗口阻止外部弹窗:', url);
      return { action: 'deny' };
    });

    // 覆盖 navigator.userAgent / navigator.webdriver，降低被识别成 Electron 的概率
    const ANTI_DETECT_SCRIPT = `
      (function() {
        const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
        try {
          Object.defineProperty(navigator, 'userAgent', { get: () => ua });
        } catch (e) {}
        try {
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
        } catch (e) {}
        if (window.chrome && window.chrome.runtime) {
          try { delete window.chrome.runtime; } catch (e) {}
        }
      })();
    `;

    // 在页面内拦截外部协议/非抖音链接，防止 bitbrowser:// 等弹系统商店。
    // 明确允许 javascript:/about:/blob:/data:/mailto:/tel: 以及相对/空链接，
    // 避免误拦二维码生成、登录方式切换等正常交互。
    const BLOCK_EXTERNAL_LINKS_SCRIPT = `
      (function() {
        function isExternal(href) {
          try {
            if (!href) return false;
            const u = new URL(href, location.href);
            if (['javascript:', 'about:', 'blob:', 'data:', 'mailto:', 'tel:'].includes(u.protocol)) return false;
            if (u.protocol === 'https:' || u.protocol === 'http:') {
              const isDouyin = u.hostname === 'douyin.com' || u.hostname === 'www.douyin.com' || u.hostname.endsWith('.douyin.com');
              return !isDouyin;
            }
            return true;
          } catch (e) { return false; }
        }
        const origOpen = window.open;
        window.open = function(url, target, features) {
          if (!url || !isExternal(url)) return origOpen.apply(this, arguments);
          console.log('[Douzy] blocked window.open:', url);
          return null;
        };
        document.addEventListener('click', function(e) {
          const a = e.composedPath ? e.composedPath().find(el => el.tagName === 'A') : e.target.closest && e.target.closest('a');
          if (!a || !a.href) return;
          if (isExternal(a.href)) {
            console.log('[Douzy] blocked link:', a.href);
            e.preventDefault();
            e.stopPropagation();
          }
        }, true);
      })();
    `;

    loginWin.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedLoginUrl(url)) {
        console.log('登录窗口阻止非抖音导航:', url);
        event.preventDefault();
      }
    });

    loginWin.webContents.on('will-redirect', (event, url) => {
      if (!isAllowedLoginUrl(url)) {
        console.log('登录窗口阻止非抖音重定向:', url);
        event.preventDefault();
      }
    });

    // 拦截 iframe / 子 frame 内的非抖音导航，防止 bitbrowser:// 从子 frame 弹系统商店
    loginWin.webContents.on('will-frame-navigate', (event, url) => {
      if (!isAllowedLoginUrl(url)) {
        console.log('登录窗口阻止非抖音 frame 导航:', url);
        event.preventDefault();
      }
    });

    // 登录窗口日志：console / load failure，便于排查二维码/页面异常
    loginWin.webContents.on('console-message', (event, level, message, line, sourceId) => {
      const levels = ['verbose', 'info', 'warning', 'error'];
      const tag = levels[level] || String(level);
      console.log(`[login-console] ${tag}: ${message} (${sourceId}:${line})`);
    });

    loginWin.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
      console.error(`[login-fail-load] code=${errorCode} desc=${errorDescription} url=${validatedURL}`);
    });

    loginWin.webContents.on('did-fail-provisional-load', (event, errorCode, errorDescription, validatedURL) => {
      console.error(`[login-fail-provisional] code=${errorCode} desc=${errorDescription} url=${validatedURL}`);
    });

    loginWin.webContents.on('did-navigate', (_event, url) => {
      console.log('登录窗口导航到:', url);
      // 只有到达用户个人主页时才自动判定登录成功
      if (DOUYIN_USER_URL_RE.test(url)) {
        setTimeout(doCheckAndFinish, 1000);
      }
    });

    loginWin.webContents.on('dom-ready', () => {
      loginWin.webContents.executeJavaScript(ANTI_DETECT_SCRIPT).catch((e) => {
        console.error('注入反检测脚本失败', e);
      });
      loginWin.webContents.executeJavaScript(BLOCK_EXTERNAL_LINKS_SCRIPT).catch((e) => {
        console.error('注入外链拦截脚本失败', e);
      });
    });

    loginWin.webContents.on('did-finish-load', () => {
      loginWin.webContents.executeJavaScript(LOGIN_BUTTON_SCRIPT).catch((e) => {
        console.error('注入完成登录按钮失败', e);
      });
    });

    try {
      ipcMain.removeHandler('auth:completeLogin');
    } catch (e) {
      // ignore
    }
    ipcMain.handle('auth:completeLogin', async () => {
      if (!loginWin.isDestroyed()) {
        loginWin.webContents.executeJavaScript(`
          var btn = document.getElementById('douzy-login-complete-btn');
          if (btn) { btn.textContent = '正在校验…'; btn.disabled = true; btn.style.opacity = '0.7'; }
        `).catch(() => {});
      }
      await doCheckAndFinish();
      if (!resolved) {
        // 校验未通过时保留窗口，让用户继续操作
        return { checked: true, valid: false };
      }
      return { checked: true, valid: true };
    });

    loginWin.on('closed', () => {
      loginWindow = null;
      finish({ success: false, reason: '用户取消登录' });
    });

    loginWin.loadURL(DOUYIN_LOGIN_URL);
  });
});

ipcMain.handle('auth:validate', async (_event, cookieString) => {
  const result = await validateCookiesWithBackend(cookieString || '');
  if (result.valid) {
    writeUnifiedCookies(cookieString);
  }
  return result;
});

// ========== IPC：批量关注/取关 ==========
ipcMain.handle('relation:start', async (_event, payload) => {
  const { taskId, action, secUids, cookies, proxy, config } = payload;
  if (!Array.isArray(secUids) || secUids.length === 0) {
    return { started: false, error: '没有选中用户' };
  }
  const jobFile = writeJobFile(taskId, { task_type: 'relation', action, secUids, cookies, proxy, config, cookieFile: cookieFilePath });
  return runPythonBridge(
    'relation_bridge.py',
    taskId,
    jobFile,
    getPythonRoot(),
    'relation:progress',
    'relation:log',
    'relation:finished',
    activeBridges
  );
});

ipcMain.handle('relation:cancel', (_event, taskId) => {
  return cancelTask(taskId, activeBridges);
});

// ========== IPC：报表导出 ==========
ipcMain.handle('report:export', async (_event, payload) => {
  const { taskId, dbPath, dateFrom, dateTo, groupBy, formats, outputDir } = payload;
  const jobFile = writeJobFile(taskId, {
    task_type: 'report',
    dbPath,
    dateFrom,
    dateTo,
    groupBy,
    formats,
    outputDir,
  });
  return runPythonBridge(
    'report_bridge.py',
    taskId,
    jobFile,
    getPythonRoot(),
    'report:progress',
    'report:log',
    'report:finished',
    activeBridges
  );
});

ipcMain.handle('report:cancel', (_event, taskId) => {
  return cancelTask(taskId, activeBridges);
});

// ========== IPC：云同步 ==========
ipcMain.handle('cloud:backup', async (_event, payload) => {
  const { taskId, dbPath, provider, credentials } = payload;
  // 默认使用 settingsPath；若前端传入自定义 configPath，必须位于允许的根目录内
  let configPath = settingsPath;
  const requestedConfigPath = payload.configPath;
  if (requestedConfigPath) {
    const allowed = resolveAllowedPath(requestedConfigPath, [userDataPath, getOutputPath()]);
    if (allowed && fs.existsSync(allowed)) {
      configPath = allowed;
    }
  }
  const allowedDbPath = resolveAllowedPath(dbPath, [userDataPath, getOutputPath()]);
  const jobFile = writeJobFile(taskId, {
    task_type: 'cloud_backup',
    configPath,
    dbPath: allowedDbPath || dbPath,
    cookiePath: cookieFilePath,
    provider,
    credentials,
  });
  return runPythonBridge(
    'cloud_bridge.py',
    taskId,
    jobFile,
    getPythonRoot(),
    'cloud:progress',
    'cloud:log',
    'cloud:finished',
    activeBridges
  );
});

ipcMain.handle('cloud:restore', async (_event, payload) => {
  const { taskId, token, provider, credentials, outputDir } = payload;
  const allowedOutputDir = resolveAllowedPath(outputDir, [getOutputPath(), userDataPath]);
  const allowedDbPath = resolveAllowedPath(payload.dbPath, [getOutputPath(), userDataPath]);
  const restoreDbPath = allowedDbPath || (allowedOutputDir ? path.join(allowedOutputDir, 'dy_downloader.db') : '');
  const jobFile = writeJobFile(taskId, {
    task_type: 'cloud_restore',
    token,
    provider,
    credentials,
    outputDir: allowedOutputDir,
    dbPath: restoreDbPath,
    settingsPath,
    cookieFile: cookieFilePath,
  });
  return runPythonBridge(
    'cloud_bridge.py',
    taskId,
    jobFile,
    getPythonRoot(),
    'cloud:progress',
    'cloud:log',
    'cloud:finished',
    activeBridges
  );
});

ipcMain.handle('cloud:cancel', (_event, taskId) => {
  return cancelTask(taskId, activeBridges);
});

// ========== IPC：作品去重 ==========
ipcMain.handle('dedup:start', async (_event, payload) => {
  const { taskId, outputDir } = payload;
  const allowedOutputDir = resolveAllowedPath(outputDir, [getOutputPath(), userDataPath]);
  if (!allowedOutputDir) {
    return { started: false, error: '输出目录不在允许范围内' };
  }
  const jobFile = writeJobFile(taskId, {
    task_type: 'dedup',
    outputDir: allowedOutputDir,
  });
  return runPythonBridge(
    'dedup_bridge.py',
    taskId,
    jobFile,
    getPythonRoot(),
    'dedup:progress',
    'dedup:log',
    'dedup:finished',
    activeBridges
  );
});

ipcMain.handle('dedup:cancel', (_event, taskId) => {
  return cancelTask(taskId, activeBridges);
});

// ========== 工具函数 ==========
function trackProcess(proc) {
  if (!proc) return;
  trackedChildProcesses.add(proc);
  proc.on('close', () => trackedChildProcesses.delete(proc));
  proc.on('exit', () => trackedChildProcesses.delete(proc));
  proc.on('error', () => trackedChildProcesses.delete(proc));
}

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      // 同步强制结束进程树，避免异步 exec 在进程卡死时无法确认结果。
      execSync(`taskkill /pid ${pid} /T /F`, { windowsHide: true });
    } catch (err) {
      // taskkill 返回 128 表示进程已不存在，也视为成功；其它错误再尝试单进程 kill。
      if (err && err.status !== 128) {
        console.error('taskkill failed', err);
        try {
          process.kill(pid, 'SIGKILL');
        } catch (e) {
          console.error('fallback kill failed', e);
        }
      }
    }
  } else {
    const listCmd = process.platform === 'darwin'
      ? `pgrep -P ${pid}`
      : `ps -o pid= --ppid ${pid}`;
    try {
      const stdout = execSync(listCmd, { encoding: 'utf-8' });
      const children = (stdout || '')
        .trim()
        .split(/\s+/)
        .map(Number)
        .filter((p) => p > 0 && p !== pid);
      for (const childPid of children) {
        killProcessTree(childPid);
      }
    } catch (e) {
      // 没有子进程时命令会失败，忽略。
    }
    try {
      process.kill(pid, 'SIGTERM');
      // 给 SIGTERM 一点时间，然后强制 SIGKILL。
      setTimeout(() => {
        try {
          process.kill(pid, 0);
          process.kill(pid, 'SIGKILL');
        } catch (e) {
          // 进程已结束
        }
      }, 300);
    } catch (e) {
      console.error('kill failed', e);
    }
  }
}

function cleanupAllChildProcesses() {
  for (const proc of trackedChildProcesses) {
    if (proc && !proc.killed) {
      killProcessTree(proc.pid);
    }
  }
  trackedChildProcesses.clear();
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}
