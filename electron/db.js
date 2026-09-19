'use strict';
const Database = require('better-sqlite3');
const { buildWorld } = require('./world');
const { generatePopulation } = require('./population');
const { buildEntries, placePlayer } = require('./entries');
const market = require('./market');
const weekend = require('./weekend');
const season = require('./season');
const winter = require('./winter');
const economy = require('./economy');
const simulate = require('./simulate');
const office = require('./office');

let handle = null;
let dirty = false;
let worldData = null;
let namesData = null;

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
  ['ITA','Italy','trofeo_adriatico',10],
  ['GRC','Greece','trofeo_adriatico',2],
  ['TUR','Turkey','trofeo_adriatico',2.5],
  ['CYP','Cyprus','trofeo_adriatico',0.5],
  ['BGR','Bulgaria','trofeo_adriatico',1],
  ['ROU','Romania','trofeo_adriatico',1.2],
  ['SRB','Serbia','trofeo_adriatico',1],
  ['HRV','Croatia','trofeo_adriatico',1],
  ['SVN','Slovenia','trofeo_adriatico',1.5],
  ['MKD','North Macedonia','trofeo_adriatico',0.4],
  ['ALB','Albania','trofeo_adriatico',0.3],
  ['SWE','Sweden','nordisk',4],
  ['NOR','Norway','nordisk',2],
  ['DNK','Denmark','nordisk',3],
  ['FIN','Finland','nordisk',3.5],
  ['ISL','Iceland','nordisk',0.3],
  ['GBR','United Kingdom','british_benelux',10],
  ['IRL','Ireland','british_benelux',1.5],
  ['NLD','Netherlands','british_benelux',5],
  ['BEL','Belgium','british_benelux',4],
  ['LUX','Luxembourg','british_benelux',0.6],
  ['DEU','Germany','alpen_pokal',10],
  ['AUT','Austria','alpen_pokal',3],
  ['CHE','Switzerland','alpen_pokal',3],
  ['POL','Poland','alpen_pokal',3],
  ['CZE','Czechia','central_european',2.5],
  ['SVK','Slovakia','central_european',1.2],
  ['HUN','Hungary','central_european',2],
  ['EST','Estonia','central_european',0.8],
  ['LVA','Latvia','central_european',0.8],
  ['LTU','Lithuania','central_european',1],
  ['UKR','Ukraine','central_european',2],
  ['FRA','France','coupe_latine',9],
  ['ESP','Spain','coupe_latine',6],
  ['PRT','Portugal','coupe_latine',3],
  ['RUS','Russia','eurasian',4],
  ['BLR','Belarus','eurasian',1],
  ['KAZ','Kazakhstan','eurasian',1],
  ['GEO','Georgia','eurasian',0.5],
  ['ARM','Armenia','eurasian',0.4],
  ['AZE','Azerbaijan','eurasian',0.8],
  ['USA','United States','gt5_north_america',10],
  ['CAN','Canada','gt5_north_america',3],
  ['BRA','Brazil','copa_sudamericana',6],
  ['ARG','Argentina','copa_sudamericana',3],
  ['CHL','Chile','copa_sudamericana',1],
  ['URY','Uruguay','copa_sudamericana',0.8],
  ['PRY','Paraguay','copa_sudamericana',0.5],
  ['BOL','Bolivia','copa_sudamericana',0.4],
  ['PER','Peru','copa_sudamericana',0.6],
  ['COL','Colombia','copa_sudamericana',1.2],
  ['ECU','Ecuador','copa_sudamericana',0.5],
  ['VEN','Venezuela','copa_sudamericana',0.8],
  ['JPN','Japan','lancer_japan',7],
  ['CHN','China','east_asia_lancer',3],
  ['TWN','Taiwan','east_asia_lancer',1],
  ['HKG','Hong Kong','east_asia_lancer',0.8],
  ['MAC','Macau','east_asia_lancer',0.4],
  ['KOR','South Korea','east_asia_lancer',2],
  ['THA','Thailand','asian_gt5_trophy',2],
  ['MYS','Malaysia','asian_gt5_trophy',1.5],
  ['SGP','Singapore','asian_gt5_trophy',1],
  ['IDN','Indonesia','asian_gt5_trophy',1.5],
  ['PHL','Philippines','asian_gt5_trophy',1],
  ['IND','India','asian_gt5_trophy',2],
  ['LKA','Sri Lanka','asian_gt5_trophy',0.5],
  ['PAK','Pakistan','asian_gt5_trophy',0.5],
  ['AUS','Australia','australasian_arc',4],
  ['NZL','New Zealand','australasian_arc',1.5],
  ['ZAF','South Africa','africa_gulf',2.5],
  ['MAR','Morocco','africa_gulf',0.8],
  ['EGY','Egypt','africa_gulf',0.8],
  ['NGA','Nigeria','africa_gulf',0.6],
  ['KEN','Kenya','africa_gulf',0.5],
  ['AGO','Angola','africa_gulf',0.4],
  ['ARE','United Arab Emirates','africa_gulf',2],
  ['SAU','Saudi Arabia','africa_gulf',1.5],
  ['QAT','Qatar','africa_gulf',1],
  ['BHR','Bahrain','africa_gulf',1.2],
  ['KWT','Kuwait','africa_gulf',0.8],
  ['OMN','Oman','africa_gulf',0.5],
  ['JOR','Jordan','africa_gulf',0.5],
  ['LBN','Lebanon','africa_gulf',0.6],
];

