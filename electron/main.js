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
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch (_) { return {}; }
}
function writeSettings(obj) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 1), 'utf8');
  return obj;
}

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
  if (!readSettings().aiFolder)
    throw new Error('Set the Automobilista 2 custom AI folder in Settings first.');
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

ipcMain.handle('career:load', (_e, slot) => {
  const world = JSON.parse(fs.readFileSync(path.join(RESOURCES, 'world.json'), 'utf8'));
  const names = JSON.parse(fs.readFileSync(path.join(RESOURCES, 'names_db.json'), 'utf8'));
  return db.open(slotPath(slot), world, names);
});

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
ipcMain.handle('market:buyMany', (_e, modelId, ids) => db.marketBuyMany(modelId, ids));

ipcMain.handle('market:used',     () => db.usedList());
ipcMain.handle('market:buyUsed',  (_e, ch, lv) => db.buyUsed(ch, lv));
ipcMain.handle('market:sellQuote',(_e, ch) => db.sellQuote(ch));
ipcMain.handle('market:sell',     (_e, ch) => db.sellCar(ch));
ipcMain.handle('market:fixQuote', (_e, ch) => db.rebuildQuote(ch));
ipcMain.handle('market:fix',      (_e, ch) => db.rebuildEngine(ch));

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
ipcMain.handle('office:eligible', () => db.whereToRace());
ipcMain.handle('office:choose',   (_e, id) => db.pickChampionship(id));
ipcMain.handle('office:facDue',   () => db.facilitiesDue());
ipcMain.handle('office:facUp',    () => db.upgradeFacilities());
ipcMain.handle('office:takeSeat', (_e, id) => db.officeTakeSeat(id));
ipcMain.handle('office:formTeam', (_e, lvl, name) => db.officeFormTeam(lvl, name));
ipcMain.handle('office:sign',     (_e, d, en) => db.officeSign(d, en));
ipcMain.handle('entries:mine',    () => db.myEntries());
ipcMain.handle('lineup:get',      () => db.lineup());
ipcMain.handle('lineup:set',      (_e, en, role, dr) => db.setCarDriver(en, role, dr));
ipcMain.handle('home:info',       () => db.home());
ipcMain.handle('tutorial:set',    (_e, n) => db.setTutorial(n));
ipcMain.handle('race:info',       () => db.raceInfo());
ipcMain.handle('race:prepare',    (_e, leg) => db.racePrepare(leg));
ipcMain.handle('race:sheet',      (_e, r, l) => db.raceSheet(r, l));
ipcMain.handle('race:cost',       () => db.myRoundCost());
ipcMain.handle('race:withdraw',   (_e, rd, en) => db.withdrawFromRound(rd, en));
ipcMain.handle('race:simulate',   (_e, rd, lg) => db.simulateLeg(rd, lg));
ipcMain.handle('sponsors:mine',   () => db.sponsors());

ipcMain.handle('sm:read', () => {
  try { return require('./sharedmem').classification(); }
  catch (e) { return { ok: false, reason: 'error', message: e.message }; }
});

ipcMain.handle('sm:status', () => {
  try { return require('./sharedmem').status(); }
  catch (e) { return { state: 'error', koffi: false, detail: e.message }; }
});
ipcMain.handle('race:save',       (_e, l, e) => db.raceSave(l, e));

ipcMain.handle('settings:get', () => readSettings());

ipcMain.handle('settings:pickAiFolder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Where does Automobilista 2 keep its custom AI files?',
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths.length) return readSettings();
  const s = readSettings();
  s.aiFolder = res.filePaths[0];
  return writeSettings(s);
});

ipcMain.handle('ams2:path', () => readSettings().aiFolder || null);

ipcMain.handle('race:write', (_e, files) => {
  const dir = readSettings().aiFolder;
  if (!dir) throw new Error('Set the Automobilista 2 folder first.');
  const written = [];
  for (const f of files) {
    const target = path.join(dir, f.name);
    fs.writeFileSync(target, f.xml, 'utf8');
    written.push({ name: f.name, path: target, bytes: Buffer.byteLength(f.xml) });
  }
  return { dir, written };
});
ipcMain.handle('world:tree',      () => db.worldTree());
ipcMain.handle('world:standings', (_e, id, kind) => db.standings(id, kind));
ipcMain.handle('world:calendar',  (_e, id) => db.calendar(id));
ipcMain.handle('news:list',       () => db.newsList());
ipcMain.handle('news:read',       () => db.newsRead());

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
