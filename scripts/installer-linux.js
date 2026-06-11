'use strict';
// Linux deb：node scripts/installer-linux.js <arch(x64|arm64)> <tag>
const installer = require('electron-installer-debian');
const fs = require('fs');
const path = require('path');

const arch = process.argv[2] || 'x64';
const tag = process.argv[3] || 'dev';
const debArch = arch === 'x64' ? 'amd64' : 'arm64';
const root = path.resolve(__dirname, '..');
const dest = path.join(root, 'dist', 'installers');

installer({
  src: path.join(root, 'dist', `Epilogue-linux-${arch}`),
  dest,
  arch: debArch,
  options: {
    name: 'epilogue',
    productName: 'Epilogue',
    genericName: 'AI File Workflow',
    description: 'AI file workflow — understand, organize and recall your files.',
    categories: ['Utility'],
    icon: path.join(root, 'build', 'icon.png'),
    maintainer: 'Wuyilingwei',
    homepage: 'https://github.com/wuyilingwei/epilogue',
    bin: 'Epilogue',
  },
}).then(
  () => {
    // 统一资产命名
    const out = fs.readdirSync(dest).find((f) => f.endsWith('.deb'));
    fs.renameSync(path.join(dest, out), path.join(dest, `Epilogue-${tag}-linux-${arch}.deb`));
    console.log('deb done');
  },
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
