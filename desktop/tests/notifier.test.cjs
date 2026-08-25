const assert = require('node:assert')
const { parseDesktopEvent, makeDesktopNotifier } = require('../notifier.js')

let ev = parseDesktopEvent('dsh desktop-event: {"type":"notify","title":"Task done","body":"ok"}')
assert.strictEqual(ev.title, 'Task done'); assert.strictEqual(ev.body, 'ok'); assert.strictEqual(ev.type, 'notify')
ev = parseDesktopEvent('dsh desktop-event: {"title":"x"}')
assert.strictEqual(ev.type, 'notify'); assert.strictEqual(ev.body, '')
assert.strictEqual(parseDesktopEvent('garbage'), null)
assert.strictEqual(parseDesktopEvent('dsh desktop-event: {bad'), null)
assert.strictEqual(parseDesktopEvent('dsh desktop-event: "str"'), null)
assert.strictEqual(parseDesktopEvent('dsh desktop-event: {"body":"b"}'), null)
let shown = null
const N = class { constructor(opts) { shown = opts } show() {} }; N.isSupported = () => true
makeDesktopNotifier({ Notification: N })({ type: 'notify', title: 'T', body: 'B' })
assert.strictEqual(shown.title, 'T')
let logged = []
makeDesktopNotifier({ Notification: null, log: (m) => logged.push(m) })({ type: 'notify', title: 'T', body: 'B' })
assert.ok(logged.length > 0)
console.log('notifier tests: PASS')
