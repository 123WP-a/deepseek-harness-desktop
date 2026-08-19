// DeepSeek Harness desktop shell — preload.
// Exposes a tiny window-control bridge to the injected in-page title bar.
// contextIsolation stays on; only this minimal surface is exposed.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopWindow', {
  minimize: () => ipcRenderer.send('dsh-desktop:minimize'),
  toggleMaximize: () => ipcRenderer.send('dsh-desktop:toggle-maximize'),
  close: () => ipcRenderer.send('dsh-desktop:close'),
  isMaximized: () => ipcRenderer.invoke('dsh-desktop:is-maximized'),
  onMaximizedChange: (callback) => {
    const listener = (_event, maximized) => callback(Boolean(maximized))
    ipcRenderer.on('dsh-desktop:maximized', listener)
    return () => ipcRenderer.removeListener('dsh-desktop:maximized', listener)
  },
})
