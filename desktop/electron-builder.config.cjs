// electron-builder config for the DeepSeek Harness desktop shell. The folder
// layout produced by scripts/build.js is the primary deliverable; this config
// adds the `dir` target (the app folder, with the official icon embedded in
// the exe) and the optional single-file `portable` exe.
// Run: node scripts/build.js  (dir target via electron-builder)
const path = require('node:path')

module.exports = {
  appId: 'ai.deepseek.harness.desktop',
  productName: 'DeepSeek Harness',
  directories: {
    output: path.join(__dirname, 'dist', 'installer'),
    buildResources: path.join(__dirname, 'build'),
  },
  files: [
    'main.js',
    'preload.js',
    'appearance.js',
    'update.js',
    'package.json',
  ],
  win: {
    target: ['portable', 'dir'],
    icon: path.join(__dirname, 'assets', 'deepseek.ico'),
    // The exe filename and the version-info resources (FileDescription,
    // ProductName, CompanyName from package.json author) drive the taskbar
    // button and pinned-item name; keeping them "DeepSeek Harness" makes
    // every surface — window title, taskbar, pinned icon, desktop shortcut —
    // show the same name.
    executableName: 'DeepSeek Harness',
    legalTrademarks: 'DeepSeek Harness Desktop',
  },
  portable: {
    artifactName: 'DeepSeek-Harness-${version}-portable.exe',
  },
  npmRebuild: false,
  asar: true,
}
