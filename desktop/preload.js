// Preload for the in-page custom title bar (see main.js injectDesktopTitlebar).
// Bridges the injected title bar's window-control buttons to the main process over
// IPC. Runs in a sandboxed, context-isolated renderer, so only this narrow
// surface escapes to the page: nothing else from Node or Electron is exposed.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopWindow', {
  /** Minimize the window. */
  minimize: () => ipcRenderer.send('dsh-desktop:minimize'),
  /** Toggle the window between maximized and restored. */
  toggleMaximize: () => ipcRenderer.send('dsh-desktop:toggle-maximize'),
  /** Close the window (and, via main.js, quit the app). */
  close: () => ipcRenderer.send('dsh-desktop:close'),
  /** Resolve with whether the window is currently maximized. */
  isMaximized: () => ipcRenderer.invoke('dsh-desktop:is-maximized'),
  /**
   * Subscribe to maximize-state changes (fires on maximize/unmaximize).
   * @param {(maximized: boolean) => void} callback
   * @returns {() => void} an unsubscribe function.
   */
  onMaximizedChange: (callback) => {
    const listener = (_event, maximized) => callback(maximized)
    ipcRenderer.on('dsh-desktop:maximized', listener)
    return () => ipcRenderer.removeListener('dsh-desktop:maximized', listener)
  },
})
