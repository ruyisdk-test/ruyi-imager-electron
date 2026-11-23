const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame && location.href === 'ruyi-imager://app/index.html') {
  contextBridge.exposeInMainWorld('ruyiImager', {
    importArchive: (url) => ipcRenderer.invoke('archive:import', url),
    onArchiveProgress: (callback) => {
      const listener = (_event, progress) => callback(progress);
      ipcRenderer.on('archive:progress', listener);
      return () => ipcRenderer.off('archive:progress', listener);
    },
    listDisks: () => ipcRenderer.invoke('disk:list'),
    chooseDisk: (slot, id) => ipcRenderer.invoke('disk:choose', slot, id),
    writeAndVerify: (id, image) => ipcRenderer.invoke('disk:write', id, image),
    setFlashing: (active) => ipcRenderer.invoke('flashing', active === true),
  });
}
