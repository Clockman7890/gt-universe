'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gt', {
  listSaves:  ()        => ipcRenderer.invoke('save:list'),
  newCareer:  (slot, p) => ipcRenderer.invoke('career:new', slot, p),
  loadCareer: slot      => ipcRenderer.invoke('career:load', slot),
  deleteSlot: slot      => ipcRenderer.invoke('career:delete', slot),
  state:      ()        => ipcRenderer.invoke('career:state'),
  advance:    ()        => ipcRenderer.invoke('career:advance'),
  closeCareer:()        => ipcRenderer.invoke('career:close'),
  market:     ()        => ipcRenderer.invoke('market:list'),
  buyCar:     (m, l)    => ipcRenderer.invoke('market:buy', m, l),
  carImage:   name      => ipcRenderer.invoke('market:image', name),
  carSpecs:   name      => ipcRenderer.invoke('car:specs', name),
  garage:     ()        => ipcRenderer.invoke('garage:list'),
  office:     ()        => ipcRenderer.invoke('office:list'),
  takeSeat:   id        => ipcRenderer.invoke('office:takeSeat', id),
  formTeam:   lvl       => ipcRenderer.invoke('office:formTeam', lvl),
  signDriver: (d, e)    => ipcRenderer.invoke('office:sign', d, e),
  myEntries:  ()        => ipcRenderer.invoke('entries:mine'),
  quit:       ()        => ipcRenderer.invoke('app:quit'),
  paths:      ()        => ipcRenderer.invoke('app:paths')
});
