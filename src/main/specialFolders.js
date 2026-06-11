'use strict';
// 检测 OneDrive / iCloud / Dropbox / Google Drive 等特殊云同步文件夹
const fs = require('fs');
const os = require('os');
const path = require('path');

function exists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function kindFromName(name) {
  const n = name.toLowerCase();
  if (n.includes('onedrive')) return 'onedrive';
  if (n.includes('googledrive') || n.includes('google drive')) return 'gdrive';
  if (n.includes('dropbox')) return 'dropbox';
  if (n.includes('icloud') || n.includes('com~apple~clouddocs')) return 'icloud';
  return 'cloud';
}

function detect() {
  const home = os.homedir();
  const found = [];
  const push = (name, p, kind) => {
    if (exists(p) && !found.some((f) => f.path === p)) found.push({ name, path: p, kind });
  };

  if (process.platform === 'darwin') {
    // macOS：所有 File Provider 云盘都挂在 ~/Library/CloudStorage
    const cloudStorage = path.join(home, 'Library', 'CloudStorage');
    if (exists(cloudStorage)) {
      for (const entry of fs.readdirSync(cloudStorage)) {
        const p = path.join(cloudStorage, entry);
        if (exists(p)) push(entry.replace(/-/g, ' '), p, kindFromName(entry));
      }
    }
    push('iCloud Drive', path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'), 'icloud');
    push('Dropbox', path.join(home, 'Dropbox'), 'dropbox');
  } else if (process.platform === 'win32') {
    if (process.env.OneDrive) push('OneDrive', process.env.OneDrive, 'onedrive');
    if (process.env.OneDriveCommercial) push('OneDrive (Work)', process.env.OneDriveCommercial, 'onedrive');
    if (process.env.OneDriveConsumer) push('OneDrive (Personal)', process.env.OneDriveConsumer, 'onedrive');
    push('Dropbox', path.join(home, 'Dropbox'), 'dropbox');
    push('Google Drive', 'G:\\My Drive', 'gdrive');
    push('iCloud Drive', path.join(home, 'iCloudDrive'), 'icloud');
  } else {
    push('OneDrive', path.join(home, 'OneDrive'), 'onedrive');
    push('Dropbox', path.join(home, 'Dropbox'), 'dropbox');
    push('Google Drive (Insync)', path.join(home, 'Insync'), 'gdrive');
  }

  // 常用本地文件夹也一并提供，便于设为归类目标
  for (const name of ['Desktop', 'Documents', 'Downloads']) {
    push(name, path.join(home, name), 'standard');
  }
  return found;
}

module.exports = { detect };
