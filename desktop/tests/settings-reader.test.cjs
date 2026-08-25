const assert = require('node:assert')
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')
const { readSetting } = require('../settings-reader.js')

const home = path.join(os.tmpdir(), 'dsh-setreader-' + Date.now()); fs.mkdirSync(home, { recursive: true })
fs.writeFileSync(path.join(home, 'settings.yaml'), 'desktop:\n  closeBehavior: tray\n')
process.env.DSH_HOME = home
assert.strictEqual(readSetting(['desktop', 'closeBehavior'], 'quit'), 'tray')
assert.strictEqual(readSetting(['ui-theme', 'preference'], 'system'), 'system')
fs.writeFileSync(path.join(home, 'settings.yaml'), 'desktop: {}\n')
assert.strictEqual(readSetting(['desktop', 'closeBehavior'], 'quit'), 'quit')
delete process.env.DSH_HOME
fs.rmSync(home, { recursive: true, force: true })
console.log('settings-reader tests: PASS')
