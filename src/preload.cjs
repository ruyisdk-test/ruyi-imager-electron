const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame && location.origin === 'https://ruyisdk.org') {
  contextBridge.exposeInMainWorld('ruyiImager', {
    getMirrorDownloadURL: (url) => ipcRenderer.invoke('mirror:url', url),
    listDisks: () => ipcRenderer.invoke('disk:list'),
    chooseDisk: (slot, id) => ipcRenderer.invoke('disk:choose', slot, id),
    writeAndVerify: (id, image) => ipcRenderer.invoke('disk:write', id, image),
    setFlashing: (active) => ipcRenderer.invoke('flashing', active === true),
  });
}
