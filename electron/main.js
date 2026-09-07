'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const db = require('./db');

let win = null;

// ---------------------------------------------------------------- paths
// packaged:   resources/  sits next to the exe
// dev:        ../resources
const RESOURCES = app.isPackaged
  ? process.resourcesPath
  : path.join(__dirname, '..', 'resources');

// saves live in the user's app data, never next to the exe
const SAVE_DIR = path.join(app.getPath('userData'), 'saves');

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 1000,
    minHeight: 660,
    backgroundColor: '#0B0C0F',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  db.close();
  app.quit();
});

// ---------------------------------------------------------------- IPC
const SLOTS = [1, 2, 3];
const slotPath = n => path.join(SAVE_DIR, `slot${n}.db`);

// always returns exactly three entries, empty ones included
ipcMain.handle('save:list', () => SLOTS.map(n => {
  const full = slotPath(n);
  if (!fs.existsSync(full)) return { slot: n, empty: true };
  let meta = null;
  try { meta = db.peek(full); } catch (_) { /* corrupt or older save */ }
  return {
    slot: n, empty: false, path: full,
    mtime: fs.statSync(full).mtimeMs,
    corrupt: meta === null, meta
  };
}));

ipcMain.handle('career:new', (_e, slot, profile) => {
  if (!SLOTS.includes(slot)) throw new Error('bad slot');
  const file = slotPath(slot);
  if (fs.existsSync(file)) throw new Error('slot in use');   // caller must delete first
  const schema = fs.readFileSync(path.join(RESOURCES, 'schema.sql'), 'utf8');
  const world  = JSON.parse(fs.readFileSync(path.join(RESOURCES, 'world.json'), 'utf8'));
  const names  = JSON.parse(fs.readFileSync(path.join(RESOURCES, 'names_db.json'), 'utf8'));
  try {
    return db.create(file, schema, profile, world, names);
  } catch (err) {
    // a partly written save is worse than none at all
    db.close();
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(file + ext); } catch (_) {}
    }
    throw err;
  }
});

ipcMain.handle('career:load', (_e, slot) => db.open(slotPath(slot)));

ipcMain.handle('career:delete', async (_e, slot) => {
  const file = slotPath(slot);
  if (!fs.existsSync(file)) return true;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Delete', 'Cancel'],
    defaultId: 1, cancelId: 1,
    message: `Delete the career in slot ${slot}?`,
    detail: 'This cannot be undone.'
  });
  if (response !== 0) return false;
  db.close();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(file + ext); } catch (_) {}
  }
  return true;
});

ipcMain.handle('career:state', () => db.state());

ipcMain.handle('market:list', () => db.marketList());

ipcMain.handle('market:buy', (_e, modelId, liveryId) => db.marketBuy(modelId, liveryId));

ipcMain.handle('market:image', (_e, modelName) => {
  const specs = JSON.parse(fs.readFileSync(path.join(RESOURCES, 'car_specs.json'), 'utf8'));
  return require('./market').image(RESOURCES, modelName, specs);
});

ipcMain.handle('car:specs', (_e, modelName) => {
  const specs = JSON.parse(fs.readFileSync(path.join(RESOURCES, 'car_specs.json'), 'utf8'));
  return specs.find(s => s.model === modelName) || null;
});

ipcMain.handle('garage:list', () => db.garage());

ipcMain.handle('office:list',     () => db.officeOffers());
ipcMain.handle('office:takeSeat', (_e, id) => db.officeTakeSeat(id));
ipcMain.handle('office:formTeam', (_e, lvl) => db.officeFormTeam(lvl));
ipcMain.handle('office:sign',     (_e, d, en) => db.officeSign(d, en));
ipcMain.handle('entries:mine',    () => db.myEntries());

ipcMain.handle('career:advance', () => db.advanceWeek());

ipcMain.handle('career:close', () => { db.close(); return true; });

ipcMain.handle('app:quit', () => {
  // progress is written to disk as it happens, so there is nothing to confirm
  db.close();
  app.quit();
  return true;
});

ipcMain.handle('app:paths', () => ({
  resources: RESOURCES,
  saves: SAVE_DIR,
  packaged: app.isPackaged,
  version: app.getVersion()
}));
