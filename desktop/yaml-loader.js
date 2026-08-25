// Shared js-yaml resolution for desktop shell modules that read the
// server's YAML documents (settings, patch layers). Resolution mirrors the
// server runtime closure first, then this layout node_modules; under plain
// node (tests) the same defaults find desktop/runtime.

const path = require('node:path')

let cached = null

function defaultModuleRoots() {
  let packaged = false
  let appPath
  try {
    const { app } = require('electron')
    packaged = app.isPackaged
    appPath = app.getAppPath()
  } catch {
    // plain node (tests, scripts): fall through to the dev layout
  }
  const roots = []
  if (packaged === true && appPath !== undefined) roots.push(path.join(appPath, '..', 'runtime', 'node_modules'))
  roots.push(path.join(__dirname, 'runtime', 'node_modules'))
  roots.push(path.join(__dirname, 'node_modules'))
  return roots
}

function resolveYaml(extraRoots = []) {
  if (cached !== null) return cached
  try {
    cached = require(require.resolve('js-yaml', { paths: [...extraRoots, ...defaultModuleRoots()] }))
  } catch {
    cached = null
  }
  return cached
}

module.exports = { resolveYaml }
