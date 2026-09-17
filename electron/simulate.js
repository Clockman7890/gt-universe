'use strict';
const { rng } = require('./names');
const { engineHealth } = require('./market');

// A race is decided by the same three things the game is given: how quick the
// driver is, how quick the car is, and how much either of them varies. Nothing
// here is invented that the AI file does not already carry.
//
//   pace      race_skill sets the baseline lap
//   car       the power, weight and drag scalars, converted back to seconds
//   scatter   consistency decides how wide the driver's laps spread
//   trouble   vehicle_reliability for mechanical failures,
//             avoidance_of_mistakes and the aggression around him for contact

// A second of lap time is worth this much scalar, from the Barcelona work.
const SEC_PER_POWER  = 0.13;   // 1% power
const SEC_PER_WEIGHT = 0.10;   // 1% weight
const SEC_PER_DRAG   = 0.05;   // 1% drag

// How much of the raw difference between models survives the balancing. The
// scalars are not a measure of how quick a car is — they are the correction
// that was applied to make it lap with the others, so a car carrying a heavy
// correction is a car that was fast before it was pegged back, not a slow one.
// Read them as pace and the simulation punishes exactly the cars the balancing
// equalised. What is left after a good job is a residue: enough that one model
// suits a circuit better than another, nowhere near enough to decide a race.
const BOP_RESIDUE = 0.15;

// How much slower the back of a field is than the front, per class. A GT5
// grid spreads far more than a works LMDh one.
const SPREAD = { gt5: 3.4, gt4: 2.6, gt3: 1.9, lmdh: 1.2 };

const tierOf = cls => cls === 'gt5' ? 'gt5' : cls === 'gt4' ? 'gt4'
                    : cls === 'lmdh' ? 'lmdh' : 'gt3';

// Everyone who will actually take the start.
function fieldFor(db, roundId, legNo) {
  const c = db.prepare(`SELECT season FROM career WHERE id = 1`).get();
  const round = db.prepare(`
    SELECT r.*, ch.class, ch.level_id, ch.shares_entries_with, t.length_km
    FROM rounds r JOIN championships ch ON ch.id = r.championship_id
    JOIN tracks t ON t.id = r.track_id WHERE r.id = ?`).get(roundId);
  // An endurance round is contested by the sprint series' cars: the entry list
  // is one list, shared. Without this the field comes back empty and the round
  // is never run at all.
  const fieldChamp = round.shares_entries_with || round.championship_id;
  const perCar = db.prepare(`SELECT drivers_per_car n FROM championship_levels WHERE id = ?`)
    .get(round.level_id).n;
  const role = perCar > 1 && legNo === 2 ? 2 : 1;

  return db.prepare(`
    SELECT e.id entry_id, d.id driver_id, d.name, d.is_player,
           s.race_skill, s.qualifying_skill, s.consistency, s.aggression,
           s.avoidance_of_mistakes, s.avoidance_of_forced_mistakes, s.start_reactions,
           s.tyre_management, s.stamina,
           cp.weight_scalar, cp.power_scalar, cp.drag_scalar, ch2.dev_bonus,
           ch2.engine_hours, t.engineering,
           (SELECT COUNT(*) FROM entries e2 WHERE e2.team_id = t.id AND e2.season = e.season) fleet
    FROM entries e
    JOIN chassis ch2 ON ch2.id = e.chassis_id
    JOIN car_models cm ON cm.id = ch2.model_id
    JOIN car_performance cp ON cp.model_id = cm.id AND cp.season = e.season
    JOIN teams t ON t.id = e.team_id
    JOIN entry_drivers ed ON ed.entry_id = e.id AND ed.role = ?
    JOIN drivers d ON d.id = ed.driver_id
    JOIN driver_skills s ON s.driver_id = d.id
    WHERE e.season = ? AND e.championship_id = ?
      AND e.id NOT IN (SELECT entry_id FROM round_absences WHERE round_id = ?)`)
    .all(role, c.season, fieldChamp, roundId);
}

// The seconds a model's balancing correction is worth. On its own this number
// says nothing about pace; it only means something next to the rest of the
// field, which is why it is centred before it is used.
function bopEffect(car) {
  return (1 - car.power_scalar)  * 100 * SEC_PER_POWER
       + (car.weight_scalar - 1) * 100 * SEC_PER_WEIGHT
       + (car.drag_scalar - 1)   * 100 * SEC_PER_DRAG;
}

// Seconds off the quickest possible lap, before any luck is applied. fieldBop
// is the average correction across the cars actually entered: subtracting it
// leaves no model systematically ahead, and in a one-make series cancels to
// nothing, as it should.
function paceOf(car, cls, fieldBop = 0) {
  const driverLoss = (1 - car.race_skill) * SPREAD[tierOf(cls)];
  const carLoss = (bopEffect(car) - fieldBop) * BOP_RESIDUE
                - (car.dev_bonus || 0);
  return driverLoss + carLoss;
}

const REL = { amateurs: 0.68, experienced: 0.78, specialist: 0.86 };
const FLEET_PENALTY = { 1: 1.00, 2: 0.96, 3: 0.91, 4: 0.85 };

