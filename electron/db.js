'use strict';
const Database = require('better-sqlite3');
const { buildWorld } = require('./world');
const { generatePopulation } = require('./population');
const { buildEntries, placePlayer } = require('./entries');
const market = require('./market');
const office = require('./office');

let handle = null;
let dirty = false;

// the fourteen driver blocks, needed before any driver row can exist
const BLOCKS = [
  ['trofeo_adriatico',  'Trofeo Mediterraneo GT5',     'europe',       0.11, 1.0],
  ['nordisk',           'Nordisk GT5 Cup',             'europe',       0.07, 1.0],
  ['british_benelux',   'British & Benelux GT5',       'europe',       0.13, 1.0],
  ['alpen_pokal',       'Alpen GT5 Pokal',             'europe',       0.13, 1.0],
  ['central_european',  'Central European GT5 Trophy', 'europe',       0.05, 1.0],
  ['coupe_latine',      'Coupe Latine GT5',            'europe',       0.12, 1.0],
  ['eurasian',          'Eurasian GT5 Series',         'europe',       0.04, 1.6],
  ['gt5_north_america', 'GT5 North America Cup',       'americas',     0.10, 1.0],
  ['copa_sudamericana', 'Copa Sudamericana GT5',       'americas',     0.07, 0.7],
  ['lancer_japan',      'Lancer R Cup Japan',          'asia_pacific', 0.05, 0.7],
  ['east_asia_lancer',  'East Asia Lancer Series',     'asia_pacific', 0.03, 0.7],
  ['asian_gt5_trophy',  'Asian GT5 Trophy',            'asia_pacific', 0.04, 0.7],
  ['australasian_arc',  'Australasian ARC Series',     'asia_pacific', 0.04, 1.0],
  ['africa_gulf',       'Africa & Gulf Lancer Cup',    'africa_gulf',  0.02, 0.5]
];

// every country the create screen can pick; the generator adds more later
const COUNTRIES = [
  ['ITA','Italy','trofeo_adriatico'],
  ['GRC','Greece','trofeo_adriatico'],
  ['TUR','Turkey','trofeo_adriatico'],
  ['CYP','Cyprus','trofeo_adriatico'],
  ['BGR','Bulgaria','trofeo_adriatico'],
  ['ROU','Romania','trofeo_adriatico'],
  ['SRB','Serbia','trofeo_adriatico'],
  ['HRV','Croatia','trofeo_adriatico'],
  ['SVN','Slovenia','trofeo_adriatico'],
  ['MKD','North Macedonia','trofeo_adriatico'],
  ['ALB','Albania','trofeo_adriatico'],
  ['SWE','Sweden','nordisk'],
  ['NOR','Norway','nordisk'],
  ['DNK','Denmark','nordisk'],
  ['FIN','Finland','nordisk'],
  ['ISL','Iceland','nordisk'],
  ['GBR','United Kingdom','british_benelux'],
  ['IRL','Ireland','british_benelux'],
  ['NLD','Netherlands','british_benelux'],
  ['BEL','Belgium','british_benelux'],
  ['LUX','Luxembourg','british_benelux'],
  ['DEU','Germany','alpen_pokal'],
  ['AUT','Austria','alpen_pokal'],
  ['CHE','Switzerland','alpen_pokal'],
  ['POL','Poland','alpen_pokal'],
  ['CZE','Czechia','central_european'],
  ['SVK','Slovakia','central_european'],
  ['HUN','Hungary','central_european'],
  ['EST','Estonia','central_european'],
  ['LVA','Latvia','central_european'],
  ['LTU','Lithuania','central_european'],
  ['UKR','Ukraine','central_european'],
  ['FRA','France','coupe_latine'],
  ['ESP','Spain','coupe_latine'],
  ['PRT','Portugal','coupe_latine'],
  ['RUS','Russia','eurasian'],
  ['BLR','Belarus','eurasian'],
  ['KAZ','Kazakhstan','eurasian'],
  ['GEO','Georgia','eurasian'],
  ['ARM','Armenia','eurasian'],
  ['AZE','Azerbaijan','eurasian'],
  ['USA','United States','gt5_north_america'],
  ['CAN','Canada','gt5_north_america'],
  ['BRA','Brazil','copa_sudamericana'],
  ['ARG','Argentina','copa_sudamericana'],
  ['CHL','Chile','copa_sudamericana'],
  ['URY','Uruguay','copa_sudamericana'],
  ['PRY','Paraguay','copa_sudamericana'],
  ['BOL','Bolivia','copa_sudamericana'],
  ['PER','Peru','copa_sudamericana'],
  ['COL','Colombia','copa_sudamericana'],
  ['ECU','Ecuador','copa_sudamericana'],
  ['VEN','Venezuela','copa_sudamericana'],
  ['JPN','Japan','lancer_japan'],
  ['CHN','China','east_asia_lancer'],
  ['TWN','Taiwan','east_asia_lancer'],
  ['HKG','Hong Kong','east_asia_lancer'],
  ['MAC','Macau','east_asia_lancer'],
  ['KOR','South Korea','east_asia_lancer'],
  ['THA','Thailand','asian_gt5_trophy'],
  ['MYS','Malaysia','asian_gt5_trophy'],
  ['SGP','Singapore','asian_gt5_trophy'],
  ['IDN','Indonesia','asian_gt5_trophy'],
  ['PHL','Philippines','asian_gt5_trophy'],
  ['IND','India','asian_gt5_trophy'],
  ['LKA','Sri Lanka','asian_gt5_trophy'],
  ['PAK','Pakistan','asian_gt5_trophy'],
  ['AUS','Australia','australasian_arc'],
  ['NZL','New Zealand','australasian_arc'],
  ['ZAF','South Africa','africa_gulf'],
  ['MAR','Morocco','africa_gulf'],
  ['EGY','Egypt','africa_gulf'],
  ['NGA','Nigeria','africa_gulf'],
  ['KEN','Kenya','africa_gulf'],
  ['AGO','Angola','africa_gulf'],
  ['ARE','United Arab Emirates','africa_gulf'],
  ['SAU','Saudi Arabia','africa_gulf'],
  ['QAT','Qatar','africa_gulf'],
  ['BHR','Bahrain','africa_gulf'],
  ['KWT','Kuwait','africa_gulf'],
  ['OMN','Oman','africa_gulf'],
  ['JOR','Jordan','africa_gulf'],
  ['LBN','Lebanon','africa_gulf'],
];

