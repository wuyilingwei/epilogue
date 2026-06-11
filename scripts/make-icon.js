'use strict';
// 从 build/icon-mac.svg 生成 macOS icns（iconutil）与通用 icon.png
// sharp 已在依赖树（transformers），零新增依赖。用法：node scripts/make-icon.js
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'build', 'icon-mac.svg');
const ICONSET = path.join(ROOT, 'build', 'icon.iconset');

const SIZES = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
];

(async () => {
  fs.rmSync(ICONSET, { recursive: true, force: true });
  fs.mkdirSync(ICONSET, { recursive: true });
  for (const [px, name] of SIZES) {
    await sharp(SRC, { density: Math.ceil((px / 1024) * 72) || 72 }).resize(px, px).png().toFile(path.join(ICONSET, name));
  }
  execSync(`iconutil -c icns "${ICONSET}" -o "${path.join(ROOT, 'build', 'icon.icns')}"`);
  // 通用 icon.png（窗口/Dock/Linux 用，512）
  await sharp(SRC, { density: 72 }).resize(512, 512).png().toFile(path.join(ROOT, 'build', 'icon.png'));
  fs.rmSync(ICONSET, { recursive: true, force: true });
  console.log('build/icon.icns 与 build/icon.png 已生成');
})();
