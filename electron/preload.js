'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gt', {
  listSaves:  ()        => ipcRenderer.invoke('save:list'),
  newCareer:  (slot, p) => ipcRenderer.invoke('career:new', slot, p),
  loadCareer: slot      => ipcRenderer.invoke('career:load', slot),
  deleteSlot: slot      => ipcRenderer.invoke('career:delete', slot),
  saveNow:    ()        => ipcRenderer.invoke('career:save'),
  state:      ()        => ipcRenderer.invoke('career:state'),
  advance:    ()        => ipcRenderer.invoke('career:advance'),
  quit:       ()        => ipcRenderer.invoke('app:quit'),
  paths:      ()        => ipcRenderer.invoke('app:paths')
});
