const assert = require('node:assert')
const { createLineConsumer } = require('../line-stream.js')

let lines = []
const c = createLineConsumer((l) => lines.push(l), 10)
c.push('dsh web: http://127.0.0.1:3999\nnext\npartial')
assert.deepStrictEqual(lines, ['dsh web: http://127.0.0.1:3999', 'next'])
lines = []; c.push(' rest\n')
assert.deepStrictEqual(lines, ['partial rest'])
lines = []; c.push('a\r\nb\r\n')
assert.deepStrictEqual(lines, ['a', 'b'])
lines = []
const c2 = createLineConsumer((l) => lines.push(l), 4)
c2.push('abcdefghij')
c2.push('rest\nok\n')
assert.deepStrictEqual(lines, ['rest', 'ok'])
lines = []
const c3 = createLineConsumer((l) => lines.push(l), 100)
c3.push('x\ny')
c3.push('\nz\n')
assert.deepStrictEqual(lines, ['x', 'y', 'z'])
console.log('A line-stream: PASS')
