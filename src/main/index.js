'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const os = require('os');
const path = require('path');
const settings = require('./settings');
const ipc = require('./ipc');
const scheduler = require('./scheduler');
const { makeT } = require('../shared/locales');

// ---- 低占用：限制 V8 堆、暴露 gc（托盘 trim 用）、按需禁用硬件加速（须在 ready 前）----
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512 --expose-gc');
const bootCfg = settings.get();
if (bootCfg.app.lowPower) app.disableHardwareAcceleration();

const ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');
// 托盘双方案：普通平台用彩色渐变；macOS 用模板图（黑+alpha，深色菜单栏自动渲染为白色）
const TRAY_ICON =
  process.platform === 'darwin'
    ? path.join(__dirname, '..', '..', 'build', 'trayTemplate.png')
    : path.join(__dirname, '..', '..', 'build', 'tray-color.png');

let win = null;
let tray = null;
let pendingAutoScan = null;

// 单实例：二次启动只是打开窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openWindow());
}

// 托盘常驻模式下不预载 UI：窗口只在打开时创建，关闭即销毁，渲染进程内存随之释放
function openWindow(view) {
  if (process.platform === 'darwin') app.dock?.show(); // 托盘态隐藏的 Dock 随窗口恢复（047）
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    if (view) win.webContents.send('view:open', view);
    return;
  }
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'Epilogue',
    icon: ICON,
    backgroundColor: '#000000',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', () => {
    if (view) win.webContents.send('view:open', view);
    if (pendingAutoScan?.length) {
      win.webContents.send('stale:auto', pendingAutoScan);
      pendingAutoScan = null;
    }
  });
  win.on('closed', () => {
    win = null;
    // 托盘纯保活（044/046）：卸索引数据、空闲时关停模型子进程、主动 GC 收缩堆 ——
    // 托盘态只剩 托盘图标 + 定时器 + 设置缓存；一切按需惰性重建
    ipc.unloadStore();
    require('./localModels').idleShutdown();
    // 托盘驻留时不占 Dock（047）：纯托盘存在，重开窗口时恢复
    if (process.platform === 'darwin' && settings.get().app.trayKeepAlive) app.dock?.hide();
    setTimeout(() => {
      try {
        global.gc?.();
        global.gc?.();
        const mu = process.memoryUsage();
        require('./log').log('app', 'tray trim done', { heapMB: Math.round(mu.heapUsed / 1048576), rssMB: Math.round(mu.rss / 1048576) });
      } catch {
        /* gc 不可用时静默 */
      }
    }, 1000);
  });
}

function applyAppSettings(cfg) {
  try {
    // 仅在状态变化时写登录项；未打包的开发版在 macOS 上会被拒绝，忽略即可
    if (app.getLoginItemSettings().openAtLogin !== cfg.app.launchAtLogin) {
      app.setLoginItemSettings({
        openAtLogin: cfg.app.launchAtLogin,
        openAsHidden: true, // 登录启动 → 纯托盘，不弹窗口
        args: ['--hidden'],
      });
    }
  } catch {
    /* 开发模式或受限环境 */
  }
  if (tray) buildTrayMenu(); // 语言切换后同步托盘菜单
  require('./localModels').restartHost(); // 镜像等变更后重启模型子进程
  scheduler.restart();
}

function buildTrayMenu() {
  const t = makeT(settings.get().language);
  tray.setToolTip(t('tray_tooltip'));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t('tray_open'), click: () => openWindow() },
      {
        label: t('tray_scan'),
        click: () => {
          const found = scheduler.tick();
          if (found.length) {
            pendingAutoScan = found;
            openWindow('organize');
          }
        },
      },
      { type: 'separator' },
      { label: t('tray_quit'), click: () => app.quit() },
    ])
  );
}

function createTray() {
  const img = nativeImage.createFromPath(TRAY_ICON);
  if (img.isEmpty()) {
    // 048：图标加载失败（路径/asar 问题）必须可诊断，否则只看到系统默认图标
    require('./log').log('app', 'tray icon failed to load', { path: TRAY_ICON });
  }
  if (process.platform === 'darwin') img.setTemplateImage(true); // 菜单栏深浅自适配（深色下呈白色）
  tray = new Tray(img);
  buildTrayMenu();
  // macOS 设了 context menu 后点击即弹菜单；win/linux 单击直接开窗
  if (process.platform !== 'darwin') tray.on('click', () => openWindow());
}

app.whenReady().then(() => {
  // 默认低优先级，尽量不抢前台资源
  if (bootCfg.app.lowPower) {
    try {
      os.setPriority(process.pid, 10);
    } catch {
      /* 平台不支持 */
    }
  }
  if (process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setIcon(ICON);
    } catch {
      /* 非标准环境 */
    }
  }

  if (!settings.get().stats.firstRunAt) settings.set({ stats: { firstRunAt: Date.now() } });
  settings.seedCleanupFolders(); // 识别 下载/桌面 → 添加为未启用条目（存量用户；新用户在 folders:detect 后）
  ipc.register(() => win, { onSettingsChanged: applyAppSettings });
  createTray();
  scheduler.start({ openWindow, getWindow: () => win });
  applyAppSettings(settings.get());

  // 登录项静默启动 → 托盘 only；手动启动 → 打开界面；ToS 未同意时必须开窗展示
  const hiddenLaunch =
    process.argv.includes('--hidden') ||
    (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAsHidden);
  if (!hiddenLaunch || !settings.get().tosAccepted) openWindow();
  else if (process.platform === 'darwin') app.dock?.hide(); // 静默托盘启动：不占 Dock（047）

  app.on('activate', () => openWindow());
});

app.on('before-quit', () => ipc.flushStore()); // 向量库写盘已防抖，退出前兜底落盘

app.on('window-all-closed', () => {
  // 托盘驻留：窗口全关也不退出（渲染进程已销毁，内存已释放）
  if (settings.get().app.trayKeepAlive) return;
  if (process.platform !== 'darwin') app.quit();
});
