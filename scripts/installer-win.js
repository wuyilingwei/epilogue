'use strict';
// Windows Setup.exe（Squirrel）：node scripts/installer-win.js <arch> <tag>
const { createWindowsInstaller } = require('electron-winstaller');
const path = require('path');

const arch = process.argv[2] || 'x64';
const tag = process.argv[3] || 'dev';
const root = path.resolve(__dirname, '..');

createWindowsInstaller({
  appDirectory: path.join(root, 'dist', `Epilogue-win32-${arch}`),
  outputDirectory: path.join(root, 'dist', 'installers'),
  exe: 'Epilogue.exe',
  setupExe: `Epilogue-${tag}-win32-${arch}-Setup.exe`,
  setupIcon: path.join(root, 'build', 'icon.ico'),
  noMsi: true,
}).then(
  () => console.log('Setup.exe done'),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
