'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentsCoordinatorDesktop', {
  isDesktop: true,
  closeApp: () => ipcRenderer.invoke('desktop:close-app'),
  chooseProjectFolder: () => ipcRenderer.invoke('desktop:choose-project-folder'),
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
});
