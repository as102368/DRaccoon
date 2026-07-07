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
const { spawn, exec } = require('child_process');

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

// 提升 Chromium 渲染响应，减少后台节流导致的卡顿
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
// 禁用一些可能导致卡顿或多余后台任务的 Chromium 功能
app.commandLine.appendSwitch('disable-features', 'CalculateWindowOcclusion,AutoFreezeBackgroundTab,PaintHolding,Translate,InterestFeedContentSuggestions');
// 若内置浏览器仍卡顿/黑屏，可取消下面这行的注释禁用 GPU 加速
// app.commandLine.appendSwitch('disable-gpu');

const userDataPath = app.getPath('userData');
app.setPath('logs', path.join(userDataPath, 'logs'));

const settingsPath = path.join(userDataPath, 'settings.json');
const jobsPath = path.join(userDataPath, 'jobs');

function ensureDirs() {
  [userDataPath, jobsPath].forEach((p) => {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  });
}
ensureDirs();

// ========== Python 解释器自动发现 ==========
// Windows 上可能存在 Microsoft Store 的 python.exe 占位 stub，直接调用会返回 9009。
// 这里优先使用 py -3，再回退到 PATH 命令和常见绝对路径，并把可用的解释器缓存下来。
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
      // 再确认一次该解释器能导入后端依赖 aiohttp
      const hasDeps = await testPythonExecutable(executable, ['-c', 'import sys; print(sys.executable); import aiohttp']);
      if (hasDeps) {
        cachedPythonPath = executable;
        console.log('使用 Python:', executable);
        return executable;
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
  database: true,
  folderstyle: false,
  videoQuality: 'highest',
  syncLimits: {
    favorites: 1000,
    collections: 200,
    likes: 1000,
    following: 2000,
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

let mainWindow;
let tray = null;
const activeDownloads = new Map();
const activeSyncs = new Map();
const activeUserWorks = new Map();
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
  // 优先使用项目内图标，否则使用系统默认
  const iconPng = path.join(__dirname, 'renderer', 'icon.png');
  const iconIco = path.join(__dirname, 'renderer', 'icon.ico');
  if (process.platform === 'win32' && fs.existsSync(iconIco)) return iconIco;
  if (fs.existsSync(iconPng)) return iconPng;
  return null;
}

function getWindowIconPath() {
  const iconPng = path.join(__dirname, 'renderer', 'icon.png');
  const iconIco = path.join(__dirname, 'renderer', 'icon.ico');
  if (process.platform === 'win32' && fs.existsSync(iconIco)) return iconIco;
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
  try {
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf-8').replace(/^\uFEFF/, '');
      return { ...defaultSettings, ...JSON.parse(raw) };
    }
  } catch (e) {}
  return { ...defaultSettings };
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

// ========== 应用生命周期 ==========
app.whenReady().then(() => {
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

// ========== IPC：设置 ==========
ipcMain.handle('settings:get', () => {
  let settings = defaultSettings;
  try {
    if (fs.existsSync(settingsPath)) {
      settings = { ...defaultSettings, ...JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) };
    }
  } catch (e) {
    console.error('读取设置失败', e);
  }
  if (!settings.outputPath) {
    settings.outputPath = defaultSettings.outputPath;
  }
  if (!settings.syncLimits) {
    settings.syncLimits = { ...defaultSettings.syncLimits };
  }
  if (!settings.shortcuts) {
    settings.shortcuts = { ...defaultSettings.shortcuts };
  }
  if (!settings.relation) {
    settings.relation = { ...defaultSettings.relation };
  }
  if (!settings.transcript) {
    settings.transcript = { ...defaultSettings.transcript };
  }
  if (!settings.cloudSync) {
    settings.cloudSync = { ...defaultSettings.cloudSync };
  }
  // 返回给渲染进程的设置必须保留原始 cookie，否则后续保存会把脱敏值写回文件
  return settings;
});

ipcMain.handle('settings:set', (_event, settings) => {
  try {
    // 与默认值合并，防止渲染进程只传部分字段时丢失已有配置（包括 cookie）
    const merged = { ...defaultSettings, ...settings };
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2), 'utf-8');
    unregisterGlobalShortcuts();
    registerGlobalShortcuts();
    return true;
  } catch (e) {
    console.error('保存设置失败', e);
    return false;
  }
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
  if (dirPath && fs.existsSync(dirPath)) {
    shell.openPath(dirPath);
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
  const target = dirPath || defaultSettings.outputPath;
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
  if (!dirPath || !fs.existsSync(dirPath)) return false;
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
    return true;
  } catch (e) {
    console.error('删除档案失败', e);
    return false;
  }
});

