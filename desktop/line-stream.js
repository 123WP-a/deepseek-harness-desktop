// Line-oriented consumption of a byte stream with bounded buffering.
// The desktop shell parses the server child stdout line by line instead of
// accumulating every byte, which grew memory on long-lived servers.

const LINE_BREAK = '\n'
const CR = '\r'

/**
 * Create a line consumer: push(chunk) splits on newlines and hands each
 * complete line (CR stripped) to `onLine`. A partial line longer than
 * `maxPendingBytes` is dropped rather than buffered indefinitely.
 * @param {(line: string) => void} onLine
 * @param {number} maxPendingBytes
 * @returns {{ push: (chunk: string) => void }}
 */
function createLineConsumer(onLine, maxPendingBytes) {
  let pending = ''
  return {
    push(chunk) {
      pending += chunk
      let at = pending.indexOf(LINE_BREAK)
      while (at !== -1) {
        onLine(pending.slice(0, at).replace(/\r$/, ''))
        pending = pending.slice(at + 1)
        at = pending.indexOf(LINE_BREAK)
      }
      if (pending.length > maxPendingBytes) pending = ''
    },
  }
}

module.exports = { createLineConsumer }
