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
  session,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, exec, execSync } = require('child_process');

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
    favorites: 50000,
    collections: 50000,
    likes: 50000,
    favoritesMusic: 50000,
    following: 50000,
    topics: 50000,
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
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
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
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', DOUZY_USER_DATA: userDataPath, DOUZY_OUTPUT_PATH: getOutputPath() },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (spawnErr) {
    try { fs.unlinkSync(jobFile); } catch (e) {}
    try { fs.unlinkSync(outPath); } catch (e) {}
    try { fs.unlinkSync(errPath); } catch (e) {}
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

  const cleanupFiles = () => {
    try { fs.unlinkSync(jobFile); } catch (e) {}
    try { fs.unlinkSync(outPath); } catch (e) {}
    try { fs.unlinkSync(errPath); } catch (e) {}
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
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
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
  // 只有 sessionid 是真正代表已登录的 cookie；ttwid/passport_csrf_token 在登录页就会写入，不能作为登录标志
  return names.has('sessionid');
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
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
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
      resolve({ valid: false, reason: '校验脚本执行超时（45 秒），请检查网络或关闭代理后重试' });
    }, 45000);

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

let loginCookieChangedHandler = null;
let loginCookieDebounceTimer = null;

function clearLoginCookieListener(loginWin) {
  if (loginCookieDebounceTimer) {
    clearTimeout(loginCookieDebounceTimer);
    loginCookieDebounceTimer = null;
  }
  if (loginCookieChangedHandler && loginWin && !loginWin.isDestroyed()) {
    try {
      loginWin.webContents.session.cookies.off('changed', loginCookieChangedHandler);
    } catch (e) {
      // ignore
    }
    loginCookieChangedHandler = null;
  }
}

function setupLoginCookieListener(loginWin, onLoginCookies) {
  clearLoginCookieListener(loginWin);

  const handler = (_event, cookie, _cause, removed) => {
    if (removed) return;
    if (!isDouyinDomain(cookie.domain)) return;
    if (cookie.name !== 'sessionid') return;

    if (loginCookieDebounceTimer) clearTimeout(loginCookieDebounceTimer);
    loginCookieDebounceTimer = setTimeout(async () => {
      if (loginWin.isDestroyed()) return;
      try {
        const cookies = await getDouyinCookies(loginWin.webContents.session);
        if (hasLoginCookies(cookies)) {
          clearLoginCookieListener(loginWin);
          onLoginCookies(cookies);
        }
      } catch (e) {
        console.error('cookie 变化检测失败', e);
      }
    }, 500);
  };

  loginCookieChangedHandler = handler;
  loginWin.webContents.session.cookies.on('changed', handler);
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

ipcMain.handle('auth:loginWithBrowser', async () => {
  if (!mainWindow) return { success: false, reason: '主窗口未初始化' };
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return { success: false, reason: '登录窗口已在打开' };
  }

  return new Promise((resolve) => {
    // 每次登录使用独立的全新 session，避免旧账号 cookie 残留导致自动误判已登录
    const loginPartition = `login-${Date.now()}`;
    const loginWin = new BrowserWindow({
      width: 960,
      height: 760,
      title: '登录抖音',
      icon: getWindowIconPath() || undefined,
      webPreferences: {
        partition: loginPartition,
        preload: path.join(__dirname, 'login-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });

    loginWindow = loginWin;
    let resolved = false;

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
          showLoginToast('检测到 cookie，但缺少登录标识 sessionid，请完成登录后再试');
          resetLoginButton();
          return;
        }
        const cookieString = cookiesToString(cookies);
        console.log('正在后端校验 cookies...');
        showLoginToast('正在向抖音校验登录状态，请稍候…', 'warning');
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
      clearLoginCookieListener(loginWin);
      loginWindow = null;
      try {
        ipcMain.removeHandler('auth:completeLogin');
      } catch (e) {
        // ignore
      }
      if (!loginWin.isDestroyed()) loginWin.close();
      resolve(result);
    }

    async function quickFinish(cookies) {
      if (resolved) return;
      const cookieString = cookiesToString(cookies);
      const cookieNames = cookies.map((c) => c.name).join(', ');
      console.log('扫码登录快速完成，cookies:', cookieNames);
      writeUnifiedCookies(cookieString);
      finish({ success: true, cookieString });
    }

    loginWin.webContents.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    );

    // 阻止登录窗口弹出外部浏览器/自定义协议（如 bitbrowser://）
    loginWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // 覆盖 navigator.userAgent / navigator.webdriver，降低被识别成 Electron 的概率
    const ANTI_DETECT_SCRIPT = `
      (function() {
        const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
        Object.defineProperty(navigator, 'userAgent', { get: () => ua });
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        if (window.chrome && window.chrome.runtime) {
          try { delete window.chrome.runtime; } catch (e) {}
        }
      })();
    `;

    // 在页面内拦截外部协议/非抖音链接，防止 bitbrowser:// 等弹系统商店
    const BLOCK_EXTERNAL_LINKS_SCRIPT = `
      (function() {
        function isAllowed(href) {
          try {
            const u = new URL(href, location.href);
            return u.protocol === 'https:' && (u.hostname === 'douyin.com' || u.hostname === 'www.douyin.com' || u.hostname.endsWith('.douyin.com'));
          } catch (e) { return false; }
        }
        const origOpen = window.open;
        window.open = function(url, target, features) {
          if (!url || isAllowed(url)) return origOpen.apply(this, arguments);
          console.log('[Douzy] blocked window.open:', url);
          return null;
        };
        document.addEventListener('click', function(e) {
          const a = e.composedPath ? e.composedPath().find(el => el.tagName === 'A') : e.target.closest && e.target.closest('a');
          if (!a || !a.href) return;
          if (!isAllowed(a.href)) {
            console.log('[Douzy] blocked link:', a.href);
            e.preventDefault();
            e.stopPropagation();
          }
        }, true);
      })();
    `;

    function isAllowedLoginUrl(url) {
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && (parsed.hostname === 'douyin.com' || parsed.hostname === 'www.douyin.com' || parsed.hostname.endsWith('.douyin.com'));
      } catch (e) {
        return false;
      }
    }

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

    loginWin.webContents.on('did-navigate', (_event, url) => {
      console.log('登录窗口导航到:', url);
      // 到达用户个人主页说明已登录，快速完成（无需再调后端 API）
      if (DOUYIN_USER_URL_RE.test(url)) {
        setTimeout(async () => {
          try {
            const cookies = await getDouyinCookies(loginWin.webContents.session);
            if (hasLoginCookies(cookies)) await quickFinish(cookies);
          } catch (e) {
            console.error('URL 自动检测登录失败', e);
          }
        }, 800);
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

    // 监听 cookie 变化：扫码登录成功后 cookie 写入时会自动触发快速完成
    setupLoginCookieListener(loginWin, quickFinish);

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
