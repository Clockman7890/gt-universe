'use strict';
const Database = require('better-sqlite3');

let handle = null;
let dirty = false;

function close() {
  if (handle) { handle.close(); handle = null; }
  dirty = false;
}

// read a save's headline info without keeping it open
function peek(file) {
  const d = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const c = d.prepare(`SELECT season, week, player_driver_id FROM career WHERE id = 1`).get();
    if (!c) return null;
    const name = c.player_driver_id
      ? d.prepare(`SELECT name, country FROM drivers WHERE id = ?`).get(c.player_driver_id)
      : null;
    return { season: c.season, week: c.week, driver: name ? name.name : null,
             country: name ? name.country : null };
  } finally { d.close(); }
}

function create(file, schemaSql, profile) {
  close();
  handle = new Database(file);
  handle.pragma('journal_mode = WAL');
  handle.exec(schemaSql);

  const now = new Date().toISOString();
  handle.prepare(`
    INSERT INTO career (id, created_at, season, week, calendar_year, time_multiplier)
    VALUES (1, ?, 1, 1, 2020, 2)`).run(now);

  handle.prepare(`
    INSERT INTO sim_constants (id, time_multiplier, tyre_wear, fuel_usage, damage)
    VALUES (1, 2, 1.0, 1.0, 'full')`).run();

  handle.prepare(`INSERT INTO seasons (season, calendar_year) VALUES (1, 2020)`).run();

  // the player is just another row in drivers; generation of the rest comes later
  if (profile) {
    const info = handle.prepare(`
      INSERT INTO drivers
        (name, country, block_id, birth_year, is_player, origin, capital,
         passive_income, pot_speed, pot_judgement, pot_stamina)
      VALUES (@name, @country, @block, @birthYear, 1, 'gt5', @capital,
              @passive, @potSpeed, @potJudgement, @potStamina)`).run({
      name: profile.name,
      country: profile.country,
      block: profile.block,
      birthYear: 2020 - profile.age,
      capital: profile.capital,
      passive: profile.passiveIncome,
      potSpeed: profile.experience,          // real ceiling is set by the generator
      potJudgement: profile.experience,
      potStamina: profile.experience
    });
    handle.prepare(`UPDATE career SET player_driver_id = ? WHERE id = 1`)
          .run(info.lastInsertRowid);
  }

  dirty = false;
  return { file, ok: true };
}

function open(file) {
  close();
  handle = new Database(file, { fileMustExist: true });
  handle.pragma('journal_mode = WAL');
  dirty = false;
  return { file, ok: true };
}

function state() {
  if (!handle) return null;
  const c = handle.prepare(`SELECT * FROM career WHERE id = 1`).get();
  const sim = handle.prepare(`SELECT * FROM sim_constants WHERE id = 1`).get();
  let driver = null;
  if (c.player_driver_id) {
    driver = handle.prepare(`
      SELECT name, country, fia_rating, reputation, capital, passive_income
      FROM drivers WHERE id = ?`).get(c.player_driver_id);
  }
  const unread = handle.prepare(
    `SELECT COUNT(*) n FROM news WHERE read = 0`).get().n;
  return { career: c, sim, driver, unread };
}

function advanceWeek() {
  if (!handle) return null;
  const c = handle.prepare(`SELECT season, week FROM career WHERE id = 1`).get();
  let { season, week } = c;
  week += 1;
  if (week > 52) { week = 1; season += 1; }
  handle.prepare(`UPDATE career SET season = ?, week = ? WHERE id = 1`).run(season, week);
  dirty = true;
  return { season, week };
}

function save() {
  if (handle) handle.pragma('wal_checkpoint(TRUNCATE)');
  dirty = false;
}

const isDirty = () => dirty;

module.exports = { create, open, peek, state, advanceWeek, save, close, isDirty };