function seedReference(d) {
  const b = d.prepare(`INSERT OR IGNORE INTO blocks
      (id, name, continent, production_weight, passive_multiplier)
      VALUES (?,?,?,?,?)`);
  for (const row of BLOCKS) b.run(...row);
  // Relative weight inside its own block: how much racing a country actually
  // produces. The block's own production_weight sets the region's share of the
  // world, this sets who inside it the drivers come from — so Italy supplies
  // its block many times over what Albania does, instead of the two being
  // equally likely because every weight was written as 1.0.
  const c = d.prepare(`INSERT OR IGNORE INTO countries (code, name, block_id, weight)
      VALUES (?,?,?,?)`);
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
  worldData = world;
  namesData = namesDb;
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
    })), COUNTRIES.map(c => ({ code: c[0], name: c[1], block: c[2], weight: c[3] })), true);
    const ctx = generatePopulation(handle, world, BLOCKS.map(b => ({
      id: b[0], name: b[1], continent: b[2], weight: b[3], passive: b[4]
    })), COUNTRIES.map(c => ({ code: c[0], name: c[1], block: c[2], weight: c[3] })), namesDb, seed);
    buildEntries(handle, world, ctx, profile);
    if (profile) placePlayer(handle, world, ctx, profile);
    weekend.buildCalendar(handle, 1);
  })();


  dirty = false;
  return { file, ok: true };
}

// Columns added after a save file was written. A career opened from an older
// build is missing them, and every query that names one would fail, so they are
// put back on open. Only additions belong here: anything that needs data moved
// around is a new career.
const PATCHES = [
  ['career', 'champ_chosen_season', 'INTEGER'],
  ['ledger', 'entry_id', 'INTEGER']
];

// Columns that were renamed rather than added. Each is applied only if the old
// name is still there, so opening the same file twice is harmless.
const RENAMES = [
  ['sponsors', 'per_race', 'per_round'],
  ['sponsors', 'races_left', 'rounds_left']
];

