const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  completeLogin: () => ipcRenderer.invoke('auth:completeLogin'),
});