ipcMain.handle('video:open', (_event, filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    shell.openPath(filePath);
  }
});

function readSyncCache(kind) {
  const settings = getSettingsSync();
  const cachePath = path.join(settings.outputPath, '.sync', `${kind}.json`);
  if (!fs.existsSync(cachePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  } catch (e) {
    return null;
  }
}

ipcMain.handle('sync:get', (_event, kind) => {
  return readSyncCache(kind);
});

ipcMain.handle('sync:clear', (_event, kind) => {
  const settings = getSettingsSync();
  const cachePath = path.join(settings.outputPath, '.sync', `${kind}.json`);
  try {
    if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
    return true;
  } catch (e) {
    return false;
  }
});

// ========== 通用 Python 桥接 ==========
function getBackendRoot() {
  return path.join(__dirname, '..', '..', 'douyin-downloader');
}

function getPythonRoot() {
  return path.join(__dirname, '..', 'python');
}

async function runPythonBridge(scriptRelativePath, taskId, jobFile, cwd, progressChannel, logChannel, finishedChannel, activeMap) {
  const pythonPath = await findPythonExecutable();
  if (!pythonPath) {
    return { started: false, error: '找不到可用的 Python 解释器，请在设置中配置 pythonPath 或安装 Python' };
  }

  const scriptPath = path.isAbsolute(scriptRelativePath) ? scriptRelativePath : path.join(getPythonRoot(), scriptRelativePath);
  const proc = spawn(pythonPath, [scriptPath, '--job', jobFile, '--task-id', taskId], {
    cwd: cwd || getPythonRoot(),
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  trackProcess(proc);

  activeMap.set(taskId, { proc, startTime: Date.now() });

  let stdoutBuffer = '';
  proc.stdout.on('data', (data) => {
    stdoutBuffer += data.toString('utf-8');
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        sendToRenderer(progressChannel, { taskId, data: parsed });
      } catch (e) {
        sendToRenderer(logChannel, { taskId, line: redactText(line) });
      }
    }
  });

  proc.stderr.on('data', (data) => {
    const lines = data.toString('utf-8').split(/\r?\n/);
    for (const line of lines) {
      if (line.trim()) {
        sendToRenderer(logChannel, { taskId, line: redactText(line) });
      }
    }
  });

  proc.on('close', (code) => {
    activeMap.delete(taskId);
    if (stdoutBuffer.trim()) {
      try {
        const parsed = JSON.parse(stdoutBuffer.trim());
        sendToRenderer(progressChannel, { taskId, data: parsed });
      } catch (e) {
        sendToRenderer(logChannel, { taskId, line: redactText(stdoutBuffer.trim()) });
      }
    }
    stdoutBuffer = '';
    try { fs.unlinkSync(jobFile); } catch (e) {}
    sendToRenderer(finishedChannel, { taskId, code });
  });

  return { started: true };
}

function writeJobFile(taskId, payload) {
  const jobFile = path.join(jobsPath, `${taskId}.json`);
  fs.writeFileSync(jobFile, JSON.stringify(payload, null, 2), 'utf-8');
  return jobFile;
}

function cancelTask(taskId, activeMap) {
  const task = activeMap.get(taskId);
  if (task && task.proc && !task.proc.killed) {
    killProcessTree(task.proc.pid);
    activeMap.delete(taskId);
    return true;
  }
  return false;
}

// ========== IPC：下载 ==========
ipcMain.handle('download:start', async (_event, payload) => {
  const { taskId, urls, config, cookies } = payload;
  if (!urls || urls.length === 0) {
    return { started: false, error: '没有 URL' };
  }
  const jobFile = writeJobFile(taskId, {
    task_type: 'download',
    urls,
    config,
    cookies,
  });
  return runPythonBridge(
    'download_bridge.py',
    taskId,
    jobFile,
    getPythonRoot(),
    'download:progress',
    'download:log',
    'download:finished',
    activeDownloads
  );
});

ipcMain.handle('download:cancel', (_event, taskId) => {
  return cancelTask(taskId, activeDownloads);
});

// ========== IPC：同步 ==========
const SYNC_MAX_RUNTIME_MS = 10 * 60 * 1000; // 同步最大运行 10 分钟
const SYNC_STALL_MS = 3 * 60 * 1000;        // 3 分钟无输出视为卡住

ipcMain.handle('sync:start', async (_event, payload) => {
  const { syncId, kind, config, cookies, limits } = payload;

  const pythonPath = await findPythonExecutable();
  if (!pythonPath) {
    return { started: false, error: '找不到可用的 Python 解释器，请在设置中配置 pythonPath 或安装 Python' };
  }

  const jobFile = writeJobFile(syncId, { kind, config, cookies, limits });
  const backendRoot = getBackendRoot();
  const syncPath = path.join(backendRoot, 'sync_service.py');

  const proc = spawn(pythonPath, [syncPath, '--sync-job', jobFile], {
    cwd: backendRoot,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  trackProcess(proc);

  const syncState = { proc, startTime: Date.now(), lastActivity: Date.now(), finished: false };
  activeSyncs.set(syncId, syncState);

  const finishOnce = (code) => {
    if (syncState.finished) return;
    syncState.finished = true;
    activeSyncs.delete(syncId);
    clearTimeout(maxRuntimeTimer);
    clearTimeout(stallTimer);
    try { fs.unlinkSync(jobFile); } catch (e) {}
    sendToRenderer('sync:finished', { syncId, code, kind });
  };

  const maxRuntimeTimer = setTimeout(() => {
    console.warn(`[sync] ${syncId} 运行超过 ${SYNC_MAX_RUNTIME_MS}ms，强制终止`);
    if (proc && !proc.killed) {
      killProcessTree(proc.pid);
    }
    // 如果 close 事件未触发，主动 finish
    setTimeout(() => finishOnce(124), 500);
  }, SYNC_MAX_RUNTIME_MS);

  const resetStallTimer = () => {
    clearTimeout(stallTimer);
    return setTimeout(() => {
      console.warn(`[sync] ${syncId} 超过 ${SYNC_STALL_MS}ms 无输出，视为卡住`);
      if (proc && !proc.killed) {
        killProcessTree(proc.pid);
      }
      setTimeout(() => finishOnce(125), 500);
    }, SYNC_STALL_MS);
  };
  let stallTimer = resetStallTimer();

  proc.stdout.on('data', (data) => {
    syncState.lastActivity = Date.now();
    stallTimer = resetStallTimer();
    const lines = data.toString('utf-8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        sendToRenderer('sync:progress', { syncId, data: parsed });
      } catch (e) {
        sendToRenderer('sync:log', { syncId, line: redactText(line) });
      }
    }
  });

  proc.stderr.on('data', (data) => {
    syncState.lastActivity = Date.now();
    stallTimer = resetStallTimer();
    const lines = data.toString('utf-8').split(/\r?\n/);
    for (const line of lines) {
      if (line.trim()) {
        sendToRenderer('sync:log', { syncId, line: redactText(line) });
      }
    }
  });

  proc.on('error', (err) => {
    console.error(`[sync] ${syncId} process error`, err);
    finishOnce(126);
  });

  proc.on('close', (code) => {
    finishOnce(code);
  });

  return { started: true };
});

ipcMain.handle('sync:cancel', (_event, syncId) => {
  return cancelTask(syncId, activeSyncs);
});

// ========== IPC：博主作品列表 ==========
ipcMain.handle('userWorks:start', async (_event, payload) => {
  const { taskId, secUid, nickname, cookies, limit, proxy } = payload;
  console.log(`[userWorks:start] taskId=${taskId} secUid=${secUid ? secUid.slice(0, 30) : 'none'} limit=${limit}`);
  if (!secUid) {
    return { started: false, error: '缺少 secUid' };
  }
  const jobFile = writeJobFile(taskId, {
    task_type: 'user_works',
    sec_uid: secUid,
    nickname: nickname || '',
    cookies,
    limit: limit || 200,
    proxy: proxy || '',
  });
  return runPythonBridge(
    'user_works_bridge.py',
    taskId,
    jobFile,
    getPythonRoot(),
    'userWorks:progress',
    'userWorks:log',
    'userWorks:finished',
    activeUserWorks
  );
});

ipcMain.handle('userWorks:cancel', (_event, taskId) => {
  return cancelTask(taskId, activeUserWorks);
});

// ========== IPC：新发布 ==========
ipcMain.handle('newReleases:start', async (_event, payload) => {
  const { taskId, config, cookies, limits, proxy } = payload;
  const jobFile = writeJobFile(taskId, {
    task_type: 'new_releases',
    config,
    cookies,
    limits,
    proxy: proxy || '',
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

  const result = await new Promise((resolve) => {
    const proc = spawn(pythonPath, [script, '--cookie-file', tempCookieFile], {
      cwd: backendRoot,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    trackProcess(proc);

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
      resolve({ valid: false, reason: '校验脚本执行超时（15 秒）' });
    }, 15000);

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
      resolve({ valid: false, reason: err.message });
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      const last = lines.length > 0 ? lines[lines.length - 1] : '';
      console.log(`login_service.py [${pythonPath}] exit=${code} lastStdout=${last.slice(0, 200)} stderr=${stderr.slice(0, 500)}`);
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
          const missing = ['sessionid', 'ttwid', 'passport_csrf_token'].filter((k) => !cookieNames.includes(k));
          showLoginToast(`检测到 ${cookieNames.length} 个 cookie，但缺少登录标识：${missing.join('、')}，请完成登录后再试`);
          resetLoginButton();
          return;
        }
        const cookieString = cookiesToString(cookies);
        console.log('正在后端校验 cookies...');
        const result = await validateCookiesWithBackend(cookieString);
        if (result.valid) {
          console.log('Cookie 校验通过，用户:', result.user ? result.user.nickname : 'unknown');
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
            return u.protocol === 'https:' && (u.hostname === 'www.douyin.com' || u.hostname.endsWith('.douyin.com'));
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
        return parsed.protocol === 'https:' && (parsed.hostname === 'www.douyin.com' || parsed.hostname.endsWith('.douyin.com'));
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
      finish({ success: false, reason: '用户取消登录' });
    });

    loginWin.loadURL(DOUYIN_LOGIN_URL);
  });
});

ipcMain.handle('auth:validate', async (_event, cookieString) => {
  return validateCookiesWithBackend(cookieString || '');
});

// ========== IPC：批量关注/取关 ==========
ipcMain.handle('relation:start', async (_event, payload) => {
  const { taskId, action, secUids, cookies, proxy, config } = payload;
  if (!Array.isArray(secUids) || secUids.length === 0) {
    return { started: false, error: '没有选中用户' };
  }
  const jobFile = writeJobFile(taskId, { task_type: 'relation', action, secUids, cookies, proxy, config });
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

// ========== IPC：字幕生成 ==========
ipcMain.handle('transcript:start', async (_event, payload) => {
  const { taskId, videoPath, mode, apiKey, model, formats, language } = payload;
  const jobFile = writeJobFile(taskId, {
    task_type: 'transcript',
    videoPath,
    mode,
    apiKey,
    model,
    formats,
    language,
  });
  return runPythonBridge(
    'transcript_bridge.py',
    taskId,
    jobFile,
    getPythonRoot(),
    'transcript:progress',
    'transcript:log',
    'transcript:finished',
    activeBridges
  );
});

ipcMain.handle('transcript:cancel', (_event, taskId) => {
  return cancelTask(taskId, activeBridges);
});

// ========== IPC：云同步 ==========
ipcMain.handle('cloud:backup', async (_event, payload) => {
  const { taskId, dbPath, provider, credentials } = payload;
  const jobFile = writeJobFile(taskId, {
    task_type: 'cloud_backup',
    configPath: settingsPath,
    dbPath,
    cookiePath: '',
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
  const restoreDbPath = payload.dbPath || (outputDir ? path.join(outputDir, 'dy_downloader.db') : '');
  const jobFile = writeJobFile(taskId, {
    task_type: 'cloud_restore',
    token,
    provider,
    credentials,
    outputDir,
    dbPath: restoreDbPath,
    settingsPath,
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
    exec(`taskkill /pid ${pid} /T /F`, (err) => {
      if (err) console.error('taskkill failed', err);
    });
  } else {
    const listCmd = process.platform === 'darwin'
      ? `pgrep -P ${pid}`
      : `ps -o pid= --ppid ${pid}`;
    exec(listCmd, (err, stdout) => {
      const children = (stdout || '')
        .trim()
        .split(/\s+/)
        .map(Number)
        .filter((p) => p > 0 && p !== pid);
      for (const childPid of children) {
        killProcessTree(childPid);
      }
      try {
        process.kill(pid, 'SIGTERM');
      } catch (e) {
        console.error('kill failed', e);
      }
    });
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
