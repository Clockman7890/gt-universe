'use strict';
const { rng, pick, NameFactory, TeamFactory } = require('./names');
const { between, irange, round3 } = require('./population');

// A number still going spare in this championship, leaving alone any the
// player's own car carried last year.
function freeLivery(db, modelId, season, champId) {
  return db.prepare(`
    SELECT l.* FROM liveries l
    WHERE l.model_id = @model
      AND l.id NOT IN (SELECT livery_id FROM entries
                       WHERE season = @season AND championship_id = @champ)
      AND l.id NOT IN (
        SELECT e2.livery_id FROM entries e2 JOIN teams t2 ON t2.id = e2.team_id
        WHERE e2.season = @last AND e2.championship_id = @champ
          AND t2.owner_driver_id = (SELECT player_driver_id FROM career WHERE id = 1))
    ORDER BY l.id LIMIT 1`)
    .get({ model: modelId, season, champ: champId, last: season - 1 });
}

const shuffled = (r, arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// ---------------------------------------------------------------- week 4 lock
// Any place still open when the entry list closes is taken by somebody else.
// A championship never starts a season short of cars.
function lockEntries(db, world, leaveOpen = 0) {
  const c = db.prepare(`SELECT season FROM career WHERE id = 1`).get();
  const filled = [];

  for (const w of world.championships) {
    if (w.active_from > c.season || w.shares_entries_with) continue;
    const champ = db.prepare(`SELECT * FROM championships WHERE id = ?`).get(w.id);
    if (!champ) continue;

    // A championship grows into itself. In its debut year nobody is
    // press-ganged onto the grid: it is brought up to the number it needs to
    // run at all and no further, and everything above that has to be earned by
    // teams deciding for themselves to move up. The second year it musters the
    // field grid_first describes, and from the third it settles at grid. Force
    // the full number from day one and a brand new class arrives looking like
    // it has always been there.
    const age = c.season - (w.active_from || 1);
    const opening = (w.grid_first || w.grid) || w.grid;
    const full = age <= 0 ? Math.min(opening, champ.min_grid)
               : age === 1 ? opening
               : w.grid || opening;
    // leaveOpen holds places back so the player still has somewhere to enter
    // during their four weeks; at the lock itself nothing is held back.
    const target = Math.max(1, full - leaveOpen);
    let have = db.prepare(`SELECT COUNT(*) n FROM entries WHERE season = ? AND championship_id = ?`)
      .get(c.season, w.id).n;
    if (have >= target) continue;

    const r = rng((w.id.length * 7919 + c.season * 104729) >>> 0);
    const tf = new TeamFactory((w.id.length * 31 + c.season) >>> 0);

    const models = champ.model_id
      ? db.prepare(`SELECT * FROM car_models WHERE id = ?`).all(champ.model_id)
      : db.prepare(`SELECT * FROM car_models WHERE purchasable = 1 AND class IN (${
          champ.class === 'gt4' ? "'gt4'" : "'gt3_gen1','gt3_gen2','gto'"})`).all();

    // The endurance rounds borrow the sprint field, and they need two drivers
    // per car. Crewing that field for the sprint alone leaves every endurance
    // entry a driver short, so the field is staffed for whichever championship
    // asks for most.
    const perCar = db.prepare(`
      SELECT MAX(cl.drivers_per_car) n
      FROM championships c2
      JOIN championship_levels cl ON cl.id = c2.level_id
      WHERE c2.id = @id OR c2.shares_entries_with = @id`).get({ id: w.id }).n;

    while (have < target) {
      // Try every model before giving up: one being out of numbers says nothing
      // about the rest, and stopping at the first exhausted one leaves a grid
      // half empty while dozens of liveries sit unused.
      const order = models.length === 1 ? models : shuffled(r, models);
      let model = null, lv = null;
      for (const cand of order) {
        const found = freeLivery(db, cand.id, c.season, w.id);
        if (found) { model = cand; lv = found; break; }
      }
      if (!lv) break;                            // the whole class is out of numbers

      const free = db.prepare(`
        SELECT d.* FROM drivers d
        JOIN blocks b ON b.id = d.block_id
        WHERE d.is_player = 0 AND d.status = 'active'
          AND d.id NOT IN (SELECT driver_id FROM entry_drivers ed
                           JOIN entries e ON e.id = ed.entry_id WHERE e.season = ?)
          AND d.block_id IN (SELECT block_id FROM championship_blocks WHERE championship_id = ?)
        ORDER BY (SELECT race_skill FROM driver_skills WHERE driver_id = d.id) DESC
        LIMIT ?`).all(c.season, w.id, perCar);
      if (free.length < perCar) break;            // nobody left to put in it

      const lead = free[0];
      const priv = champ.class === 'gt5' && r() < 0.7;
      const teamId = db.prepare(`INSERT INTO teams
          (name,country,block_id,founded_season,is_privateer,owner_driver_id,capital,
           engineering,facilities,goals)
          VALUES (?,?,?,?,?,?,?,?,?, 'normal')`)
        .run(priv ? `${lead.name.split(' ').pop()} (privateer)` : tf.make(lead.name),
             lead.country, lead.block_id, c.season, priv ? 1 : 0, priv ? lead.id : null,
             Math.round(between(r, 90000, 600000) / 1000) * 1000,
             priv ? 'amateurs' : (r() < 0.7 ? 'amateurs' : 'experienced'),
             champ.class === 'gt5' ? 'gt5' : 'gt4').lastInsertRowid;

      const chassisId = db.prepare(`INSERT INTO chassis
          (model_id,owner_team_id,bought_season,bought_new,value) VALUES (?,?,?,1,?)`)
        .run(model.id, teamId, c.season, Math.round((model.price_new || 0) * 0.8)).lastInsertRowid;

      const entryId = db.prepare(`INSERT INTO entries
          (season,championship_id,team_id,chassis_id,livery_id,class_cup,works_support)
          VALUES (?,?,?,?,?,NULL,0)`)
        .run(c.season, w.id, teamId, chassisId, lv.id).lastInsertRowid;

      free.forEach((d, i) => db.prepare(
        `INSERT INTO entry_drivers (entry_id,driver_id,role,seat_fee) VALUES (?,?,?,0)`)
        .run(entryId, d.id, i + 1));

      have++;
    }
    filled.push({ championship: champ.name, to: have, target });
  }

  // the calendar was built from the entry counts, so refresh the grid sizes
  db.prepare(`
    UPDATE rounds SET grid_size = (
      SELECT COUNT(*) FROM entries e
      WHERE e.season = rounds.season AND e.championship_id = rounds.championship_id)
    WHERE season = ?`).run(c.season);

  return filled;
}

// ---------------------------------------------------------------- results
const PRIZE = { gt5: 5000, gt4: 15000, gt3: 60000, lmdh: 400000 };
const DAMAGE = { gt5: 8000, gt4: 25000, gt3_gen1: 50000, gt3_gen2: 90000, gto: 40000, lmdh: 150000 };
const SPEED = { gt5: 128, gt4: 150, gt3: 170, lmdh: 190 };

// The grid as it should be entered, in the order the player will see in game.
function resultSheet(db, roundId, legNo) {
  const c = db.prepare(`SELECT season, player_driver_id FROM career WHERE id = 1`).get();
  const round = db.prepare(`
    SELECT r.*, ch.name championship, ch.class, ch.level_id, t.name track,
           COALESCE(ch.shares_entries_with, ch.id) field_champ
    FROM rounds r JOIN championships ch ON ch.id = r.championship_id
    JOIN tracks t ON t.id = r.track_id WHERE r.id = ?`).get(roundId);
  if (!round) return null;
  const leg = db.prepare(`SELECT * FROM legs WHERE round_id = ? AND leg_no = ?`).get(roundId, legNo);
  const perCar = db.prepare(`SELECT drivers_per_car n FROM championship_levels WHERE id = ?`)
    .get(round.level_id).n;
  const role = perCar > 1 && legNo === 2 ? 2 : 1;

  const rows = db.prepare(`
    SELECT e.id entry_id, l.livery_name livery, cm.name car, t.name team, t.is_privateer,
           d.id driver_id, d.name driver, d.is_player
    FROM entries e
    JOIN chassis ch ON ch.id = e.chassis_id
    JOIN car_models cm ON cm.id = ch.model_id
    JOIN liveries l ON l.id = e.livery_id
    JOIN teams t ON t.id = e.team_id
    LEFT JOIN entry_drivers ed ON ed.entry_id = e.id AND ed.role = ?
    LEFT JOIN drivers d ON d.id = ed.driver_id
    WHERE e.season = ? AND e.championship_id = ?
    ORDER BY l.livery_name`).all(role, c.season, round.field_champ);

  const already = db.prepare(`SELECT COUNT(*) n FROM results WHERE leg_id = ?`).get(leg.id).n;
  return {
    roundId, legId: leg.id, leg: legNo, laps: leg.laps,
    championship: round.championship, track: round.track, round: round.round_no,
    recorded: already > 0, grid: rows
  };
}

// Save one leg: points, prize money, wear and repair bills.
function saveResults(db, legId, entries) {
  const c = db.prepare(`SELECT season, week, player_driver_id FROM career WHERE id = 1`).get();
  const leg = db.prepare(`SELECT * FROM legs WHERE id = ?`).get(legId);
  const round = db.prepare(`
    SELECT r.*, ch.class, ch.prestige, ch.level_id FROM rounds r
    JOIN championships ch ON ch.id = r.championship_id WHERE r.id = ?`).get(leg.round_id);
  const tier = round.class === 'gt5' ? 'gt5' : round.class === 'gt4' ? 'gt4'
             : round.class === 'lmdh' ? 'lmdh' : 'gt3';
  const points = Object.fromEntries(
    db.prepare(`SELECT position, points FROM points_scheme WHERE level_id = ?`)
      .all(round.level_id).map(r => [r.position, r.points]));

  // An endurance round is one race driven in two stints, not two races. The
  // car finishes in one position, and in real endurance racing every driver in
  // that crew is credited with it. Scoring each stint on its own split a
  // crew's result in half and left the endurance table full of names that
  // never appeared in the sprints — the co-drivers, scoring alone, while the
  // lead drivers were credited with a stint instead of a result.
  const lvl = db.prepare(`SELECT two_leg, drivers_per_car FROM championship_levels
                          WHERE id = ?`).get(round.level_id) || {};
  const legCount = db.prepare(`SELECT COUNT(*) n FROM legs WHERE round_id = ?`)
    .get(leg.round_id).n;
  // One result row per car per leg, as the table's own unique key insists. The
  // crew is credited where the tables are read, not by duplicating the car:
  // every driver on the entry takes the car's points, which is how an
  // endurance result actually works.
  const staged = !!lvl.two_leg && legCount > 1;
  const scores = !staged || leg.leg_no === legCount;

  return db.transaction(() => {
    db.prepare(`DELETE FROM results WHERE leg_id = ?`).run(legId);

    const hours = leg.distance_km / SPEED[tier] +      // the race itself
                  (leg.practice_min + leg.quali_min) / 60;

    for (const e of entries) {
      const pts = scores && e.status === 'finished' ? (points[e.finish] || 0) : 0;
      db.prepare(`INSERT INTO results
          (leg_id,entry_id,driver_id,grid_pos,finish_pos,status,points,damage_cost)
          VALUES (?,?,?,?,?,?,?,?)`)
        .run(legId, e.entryId, e.driverId, e.grid || null,
             e.status === 'finished' ? e.finish : null, e.status, pts, 0);


      // engine and chassis wear for everyone who took part
      db.prepare(`UPDATE chassis SET engine_hours = engine_hours + ?,
                  chassis_hours = chassis_hours + ?
                  WHERE id = (SELECT chassis_id FROM entries WHERE id = ?)`)
        .run(hours, hours, e.entryId);

      // money: prizes to the front, repair bills to whoever hit something
      const owner = db.prepare(`
        SELECT t.owner_driver_id, t.is_privateer FROM entries en
        JOIN teams t ON t.id = en.team_id WHERE en.id = ?`).get(e.entryId);
      const payTo = owner && owner.owner_driver_id ? owner.owner_driver_id : null;

      if (pts) {
        const prize = Math.round(PRIZE[tier] * round.prestige * (points[e.finish] / 50) / 100) * 100;
        if (payTo && prize) {
          db.prepare(`UPDATE drivers SET capital = capital + ? WHERE id = ?`).run(prize, payTo);
          db.prepare(`INSERT INTO ledger (season,week,entity_type,entity_id,amount,reason)
              VALUES (?,?,'driver',?,?, 'prize')`).run(c.season, c.week, payTo, prize);
        }
      }
      // A car that does not see the flag gets rebuilt, whatever stopped it.
      // Nobody is asked to judge whether it was contact or a broken engine.
      if (e.status === 'retired') {
        const model = db.prepare(`SELECT cm.class FROM entries en
            JOIN chassis ch ON ch.id = en.chassis_id
            JOIN car_models cm ON cm.id = ch.model_id WHERE en.id = ?`).get(e.entryId);
        const bill = Math.round((DAMAGE[model.class] || 20000) * 0.7 / 100) * 100;
        db.prepare(`UPDATE results SET damage_cost = ? WHERE leg_id = ? AND entry_id = ?`)
          .run(bill, legId, e.entryId);
        if (payTo) {
          db.prepare(`UPDATE drivers SET capital = capital - ? WHERE id = ?`).run(bill, payTo);
          db.prepare(`INSERT INTO ledger (season,week,entity_type,entity_id,amount,reason)
              VALUES (?,?,'driver',?,?, 'repair')`).run(c.season, c.week, payTo, -bill);
        }
      }
    }

    db.prepare(`UPDATE legs SET simulated = 1 WHERE id = ?`).run(legId);
    const legsLeft = db.prepare(`SELECT COUNT(*) n FROM legs WHERE round_id = ? AND simulated = 0`)
      .get(leg.round_id).n;
    if (!legsLeft) db.prepare(`UPDATE rounds SET played = 1 WHERE id = ?`).run(leg.round_id);

    // a line in the news for the player's own result
    const mine = entries.find(e => e.driverId === c.player_driver_id);
    if (mine) {
      const where = mine.status === 'finished' ? `finished ${ordinal(mine.finish)}`
                  : mine.status === 'dns' ? 'did not start'
                  : 'retired';
      db.prepare(`INSERT INTO news (season,week,category,headline,body) VALUES (?,?,'result',?,?)`)
        .run(c.season, c.week,
             `You ${where} at ${db.prepare('SELECT name FROM tracks WHERE id = ?').get(round.track_id).name}`,
             mine.status === 'retired'
               ? `Race ${leg.leg_no}. The rebuild is charged to you.`
               : `Race ${leg.leg_no}.`);
    }
    return { saved: entries.length, roundClosed: !legsLeft };
  })();
}

const ordinal = n => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

// ------------------------------------------------------- balance of performance
// Every model needs a row for the new season or nothing can be entered: the
// grid is built by joining car_performance on the season being raced.
//
// Last year's manufacturer standings decide the direction. A manufacturer that
// won gets pegged back a little, one that finished last gets a little help, and
// the middle of the table is left alone. The steps are small and the distance
// from the measured baseline is capped, so a decade of this drifts the order of
// a class without ever running away from the numbers we measured on track.
const STEP        = 0.030;   // most a scalar moves in one season
const CAP         = 0.090;   // most it may ever sit from its baseline
const GTO_STEP    = 0.015;   // the old cars only ever get help
const GTO_CAP     = 0.045;
const FLOOR       = 0.900;
const CEILING     = 1.100;

const clamp = v => Math.min(CEILING, Math.max(FLOOR, Math.round(v * 1000) / 1000));

function rollBoP(db, toSeason) {
  const from = toSeason - 1;
  const models = db.prepare(`SELECT * FROM car_models`).all();
  const already = db.prepare(`SELECT COUNT(*) n FROM car_performance WHERE season = ?`)
    .get(toSeason).n;
  if (already) return { skipped: true };

  // Only a class whose championships are open to several makes has anything to
  // balance. A one-make series is already equal by construction, and ranking
  // its car against the car of a series on another continent would peg back a
  // model for points it never raced against.
  const contested = new Set(db.prepare(`
    SELECT DISTINCT cm.class
    FROM championships ch
    JOIN car_models cm ON cm.class = ch.class
    WHERE ch.model_id IS NULL`).all().map(r => r.class));

  // points each manufacturer scored last season, in the classes that are contested
  const scored = db.prepare(`
    SELECT cm.class, cm.manufacturer_id, SUM(res.points) pts
    FROM results res
    JOIN legs l ON l.id = res.leg_id
    JOIN rounds r ON r.id = l.round_id
    JOIN entries e ON e.id = res.entry_id
    JOIN chassis ch ON ch.id = e.chassis_id
    JOIN car_models cm ON cm.id = ch.model_id
    WHERE r.season = ?
    GROUP BY cm.class, cm.manufacturer_id`).all(from);

  const table = {};
  for (const row of scored) {
    if (!contested.has(row.class)) continue;
    (table[row.class] ||= []).push({ man: row.manufacturer_id, pts: row.pts || 0 });
  }
  for (const cls of Object.keys(table)) table[cls].sort((a, b) => b.pts - a.pts);

  const ins = db.prepare(`INSERT INTO car_performance
    (model_id,season,weight_scalar,power_scalar,drag_scalar,bop_drift,dev_bonus,clamped)
    VALUES (?,?,?,?,?,?,?,?)`);
  const moved = [];

  const tx = db.transaction(() => {
    for (const m of models) {
      const prev = db.prepare(`SELECT * FROM car_performance WHERE model_id = ? AND season = ?`)
        .get(m.id, from);
      const base = { w: m.base_weight_scalar, p: m.base_power_scalar, d: m.base_drag_scalar };
      const now = prev ? { w: prev.weight_scalar, p: prev.power_scalar, d: prev.drag_scalar }
                       : { ...base };
      let drift = prev ? prev.bop_drift : 0;
      const dev = prev ? prev.dev_bonus : 0;

      const isGto = m.class === 'gto';
      const step = isGto ? GTO_STEP : STEP;
      const cap = isGto ? GTO_CAP : CAP;

      // where this manufacturer finished in its own class last season. Only the
      // ends of the table move: the winners are pegged, the tail is helped, and
      // most of the field is left where the measurements put it.
      const order = table[m.class] || [];
      const at = order.findIndex(x => x.man === m.manufacturer_id);
      const ends = order.length >= 6 ? 2 : 1;
      let dir = 0;
      if (order.length >= 4 && at >= 0) {
        if (at < ends) dir = -1;
        else if (at >= order.length - ends) dir = +1;
      }
      // the old cars in the GT3 field are never pegged back, only helped
      if (isGto && contested.has(m.class)) dir = at >= 0 ? Math.max(0, dir) : 0;
      else if (isGto) dir = 0;

      if (dir) {
        const wanted = drift + dir * step;
        const allowed = Math.min(cap, Math.max(isGto ? 0 : -cap, wanted));
        const actually = allowed - drift;
        if (actually) {
          drift = Math.round(allowed * 1000) / 1000;
          // help means more power and less weight; a peg-back is the reverse
          now.p = clamp(now.p + actually);
          now.w = clamp(now.w - actually * 0.6);
          now.d = clamp(now.d - actually * 0.3);
          moved.push({ model: m.name, dir, drift });
        }
      }

      const hitLimit = [now.w, now.p, now.d].some(v => v <= FLOOR || v >= CEILING) ? 1 : 0;
      ins.run(m.id, toSeason, now.w, now.p, now.d, drift, dev, hitLimit);
    }
  });
  tx();
  return { season: toSeason, models: models.length, moved };
}

module.exports = { lockEntries, resultSheet, saveResults, rollBoP };