function seedReference(d) {
  const b = d.prepare(`INSERT OR IGNORE INTO blocks
      (id, name, continent, production_weight, passive_multiplier)
      VALUES (?,?,?,?,?)`);
  for (const row of BLOCKS) b.run(...row);
  const c = d.prepare(`INSERT OR IGNORE INTO countries (code, name, block_id, weight)
      VALUES (?,?,?,1.0)`);
  for (const row of COUNTRIES) c.run(...row);
}

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

function create(file, schemaSql, profile, world, namesDb) {
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

  seedReference(handle);


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

  // one transaction: either the whole world exists or the file is discarded
  const seed = (Date.now() ^ 0x5f3759df) >>> 0;
  handle.transaction(() => {
    buildWorld(handle, world, BLOCKS.map(b => ({
      id: b[0], name: b[1], continent: b[2], weight: b[3], passive: b[4]
    })), COUNTRIES.map(c => ({ code: c[0], name: c[1], block: c[2] })), true);
    const ctx = generatePopulation(handle, world, BLOCKS.map(b => ({
      id: b[0], name: b[1], continent: b[2], weight: b[3], passive: b[4]
    })), COUNTRIES.map(c => ({ code: c[0], name: c[1], block: c[2] })), namesDb, seed);
    buildEntries(handle, world, ctx, profile);
    if (profile) placePlayer(handle, world, ctx, profile);
  })();


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
  return { career: c, sim, driver, unread, tutorial: c.tutorial_step };
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

function marketList() { return handle ? market.list(handle) : null; }
function marketBuy(modelId, liveryId) {
  if (!handle) throw new Error('No career open.');
  const res = market.buy(handle, modelId, liveryId);
  dirty = true;
  return res;
}
function officeOffers() { return handle ? office.offers(handle) : null; }
function officeTakeSeat(entryId) { const r = office.takeSeat(handle, entryId); dirty = true; return r; }
function officeFormTeam(level, name) { const r = office.formTeam(handle, level, name); dirty = true; return r; }
function officeSign(d, e)        { const r = office.signDriver(handle, d, e);  dirty = true; return r; }

function myEntries() {
  if (!handle) return [];
  return handle.prepare(`
    SELECT e.id, cm.name car, l.livery_name livery, c.name championship,
           (SELECT COUNT(*) FROM entry_drivers ed WHERE ed.entry_id = e.id) filled,
           cl.drivers_per_car need
    FROM entries e
    JOIN teams t ON t.id = e.team_id
    JOIN chassis ch ON ch.id = e.chassis_id
    JOIN car_models cm ON cm.id = ch.model_id
    JOIN liveries l ON l.id = e.livery_id
    JOIN championships c ON c.id = e.championship_id
    JOIN championship_levels cl ON cl.id = c.level_id
    WHERE t.owner_driver_id = (SELECT player_driver_id FROM career WHERE id = 1)
      AND t.status = 'active' AND e.season = (SELECT season FROM career WHERE id = 1)`).all();
}

function setTutorial(step) {
  if (!handle) return null;
  handle.prepare(`UPDATE career SET tutorial_step = ? WHERE id = 1`).run(step);
  dirty = true;
  return step;
}

function home() {
  if (!handle) return null;
  const c = handle.prepare(`SELECT * FROM career WHERE id = 1`).get();
  const d = handle.prepare(`SELECT * FROM drivers WHERE id = ?`).get(c.player_driver_id);
  if (!d) return null;
  const sk = handle.prepare(`SELECT * FROM driver_skills WHERE driver_id = ?`).get(d.id);
  const country = handle.prepare(`SELECT name FROM countries WHERE code = ?`).get(d.country);
  const block = handle.prepare(`SELECT name FROM blocks WHERE id = ?`).get(d.block_id);
  const team = handle.prepare(`SELECT * FROM teams WHERE owner_driver_id = ?
      AND status = 'active' AND is_privateer = 0`).get(d.id);
  const priv = handle.prepare(`SELECT * FROM teams WHERE owner_driver_id = ?
      AND status = 'active' AND is_privateer = 1`).get(d.id);
  const entry = handle.prepare(`
    SELECT ch.name championship, cm.name car, l.livery_name livery, t.name team, t.is_privateer
    FROM entry_drivers ed JOIN entries e ON e.id = ed.entry_id
    JOIN championships ch ON ch.id = e.championship_id
    JOIN chassis c2 ON c2.id = e.chassis_id JOIN car_models cm ON cm.id = c2.model_id
    JOIN liveries l ON l.id = e.livery_id JOIN teams t ON t.id = e.team_id
    WHERE ed.driver_id = ? AND e.season = ?`).get(d.id, c.season);
  const spend = handle.prepare(`SELECT COALESCE(SUM(amount),0) n FROM ledger
      WHERE entity_type = 'driver' AND entity_id = ? AND season = ?`).get(d.id, c.season).n;
  const cars = handle.prepare(`SELECT COUNT(*) n FROM chassis ch JOIN teams t ON t.id = ch.owner_team_id
      WHERE t.owner_driver_id = ? AND t.status = 'active'`).get(d.id).n;
  return {
    driver: {
      name: d.name, country: country ? country.name : d.country, code: d.country,
      age: c.calendar_year - d.birth_year, rating: d.fia_rating, reputation: d.reputation,
      capital: d.capital, passive: d.passive_income, block: block ? block.name : d.block_id
    },
    skills: sk, entry, cars,
    team: team ? { id: team.id, name: team.name, engineering: team.engineering } : null,
    privateer: !!priv, season: c.season, week: c.week, netThisSeason: spend
  };
}

function newsList() {
  if (!handle) return [];
  return handle.prepare(`
    SELECT id, season, week, category, headline, body, read
    FROM news ORDER BY season DESC, week DESC, id DESC LIMIT 60`).all();
}
function newsRead() {
  if (!handle) return 0;
  const n = handle.prepare(`UPDATE news SET read = 1 WHERE read = 0`).run().changes;
  if (n) dirty = true;
  return n;
}

function garage() {
  if (!handle) return null;
  return handle.prepare(`
    SELECT ch.id, cm.name model, cm.class, l.livery_name livery, ch.value,
           ch.engine_hours, ch.chassis_hours, t.is_privateer mine, t.name team,
           c.name championship
    FROM entry_drivers ed
    JOIN entries e ON e.id = ed.entry_id
    JOIN chassis ch ON ch.id = e.chassis_id
    JOIN car_models cm ON cm.id = ch.model_id
    JOIN liveries l ON l.id = e.livery_id
    JOIN teams t ON t.id = e.team_id
    JOIN championships c ON c.id = e.championship_id
    JOIN drivers d ON d.id = ed.driver_id
    WHERE d.is_player = 1 AND e.season = (SELECT season FROM career WHERE id = 1)`).all();
}

module.exports = { create, open, peek, state, advanceWeek, save, close, isDirty,
                   marketList, marketBuy, garage, myEntries, newsList, newsRead, home, setTutorial,
                   officeOffers, officeTakeSeat, officeFormTeam, officeSign,
                   handle: () => handle };