function migrate(db) {
  const hasCol = (t, c) => db.prepare(`SELECT COUNT(*) n FROM pragma_table_info(?)
                                       WHERE name = ?`).get(t, c).n > 0;
  for (const [table, column, type] of PATCHES)
    if (!hasCol(table, column))
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  for (const [table, from, to] of RENAMES)
    if (hasCol(table, from) && !hasCol(table, to))
      db.prepare(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`).run();
}

// A season that was never built. Older builds moved the calendar into a new
// year before rebuilding the world, so a winter that failed halfway left the
// career in a year with no entry lists and no calendar — unrecoverable from
// inside the game, because every screen needs a world that isn't there. The
// rollover is one transaction now and cannot produce this, but saves that
// already hit it are worth rescuing rather than throwing away.
function repairSeason(db) {
  const c = db.prepare(`SELECT season, week FROM career WHERE id = 1`).get();
  if (!c) return null;
  const rounds = db.prepare(`SELECT COUNT(*) n FROM rounds WHERE season = ?`).get(c.season).n;
  const entries = db.prepare(`SELECT COUNT(*) n FROM entries WHERE season = ?`).get(c.season).n;
  if (rounds || entries) return null;                 // the year exists, nothing to do
  if (c.season <= 1 || !worldData || !namesData) return null;

  db.transaction(() => {
    winter.runWinter(db, worldData, namesData, c.season);
    season.rollBoP(db, c.season);
    if (!db.prepare(`SELECT COUNT(*) n FROM rounds WHERE season = ?`).get(c.season).n)
      weekend.buildCalendar(db, c.season);
    // The four weeks are given back. This year never actually started — there
    // was nothing to enter and nothing to sign — so charging the player for the
    // weeks they spent staring at an empty world would be punishing them for a
    // fault of ours.
    db.prepare(`UPDATE career SET week = 1 WHERE id = 1`).run();
    db.prepare(`INSERT INTO news (season,week,category,headline,body) VALUES (?,1,'market',?,?)`)
      .run(c.season, 'The season has been rebuilt',
           'This career was saved by an older version that left the year empty: no teams, '
           + 'no entry lists, no calendar. All of it has been put back, and the four weeks '
           + 'of the entry window start again from now, since there was never anything to '
           + 'enter. Go to Home and decide how you will go racing.');
  })();
  return { season: c.season, weeksReturned: c.week > 1 };
}

function open(file, world, namesDb) {
  if (world) worldData = world;
  if (namesDb) namesData = namesDb;
  close();
  handle = new Database(file, { fileMustExist: true });
  handle.pragma('journal_mode = WAL');
  migrate(handle);
  let repaired = null;
  try { repaired = repairSeason(handle); }
  catch (e) { repaired = { failed: e.message }; }
  dirty = !!repaired;
  return { file, ok: true, repaired };
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
  let week = c.week + 1, s = c.season;
  if (week > 52) { week = 1; s += 1; }
  const setClock = () =>
    handle.prepare(`UPDATE career SET season = ?, week = ? WHERE id = 1`).run(s, week);

  // A new year: the classes are rebalanced on last season's evidence before
  // anything can be entered, then the retainers are paid.
  if (s > c.season) {
    // The clock and the world turn over together or not at all.
    //
    // This used to move the calendar to the new season first and rebuild the
    // world afterwards. Anything that went wrong in between — and a winter
    // touches every table there is — left a career stranded in a year that had
    // never been built: no teams carried over, no entry lists, no calendar, no
    // seats to sign. Every further click just advanced the week inside that
    // empty year, and nothing the player did could get them onto a grid,
    // because there was no grid. One transaction means a failed winter leaves
    // the career exactly where it was, with the error visible, instead of
    // quietly destroying it.
    let wintered = null, bop = null;
    handle.transaction(() => {
      setClock();
      if (worldData && namesData) wintered = winter.runWinter(handle, worldData, namesData, s);
      bop = season.rollBoP(handle, s);
      // grids exist now, so the season has a calendar to run
      const hasCalendar = handle.prepare(`SELECT COUNT(*) n FROM rounds WHERE season = ?`)
        .get(s).n;
      if (!hasCalendar) weekend.buildCalendar(handle, s);
    })();

    if (bop && bop.moved && bop.moved.length) {
      const pegged = bop.moved.filter(x => x.dir < 0).map(x => x.model);
      const helped = bop.moved.filter(x => x.dir > 0).map(x => x.model);
      handle.prepare(`INSERT INTO news (season,week,category,headline,body)
          VALUES (?,?,'manufacturer',?,?)`).run(s, week,
        'The balance of performance is revised',
        [pegged.length ? `Pegged back: ${pegged.join(', ')}.` : '',
         helped.length ? `Given help: ${helped.join(', ')}.` : ''].filter(Boolean).join(' '));
    }
  } else {
    setClock();
  }
  if (week === 1) economy.payPassive(handle);

  // the entry list closes at the end of week 4; anything still open is taken
  let filled = null;
  if (c.week === 4 && week === 5 && worldData) {
    filled = season.lockEntries(handle, worldData);
    // the lock puts new people into graded seats too, and they need licences
    // just as much as the ones the winter placed
    winter.gradeSeats(handle, s,
      handle.prepare(`SELECT calendar_year y FROM career WHERE id = 1`).get().y);


    const short = filled.filter(f => f.to < f.target);
    handle.prepare(`INSERT INTO news (season,week,category,headline,body)
        VALUES (?,?,'market',?,?)`).run(s, week, 'The entry lists are closed',
      short.length ? `${short.length} championship${short.length === 1 ? '' : 's'} start short of cars.`
                   : 'Every championship starts the season with a full grid.');
  }

  // every round due this week is settled and run, except the player's own,
  // which waits for them at the Race screen
  const ran = runWeek(s, week);

  dirty = true;
  return { season: s, week, filled, ran };
}

// Everything the world does in a week while the player is elsewhere.
function runWeek(seasonNo, week) {
  const me = handle.prepare(`SELECT player_driver_id p FROM career WHERE id = 1`).get().p;
  // anything whose week has come, and anything left hanging behind it
  const due = handle.prepare(`
    SELECT r.id, r.championship_id, r.week,
           COALESCE(ch.shares_entries_with, ch.id) field_champ
    FROM rounds r JOIN championships ch ON ch.id = r.championship_id
    WHERE r.season = ? AND r.week <= ? AND r.played = 0
    ORDER BY r.week, r.id`).all(seasonNo, week);
  if (!due.length) return null;

  let races = 0, absent = 0;
  for (const round of due) {
    // who can afford to be there
    const settled = economy.settleRound(handle, round.id);
    absent += settled.missing.length;
    for (const m of settled.missing.slice(0, 3))
      handle.prepare(`INSERT INTO news (season,week,category,headline,body)
                      VALUES (?,?,'driver',?,?)`)
        .run(seasonNo, week, `${m.driver || m.team} misses the round`,
             'Cannot meet the cost of the meeting.');

    // The player's own round waits for them at the Race screen — unless they
    // have withdrawn, in which case the race goes ahead without them.
    const mine = handle.prepare(`
      SELECT e.id FROM entries e JOIN entry_drivers ed ON ed.entry_id = e.id
      WHERE ed.driver_id = ? AND e.season = ? AND e.championship_id = ?`)
      .get(me, seasonNo, round.field_champ);
    if (mine) {
      const away = handle.prepare(`SELECT 1 FROM round_absences
          WHERE round_id = ? AND entry_id = ?`).get(round.id, mine.id);
      if (!away) {
        // the weekend is still theirs to run; only once it is behind them does
        // the round go ahead without them
        if (round.week >= week) continue;
        handle.prepare(`INSERT OR REPLACE INTO round_absences (round_id,entry_id,reason)
                        VALUES (?,?,'skipped')`).run(round.id, mine.id);
        handle.prepare(`INSERT INTO news (season,week,category,headline,body)
                        VALUES (?,?,'driver',?,?)`)
          .run(seasonNo, week, 'You missed the round',
               'The meeting went ahead without you.');
      }
    }

    const legs = handle.prepare(`SELECT leg_no FROM legs WHERE round_id = ? AND simulated = 0
                                 ORDER BY leg_no`).all(round.id);
    for (const l of legs) {
      const out = simulate.simulateLeg(handle, round.id, l.leg_no);
      if (out.entries.length) {
        const leg = handle.prepare(`SELECT id FROM legs WHERE round_id = ? AND leg_no = ?`)
          .get(round.id, l.leg_no);
        season.saveResults(handle, leg.id, out.entries);
        races++;
      }
    }
    economy.reviewSponsors(handle, round.id);
  }
  return { races, absent };
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
function marketBuyMany(modelId, liveryIds) {
  if (!handle) throw new Error('No career open.');
  const res = market.buyMany(handle, modelId, liveryIds);
  dirty = true;
  return res;
}
function ownedCars() { return handle ? market.ownedCars(handle) : null; }
function enterOwned(chassisId, liveryId) {
  if (!handle) throw new Error('No career open.');
  const res = market.enterOwned(handle, chassisId, liveryId);
  dirty = true;
  return res;
}
function usedList() { return handle ? market.usedList(handle) : null; }
function buyUsed(chassisId, liveryId) {
  if (!handle) throw new Error('No career open.');
  const res = market.buyUsed(handle, chassisId, liveryId);
  dirty = true;
  return res;
}
function sellQuote(chassisId) { return handle ? market.sellQuote(handle, chassisId) : null; }
function sellCar(chassisId) {
  if (!handle) throw new Error('No career open.');
  const res = market.sellCar(handle, chassisId);
  dirty = true;
  return res;
}
function rebuildQuote(chassisId) { return handle ? market.rebuildQuote(handle, chassisId) : null; }
function rebuildEngine(chassisId) {
  if (!handle) throw new Error('No career open.');
  const res = market.rebuildEngine(handle, chassisId);
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
           (SELECT MAX(cl2.drivers_per_car) FROM championships c3
            JOIN championship_levels cl2 ON cl2.id = c3.level_id
            WHERE c3.id = e.championship_id
               OR c3.shares_entries_with = e.championship_id) need
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

function ams2Path() {
  if (!handle) return null;
  const r = handle.prepare(`SELECT ams2_path FROM career WHERE id = 1`).get();
  return r ? r.ams2_path : null;
}
function setAms2Path(p) {
  if (!handle) return null;
  handle.prepare(`UPDATE career SET ams2_path = ? WHERE id = 1`).run(p);
  dirty = true;
  return p;
}

function raceInfo() {
  if (!handle) return null;
  const r = weekend.nextRound(handle);
  if (!r) return null;
  return {
    round: r.round_no, championship: r.championship, track: r.track,
    week: r.week, weeksAway: r.weeksAway, thisWeek: r.thisWeek,
    date: r.race_date, legs: r.legs.length,
    legState: r.legs.map(l => ({
      leg: l.leg_no, date: l.race_date, start: l.start_time,
      done: !!l.simulated
    })),
    gridSize: handle.prepare(`SELECT COUNT(*) n FROM entries
        WHERE season = (SELECT season FROM career WHERE id=1)
          AND championship_id = (SELECT COALESCE(shares_entries_with, id)
                                 FROM championships WHERE id = ?)`)
        .get(r.championship_id).n,
    lengthKm: r.length_km, roundId: r.id, played: r.played
  };
}
function racePrepare(legNo) {
  if (!handle) return null;
  const r = weekend.nextRound(handle);
  if (!r) return null;
  return Object.assign({ championship: r.championship, track: r.track,
                         round: r.round_no, roundId: r.id }, weekend.prepareLeg(handle, r, legNo || 1));
}

// ---------------------------------------------------------------- economy
function roundBill(entryId, roundId) {
  return handle ? economy.roundCost(handle, entryId, roundId) : null;
}
function myRoundCost() {
  if (!handle) return null;
  const r = weekend.nextRound(handle);
  if (!r) return null;
  const me = handle.prepare(`SELECT player_driver_id p FROM career WHERE id = 1`).get().p;
  const mine = handle.prepare(`
    SELECT e.id FROM entries e JOIN entry_drivers ed ON ed.entry_id = e.id
    WHERE ed.driver_id = ? AND e.season = (SELECT season FROM career WHERE id = 1)
      AND e.championship_id = (SELECT COALESCE(shares_entries_with, id)
                               FROM championships WHERE id = ?)`)
    .get(me, r.championship_id);
  if (!mine) return null;
  const cost = economy.roundCost(handle, mine.id, r.id);
  if (!cost) return null;
  const purse = economy.purseOf(handle, cost);
  const me2 = handle.prepare(`SELECT player_driver_id p FROM career WHERE id = 1`).get().p;
  // A contracted driver has already paid for the seat; the running costs of the
  // meeting belong to whoever owns the car.
  const mineToPay = purse.kind === 'driver' && purse.id === me2;

  // An owner pays for every car they enter, not only the one they sit in, so
  // the figure on the race card has to be the whole bill for the weekend or it
  // understates what is about to leave their account.
  let fleet = null;
  if (mineToPay) {
    const mates = handle.prepare(`
      SELECT e.id FROM entries e JOIN teams t ON t.id = e.team_id
      WHERE t.owner_driver_id = @me AND e.season = @season
        AND e.championship_id = @champ
        AND e.id NOT IN (SELECT entry_id FROM round_absences WHERE round_id = @round)`)
      .all({ me: me2, season: handle.prepare(`SELECT season FROM career WHERE id = 1`).get().season,
             champ: handle.prepare(`SELECT championship_id c FROM entries WHERE id = ?`)
                      .get(mine.id).c,
             round: r.id }).map(x => x.id);
    if (mates.length > 1) {
      let sum = 0;
      for (const id of mates) {
        const c2 = economy.roundCost(handle, id, r.id);
        if (c2) sum += c2.total;
      }
      fleet = { cars: mates.length, total: sum };
    }
  }

  return Object.assign(cost, { entryId: mine.id, roundId: r.id,
                               capital: purse.capital, track: r.track,
                               paidBy: mineToPay ? 'you' : 'team',
                               fleet,
                               seatFee: mineToPay ? null
                                 : (handle.prepare(`SELECT seat_fee f FROM entry_drivers
                                     WHERE entry_id = ? AND driver_id = ?`)
                                     .get(mine.id, me2) || {}).f || 0,
                               payerName: mineToPay ? null
                                 : handle.prepare(`SELECT t.name n FROM entries e
                                     JOIN teams t ON t.id = e.team_id WHERE e.id = ?`)
                                     .get(mine.id).n });
}
function withdrawFromRound(roundId, entryId) {
  const r = economy.withdraw(handle, roundId, entryId);
  dirty = true;
  return r;
}
function whereToRace() { return handle ? office.eligible(handle) : null; }
function facilitiesDue() { return handle ? office.upgradeDue(handle) : null; }
function upgradeFacilities() {
  const r = office.upgradeTeam(handle);
  dirty = true;
  return r;
}
function pickChampionship(id) {
  const r = office.choose(handle, id);
  dirty = true;
  return r;
}

function sponsors(driverId) {
  if (!handle) return [];
  const id = driverId || handle.prepare(`SELECT player_driver_id p FROM career WHERE id = 1`).get().p;
  return economy.sponsorsOf(handle, id);
}

function raceSheet(roundId, legNo) {
  return handle ? season.resultSheet(handle, roundId, legNo) : null;
}
function raceSave(legId, entries) {
  if (!handle) throw new Error('No career open.');
  payForMyRound(legId);
  const r = season.saveResults(handle, legId, entries);
  const round = handle.prepare(`SELECT round_id FROM legs WHERE id = ?`).get(legId);
  economy.reviewSponsors(handle, round.round_id);
  dirty = true;
  return r;
}

// Running a meeting costs money whether the result is typed in or simulated.
function payForMyRound(legId) {
  const me = handle.prepare(`SELECT player_driver_id p FROM career WHERE id = 1`).get().p;
  const row = handle.prepare(`
    SELECT l.round_id, e.id entry_id FROM legs l
    JOIN rounds r ON r.id = l.round_id
    JOIN championships ch ON ch.id = r.championship_id
    JOIN entries e ON e.season = r.season
         AND e.championship_id = COALESCE(ch.shares_entries_with, ch.id)
    JOIN entry_drivers ed ON ed.entry_id = e.id
    WHERE l.id = ? AND ed.driver_id = ?`).get(legId, me);
  if (row) economy.chargePlayerRound(handle, row.round_id, row.entry_id);
}

// ------------------------------------------------------------- standings
function worldTree() {
  if (!handle) return null;
  const c = handle.prepare(`SELECT season FROM career WHERE id = 1`).get();
  return handle.prepare(`
    SELECT ch.id, ch.name, ch.class, ch.home_continent AS continent,
           -- an endurance series runs the sprint series' field, so count the
           -- cars in the field it actually uses, not the ones entered under
           -- its own name, of which there are none
           (SELECT COUNT(*) FROM entries e
            WHERE e.season = ?
              AND e.championship_id = COALESCE(ch.shares_entries_with, ch.id)) entries,
           (SELECT COUNT(*) FROM rounds r
            WHERE r.season = ? AND r.championship_id = ch.id AND r.played = 1) played,
           (SELECT COUNT(*) FROM rounds r
            WHERE r.season = ? AND r.championship_id = ch.id) rounds
    FROM championships ch
    WHERE ch.active_from <= ?
    ORDER BY ch.home_continent, ch.class, ch.name`).all(c.season, c.season, c.season, c.season);
}

// Which cup a driver is classified in. Real GT racing splits a field by the
// grade on each driver's licence, so a Bronze runs for something he can
// actually win instead of measuring himself against professionals. Platinum is
// thin on the ground here and belongs with Gold rather than in a cup of three;
// an unrated driver has not been graded yet, and a driver who has not been
// graded is an amateur.
const CUP_OF = { Platinum: 'Gold', Gold: 'Gold', Silver: 'Silver', Bronze: 'Bronze' };
const CUPS = ['Gold', 'Silver', 'Bronze'];
const cupFor = rating => CUP_OF[rating] || 'Bronze';

// Only the classes that carry graded licences run cups.
const cupClasses = new Set(['gt3', 'gt4', 'lmdh']);

function standings(championshipId, kind) {
  if (!handle) return null;
  const c = handle.prepare(`SELECT season, player_driver_id FROM career WHERE id = 1`).get();

  // the same driver table, split into the three licence cups
  if (kind === 'cups') {
    const champ = handle.prepare(`SELECT class FROM championships WHERE id = ?`)
      .get(championshipId);
    if (!champ || !cupClasses.has(champ.class)) return null;
    const rows = standings(championshipId, 'drivers') || [];
    const out = [];
    for (const cup of CUPS) {
      const inCup = rows.filter(x => cupFor(x.rating) === cup);
      if (!inCup.length) continue;
      out.push({ cup, drivers: inCup });
    }
    return out.length ? out : null;
  }

  if (kind === 'teams') {
    return handle.prepare(`
      SELECT t.name AS name, t.country,
             -- a team may run more than one model, so name every one of them
             (SELECT GROUP_CONCAT(x.n, ' · ') FROM
                (SELECT DISTINCT cm2.name n FROM entries e2
                 JOIN chassis c3 ON c3.id = e2.chassis_id
                 JOIN car_models cm2 ON cm2.id = c3.model_id
                 WHERE e2.team_id = t.id AND e2.season = @season
                   AND e2.championship_id = (SELECT COALESCE(shares_entries_with, id)
                                             FROM championships WHERE id = @champ)
                 ORDER BY cm2.name) x) car,
             SUM(res.points) pts,
             SUM(CASE WHEN res.finish_pos = 1 THEN 1 ELSE 0 END) wins,
             SUM(CASE WHEN res.finish_pos <= 3 AND res.finish_pos IS NOT NULL THEN 1 ELSE 0 END) podiums,
             MAX(CASE WHEN t.owner_driver_id = @me THEN 1 ELSE 0 END) mine
      FROM results res
      JOIN legs l ON l.id = res.leg_id
      JOIN rounds r ON r.id = l.round_id
      JOIN entries e ON e.id = res.entry_id
      JOIN teams t ON t.id = e.team_id
      WHERE r.season = @season AND r.championship_id = @champ
      GROUP BY t.id ORDER BY pts DESC, wins DESC`)
      .all({ season: c.season, champ: championshipId, me: c.player_driver_id });
  }

  if (kind === 'manufacturers') {
    return handle.prepare(`
      SELECT m.name AS name, NULL country, SUM(res.points) pts,
             SUM(CASE WHEN res.finish_pos = 1 THEN 1 ELSE 0 END) wins,
             SUM(CASE WHEN res.finish_pos <= 3 AND res.finish_pos IS NOT NULL THEN 1 ELSE 0 END) podiums,
             0 mine
      FROM results res
      JOIN legs l ON l.id = res.leg_id
      JOIN rounds r ON r.id = l.round_id
      JOIN entries e ON e.id = res.entry_id
      JOIN chassis ch ON ch.id = e.chassis_id
      JOIN car_models cm ON cm.id = ch.model_id
      JOIN manufacturers m ON m.id = cm.manufacturer_id
      WHERE r.season = @season AND r.championship_id = @champ
      GROUP BY m.id ORDER BY pts DESC, wins DESC`)
      .all({ season: c.season, champ: championshipId });
  }

  // A car's result belongs to everyone who drove it that weekend. In the
  // sprints that is one man and this changes nothing; in the endurance rounds
  // both of the crew take the car's points, as they do in reality. The crew is
  // read from who actually appeared in the round's results, not from the
  // entry's roster — the roster carries the endurance co-driver even for the
  // sprint rounds he never starts.
  return handle.prepare(`
    SELECT d.name AS name, d.country, t.name team, cm.name car,
           d.fia_rating rating,
           SUM(res.points) pts,
           SUM(CASE WHEN res.finish_pos = 1 THEN 1 ELSE 0 END) wins,
           SUM(CASE WHEN res.finish_pos <= 3 AND res.finish_pos IS NOT NULL THEN 1 ELSE 0 END) podiums,
           SUM(CASE WHEN res.status <> 'finished' THEN 1 ELSE 0 END) retirements,
           MAX(CASE WHEN d.is_player = 1 THEN 1 ELSE 0 END) mine
    FROM results res
    JOIN legs l ON l.id = res.leg_id
    JOIN rounds r ON r.id = l.round_id
    JOIN entries e ON e.id = res.entry_id
    JOIN teams t ON t.id = e.team_id
    JOIN chassis ch ON ch.id = e.chassis_id
    JOIN car_models cm ON cm.id = ch.model_id
    JOIN (SELECT DISTINCT r2.entry_id, lg.round_id, r2.driver_id
          FROM results r2 JOIN legs lg ON lg.id = r2.leg_id) crew
         ON crew.entry_id = res.entry_id AND crew.round_id = l.round_id
    JOIN drivers d ON d.id = crew.driver_id
    WHERE r.season = @season AND r.championship_id = @champ
    GROUP BY d.id ORDER BY pts DESC, wins DESC`)
    .all({ season: c.season, champ: championshipId });
}

function calendar(championshipId) {
  if (!handle) return [];
  const c = handle.prepare(`SELECT season FROM career WHERE id = 1`).get();
  const rounds = handle.prepare(`
    SELECT r.id, r.round_no, r.week, r.played, t.name track
    FROM rounds r JOIN tracks t ON t.id = r.track_id
    WHERE r.season = ? AND r.championship_id = ?
    ORDER BY r.round_no`).all(c.season, championshipId);

  const winners = handle.prepare(`
    SELECT l.round_id, l.leg_no, d.name
    FROM results res
    JOIN legs l ON l.id = res.leg_id
    JOIN drivers d ON d.id = res.driver_id
    WHERE res.finish_pos = 1 AND l.round_id IN (
      SELECT id FROM rounds WHERE season = ? AND championship_id = ?)
    ORDER BY l.round_id, l.leg_no`).all(c.season, championshipId);

  for (const r of rounds)
    r.winners = winners.filter(w => w.round_id === r.id)
                       .map(w => ({ leg: w.leg_no, name: w.name }));
  return rounds;
}

function simulateLeg(roundId, legNo) {
  if (!handle) throw new Error('No career open.');
  const leg = handle.prepare(`SELECT id FROM legs WHERE round_id = ? AND leg_no = ?`)
    .get(roundId, legNo);
  const out = simulate.simulateLeg(handle, roundId, legNo);
  if (!out.entries.length) return { saved: 0 };
  payForMyRound(leg.id);
  const res = season.saveResults(handle, leg.id, out.entries);
  economy.reviewSponsors(handle, roundId);
  dirty = true;
  return Object.assign(res, { starters: out.starters, retired: out.retired,
                              order: out.entries });
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

// Who may be put in the team's cars: everyone already signed, plus the player.
function lineup() {
  if (!handle) return null;
  const c = handle.prepare(`SELECT season, week, player_driver_id FROM career WHERE id = 1`).get();
  const team = handle.prepare(`SELECT * FROM teams WHERE owner_driver_id = ?
      AND status = 'active' AND is_privateer = 0`).get(c.player_driver_id);
  if (!team) return { team: null, open: c.week <= 4, cars: [], drivers: [] };

  const cars = handle.prepare(`
    SELECT e.id entry_id, cm.name car, l.livery_name livery, ch.name championship,
           (SELECT MAX(cl2.drivers_per_car) FROM championships c3
            JOIN championship_levels cl2 ON cl2.id = c3.level_id
            WHERE c3.id = e.championship_id
               OR c3.shares_entries_with = e.championship_id) seats
    FROM entries e
    JOIN chassis c2 ON c2.id = e.chassis_id
    JOIN car_models cm ON cm.id = c2.model_id
    JOIN liveries l ON l.id = e.livery_id
    JOIN championships ch ON ch.id = e.championship_id
    JOIN championship_levels cl ON cl.id = ch.level_id
    WHERE e.team_id = ? AND e.season = ?
    ORDER BY e.id`).all(team.id, c.season);

  const seatRows = handle.prepare(`
    SELECT ed.entry_id, ed.role, d.id driver_id, d.name, d.fia_rating
    FROM entry_drivers ed JOIN entries e ON e.id = ed.entry_id
    JOIN drivers d ON d.id = ed.driver_id
    WHERE e.team_id = ? AND e.season = ?`).all(team.id, c.season);
  for (const car of cars)
    car.drivers = seatRows.filter(r => r.entry_id === car.entry_id)
                          .sort((a, b) => a.role - b.role);

  // the pool is the team's own signed drivers plus the owner
  const pool = handle.prepare(`
    SELECT DISTINCT d.id, d.name, d.fia_rating, d.country
    FROM drivers d
    WHERE d.id = ?
       OR d.id IN (SELECT ed.driver_id FROM entry_drivers ed
                   JOIN entries e ON e.id = ed.entry_id
                   WHERE e.team_id = ? AND e.season = ?)`)
    .all(c.player_driver_id, team.id, c.season);
  for (const d of pool) {
    d.isPlayer = d.id === c.player_driver_id;
    const at = seatRows.find(r => r.driver_id === d.id);
    d.inCar = at ? at.entry_id : null;
  }

  return { team: { id: team.id, name: team.name }, open: c.week <= 4, cars, drivers: pool };
}

// Put a driver in a car, or empty the seat. Line-ups are locked after week 4.
function setCarDriver(entryId, role, driverId) {
  if (!handle) throw new Error('No career open.');
  const c = handle.prepare(`SELECT season, week, player_driver_id FROM career WHERE id = 1`).get();
  if (c.week > 4) throw new Error('Line-ups are locked once the season starts.');
  const team = handle.prepare(`SELECT * FROM teams WHERE owner_driver_id = ?
      AND status = 'active' AND is_privateer = 0`).get(c.player_driver_id);
  if (!team) throw new Error('You do not run a team.');
  const entry = handle.prepare(`SELECT * FROM entries WHERE id = ? AND team_id = ? AND season = ?`)
    .get(entryId, team.id, c.season);
  if (!entry) throw new Error('That car is not yours.');

  return handle.transaction(() => {
    handle.prepare(`DELETE FROM entry_drivers WHERE entry_id = ? AND role = ?`).run(entryId, role);
    if (driverId) {
      // a driver can only sit in one car, so free whatever they were in
      handle.prepare(`DELETE FROM entry_drivers WHERE driver_id = ?
          AND entry_id IN (SELECT id FROM entries WHERE team_id = ? AND season = ?)`)
        .run(driverId, team.id, c.season);
      handle.prepare(`INSERT INTO entry_drivers (entry_id,driver_id,role,seat_fee)
          VALUES (?,?,?,0)`).run(entryId, driverId, role);
    }
    dirty = true;
    return lineup();
  })();
}

function garage() {
  if (!handle) return null;
  const me = handle.prepare(`SELECT player_driver_id p FROM career WHERE id = 1`).get().p;
  // Everything the player owns, whether or not it is entered anywhere this
  // season, plus any car they are driving for somebody else. Between seasons a
  // car sits here with no championship against it, waiting to be entered.
  return handle.prepare(`
    SELECT ch.id AS id, cm.name model, cm.class, ch.value, ch.engine_hours, ch.chassis_hours,
           t.name team,
           CASE WHEN t.owner_driver_id = @me THEN 1 ELSE 0 END mine,
           ch.for_sale,
           e.id entry_id,
           COALESCE(l.livery_name, lastl.livery_name, cm.name) livery,
           c.name championship,
           (SELECT d2.name FROM entry_drivers ed2 JOIN drivers d2 ON d2.id = ed2.driver_id
            WHERE ed2.entry_id = e.id ORDER BY ed2.role LIMIT 1) driver
    FROM chassis ch
    JOIN car_models cm ON cm.id = ch.model_id
    JOIN teams t ON t.id = ch.owner_team_id
    LEFT JOIN entries e ON e.chassis_id = ch.id
         AND e.season = (SELECT season FROM career WHERE id = 1)
    LEFT JOIN liveries l ON l.id = e.livery_id
    LEFT JOIN championships c ON c.id = e.championship_id
    LEFT JOIN liveries lastl ON lastl.id = (
      SELECT e2.livery_id FROM entries e2 WHERE e2.chassis_id = ch.id
      ORDER BY e2.season DESC LIMIT 1)
    WHERE t.status = 'active' AND t.owner_driver_id = @me
    UNION
    SELECT ch.id AS id, cm.name model, cm.class, ch.value, ch.engine_hours, ch.chassis_hours,
           t.name team, 0 mine, ch.for_sale, e.id entry_id,
           l.livery_name livery, c.name championship,
           (SELECT d2.name FROM entry_drivers ed2 JOIN drivers d2 ON d2.id = ed2.driver_id
            WHERE ed2.entry_id = e.id ORDER BY ed2.role LIMIT 1) driver
    FROM entries e
    JOIN chassis ch ON ch.id = e.chassis_id
    JOIN car_models cm ON cm.id = ch.model_id
    JOIN liveries l ON l.id = e.livery_id
    JOIN teams t ON t.id = e.team_id
    JOIN championships c ON c.id = e.championship_id
    WHERE e.season = (SELECT season FROM career WHERE id = 1)
      AND t.owner_driver_id IS NOT @me
      AND e.id IN (SELECT entry_id FROM entry_drivers WHERE driver_id = @me)
    ORDER BY mine DESC, id`).all({ me });
}

module.exports = { create, open, peek, state, advanceWeek, save, close, isDirty,
                   marketList, marketBuy, marketBuyMany,
                   usedList, buyUsed, sellQuote, sellCar, rebuildQuote, rebuildEngine,
                   ownedCars, enterOwned, garage, myEntries, lineup, setCarDriver, newsList, newsRead, home, setTutorial, raceInfo, racePrepare, raceSheet, raceSave,
                   worldTree, standings, calendar,
                   roundBill, myRoundCost, withdrawFromRound, sponsors, simulateLeg,
                   whereToRace, pickChampionship, facilitiesDue, upgradeFacilities,
                   officeOffers, officeTakeSeat, officeFormTeam, officeSign,
                   handle: () => handle };
