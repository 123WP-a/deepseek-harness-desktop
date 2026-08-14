// Optional electron-builder config for a single-file portable exe. The folder
// layout produced by scripts/build.js is the primary deliverable (it needs no
// extra binary downloads); this config adds the `portable` target on top of
// the same app. Run: npx electron-builder --win portable
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
    'appearance.js',
    'package.json',
  ],
  win: {
    target: ['portable', 'dir'],
    icon: path.join(__dirname, 'assets', 'deepseek.ico'),
  },
  portable: {
    artifactName: 'DeepSeek-Harness-${version}-portable.exe',
  },
  npmRebuild: false,
  asar: true,
}