function simulateLeg(db, roundId, legNo, seed) {
  const round = db.prepare(`
    SELECT r.*, ch.class, ch.level_id FROM rounds r
    JOIN championships ch ON ch.id = r.championship_id WHERE r.id = ?`).get(roundId);
  const leg = db.prepare(`SELECT * FROM legs WHERE round_id = ? AND leg_no = ?`)
    .get(roundId, legNo);
  const lvl = db.prepare(`SELECT * FROM championship_levels WHERE id = ?`).get(round.level_id);
  const field = fieldFor(db, roundId, legNo);
  if (!field.length) return { entries: [] };

  const r = rng(seed !== undefined ? seed : ((roundId * 7919 + legNo * 104729) >>> 0));
  const laps = leg.laps;
  const tier = tierOf(round.class);

  // the second leg of a two-leg round starts in the order the first finished
  let grid = null;
  if (leg.skip_quali) {
    const prev = db.prepare(`
      SELECT res.entry_id FROM results res JOIN legs l ON l.id = res.leg_id
      WHERE l.round_id = ? AND l.leg_no = 1 AND res.finish_pos IS NOT NULL
      ORDER BY res.finish_pos`).all(roundId);
    if (prev.length) grid = prev.map(p => p.entry_id);
  }

  const fieldBop = field.reduce((m, c) => m + bopEffect(c), 0) / field.length;

  const runners = field.map(c => {
    const base = paceOf(c, round.class, fieldBop);
    // qualifying is one lap, so scatter bites harder than over a race
    const qLoss = base - (c.qualifying_skill - c.race_skill) * SPREAD[tier] * 0.5
                + (1 - c.consistency) * 0.9 * (r() - 0.35);
    return { ...c, base, qLoss };
  });

  // starting order
  if (grid) {
    const pos = new Map(grid.map((id, i) => [id, i]));
    runners.sort((a, b) => (pos.has(a.entry_id) ? pos.get(a.entry_id) : 99) -
                           (pos.has(b.entry_id) ? pos.get(b.entry_id) : 99));
  } else {
    runners.sort((a, b) => a.qLoss - b.qLoss);
  }
  runners.forEach((c, i) => { c.grid = i + 1; });

  // The race itself. Lap-by-lap scatter alone is not enough to decide anything:
  // over a full race it averages out and the quickest car wins every time. What
  // actually shuffles a result is the things that do not average out — the day a
  // driver is having, a moment lost at a corner, and the traffic ahead.
  const meanAggression = runners.reduce((m, c) => m + c.aggression, 0) / runners.length;
  const passing = { gt5: 0.10, gt4: 0.14, gt3: 0.18, lmdh: 0.22 }[tier];

  for (const c of runners) {
    // how this one is going today, held for the whole race
    const form = (r() - 0.5) * 2 * (1 - c.consistency) * 1.00;

    let total = 0;
    for (let lap = 0; lap < laps; lap++) {
      const scatter = (1 - c.consistency) * 1.1;
      const tyre = (lap / laps) * (1 - c.tyre_management) * 1.6;
      const fade = (lap / laps) * (1 - c.stamina) * 0.7;
      total += c.base + form + tyre + fade + (r() - 0.5) * 2 * scatter;
    }

    // moments: a spin, a lock-up, a lap ruined behind a backmarker
    const expected = (1 - c.avoidance_of_mistakes) * 1.8 * (laps / 14);
    let moments = 0;
    for (let k = 0; k < 6; k++) if (r() < expected / 6) moments++;
    for (let k = 0; k < moments; k++) total += 3 + r() * 16;
    c.moments = moments;

    // a poor start costs, a good one gains
    total += (0.5 - c.start_reactions) * 1.4;
    // track position is worth something: cars ahead have to be got past
    total += (c.grid - 1) * passing * (1 + (1 - c.aggression));
    // pit stops cost the same to everyone, so they only matter through mistakes
    if (lvl.mandatory_stops)
      total += lvl.mandatory_stops * (1 - c.avoidance_of_mistakes) * 2.2;
    c.time = total;

    // mechanical trouble, scaled by how long the race is. An engine past two
    // thirds of its life is a liability, and one past its life is a gamble.
    const fleet = Math.min(4, c.fleet || 1);
    const rel = (REL[c.engineering] || 0.72) * (FLEET_PENALTY[fleet] || 0.85)
              * engineHealth(c.engine_hours || 0);
    const mechRisk = (1 - rel) * (leg.distance_km / 260);
    // and contact, from his own care and the temper of the field
    const contactRisk = (1 - c.avoidance_of_mistakes) * 0.05
                      + (1 - c.avoidance_of_forced_mistakes) * meanAggression * 0.05;
    c.out = r() < mechRisk || r() < contactRisk;
  }

  const running = runners.filter(c => !c.out).sort((a, b) => a.time - b.time);
  const out = runners.filter(c => c.out);

  const entries = [];
  running.forEach((c, i) => entries.push({
    entryId: c.entry_id, driverId: c.driver_id, name: c.name,
    grid: c.grid, finish: i + 1, status: 'finished', isPlayer: !!c.is_player
  }));
  for (const c of out) entries.push({
    entryId: c.entry_id, driverId: c.driver_id, name: c.name,
    grid: c.grid, finish: null, status: 'retired', isPlayer: !!c.is_player
  });

  return { entries, starters: runners.length, retired: out.length };
}

module.exports = { simulateLeg, paceOf, bopEffect, BOP_RESIDUE };
