const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame && location.origin === 'https://ruyisdk.org') {
  contextBridge.exposeInMainWorld('ruyiImager', {
    version: 1,
    rawDiskWrite: true,
    getMirrorDownloadURL: (url) => ipcRenderer.invoke('mirror:url', url),
    selectDisk: (slot) => ipcRenderer.invoke('disk:select', slot),
    writeAndVerify: (id, image) => ipcRenderer.invoke('disk:write', id, image),
    setFlashing: (active) => ipcRenderer.invoke('flashing', active === true),
  });
}
