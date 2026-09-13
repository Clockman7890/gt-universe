'use strict';
const { rng, pick, NameFactory, TeamFactory } = require('./names');
const { between, irange, round3 } = require('./population');

// ---------------------------------------------------------------- week 4 lock
// Any place still open when the entry list closes is taken by somebody else.
// A championship never starts a season short of cars.
function lockEntries(db, world) {
  const c = db.prepare(`SELECT season FROM career WHERE id = 1`).get();
  const filled = [];

  for (const w of world.championships) {
    if (w.active_from > c.season || w.shares_entries_with) continue;
    const champ = db.prepare(`SELECT * FROM championships WHERE id = ?`).get(w.id);
    if (!champ) continue;

    const target = w.grid_first || w.grid;
    let have = db.prepare(`SELECT COUNT(*) n FROM entries WHERE season = ? AND championship_id = ?`)
      .get(c.season, w.id).n;
    if (have >= target) continue;

    const r = rng((w.id.length * 7919 + c.season * 104729) >>> 0);
    const tf = new TeamFactory((w.id.length * 31 + c.season) >>> 0);

    const models = champ.model_id
      ? db.prepare(`SELECT * FROM car_models WHERE id = ?`).all(champ.model_id)
      : db.prepare(`SELECT * FROM car_models WHERE purchasable = 1 AND class IN (${
          champ.class === 'gt4' ? "'gt4'" : "'gt3_gen1','gt3_gen2','gto'"})`).all();

    const perCar = db.prepare(`SELECT drivers_per_car n FROM championship_levels WHERE id = ?`)
      .get(champ.level_id).n;

    while (have < target) {
      const model = models.length === 1 ? models[0] : pick(r, models);
      const lv = db.prepare(`
        SELECT l.* FROM liveries l
        WHERE l.model_id = ?
          AND l.id NOT IN (SELECT livery_id FROM entries WHERE season = ? AND championship_id = ?)
        ORDER BY l.id LIMIT 1`).get(model.id, c.season, w.id);
      if (!lv) break;                            // no numbers left, the grid is what it is

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
    SELECT r.*, ch.name championship, ch.class, ch.level_id, t.name track
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
    ORDER BY l.livery_name`).all(role, c.season, round.championship_id);

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

  return db.transaction(() => {
    db.prepare(`DELETE FROM results WHERE leg_id = ?`).run(legId);

    const hours = leg.distance_km / SPEED[tier] +      // the race itself
                  (leg.practice_min + leg.quali_min) / 60;

    for (const e of entries) {
      const pts = e.status === 'finished' ? (points[e.finish] || 0) : 0;
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

module.exports = { lockEntries, resultSheet, saveResults };
