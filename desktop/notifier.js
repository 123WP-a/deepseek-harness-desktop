/**
 * Structured desktop-event parsing and OS-notification delivery.
 *
 * The server emits a single line per event: `dsh desktop-event: {json}`.
 * The shell parses strict-prefix + validated JSON and hands it to the OS
 * notification service (falling back to a log line when notifications are
 * unsupported or the module is unavailable).
 */

const DESKTOP_EVENT_PREFIX = 'dsh desktop-event: '

/**
 * Parse one desktop-event protocol line into a normalized record, or null
 * when the line is not a well-formed event (malformed JSON, non-object, or
 * missing title).
 * @param {string} line
 * @returns {{type: string, title: string, body: string} | null}
 */
function parseDesktopEvent(line) {
  if (typeof line !== 'string' || line.indexOf(DESKTOP_EVENT_PREFIX) !== 0) return null
  let data
  try {
    data = JSON.parse(line.slice(DESKTOP_EVENT_PREFIX.length))
  } catch {
    return null
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  if (typeof data.title !== 'string' || data.title === '') return null
  return { type: typeof data.type === 'string' ? data.type : 'notify', title: data.title, body: typeof data.body === 'string' ? data.body : '' }
}

/**
 * Build a notifier that shows an OS notification when supported, otherwise
 * logs the event (the server keeps working either way).
 * @param {{ Notification?: object, log?: (message: string) => void }} deps
 * @returns {(event: {type: string, title: string, body: string}) => void}
 */
function makeDesktopNotifier(deps) {
  const NotificationCtor = deps.Notification
  const log = deps.log || (() => {})
  return (event) => {
    try {
      if (NotificationCtor && typeof NotificationCtor.isSupported === 'function' && NotificationCtor.isSupported()) {
        const n = new NotificationCtor({ title: event.title, body: event.body || '' })
        n.show()
        return
      }
    } catch (error) { log('desktop notify failed: ' + String(error)) }
    log('desktop event (no OS notification): ' + event.title)
  }
}

module.exports = { parseDesktopEvent, makeDesktopNotifier, DESKTOP_EVENT_PREFIX }
