'use strict';
const { context } = require('./market');

const CORE = { amateurs: 10000, experienced: 25000, specialist: 50000 };
const CORE_BY_CLASS = {
  gt5: { amateurs: 10000, experienced: 25000, specialist: 50000 },
  gt4: { amateurs: 40000, experienced: 90000, specialist: 180000 },
  gt3: { amateurs: 180000, experienced: 320000, specialist: 500000 }
};
const MIN_CAPITAL = { gt5: 250000, gt4: 850000, gt3: 2600000 };

// what a privateer pays to rent a crew, per round
const CREW_PER_ROUND = { gt5: [8000, 14000], gt4: [30000, 45000], gt3: [70000, 110000] };

const tier = cls => (cls === 'gt5' || cls === 'gt4') ? cls : 'gt3';

// What the driver pays for a full season. A team spreads one engineering core
// across several cars and carries the damage risk itself, so a bought seat is
// always cheaper than running the same car alone — the trade is that nothing
// belongs to the driver at the end of it.
// The base already reflects the tier, so prestige only nudges it: a minor
// regional series is a little cheaper than the flagship, not half the price.
function seatPrice(cls, prestige, rating, reputation) {
  const base = cls === 'gt5' ? 86000 : cls === 'gt4' ? 225000 : 520000;
  const standing = 0.78 + (prestige || 1) * 0.30;
  const byRating = rating === 'Gold' || rating === 'Platinum' ? 0
                 : rating === 'Silver' ? 0.55 : 1.0;
  return Math.round(base * standing * byRating * (1 - (reputation || 0) * 0.45) / 1000) * 1000;
}

// ---------------------------------------------------------------- reading
function offers(db) {
  const ctx = context(db);
  if (!ctx || !ctx.champ) return null;
  const { player, season, seat, champ } = ctx;

  const myTeam = db.prepare(`
    SELECT * FROM teams WHERE owner_driver_id = ? AND status = 'active'
      AND is_privateer = 0`).get(player.id);

  // teams in the player's championship that could take one more driver
  const seats = seat ? [] : db.prepare(`
    SELECT t.id team_id, t.name team, t.engineering, t.goals, t.country,
           cm.name car, l.livery_name livery, e.id entry_id,
           (SELECT COUNT(*) FROM entry_drivers ed WHERE ed.entry_id = e.id) filled
    FROM entries e
    JOIN teams t ON t.id = e.team_id
    JOIN chassis ch ON ch.id = e.chassis_id
    JOIN car_models cm ON cm.id = ch.model_id
    JOIN liveries l ON l.id = e.livery_id
    WHERE e.season = ? AND e.championship_id = ? AND t.is_privateer = 0
      AND (t.owner_driver_id IS NULL OR t.owner_driver_id <> ?)
    ORDER BY CASE t.engineering WHEN 'amateurs' THEN 0 WHEN 'experienced' THEN 1 ELSE 2 END`)
    .all(season.season, champ.id, player.id)
    .map(row => {
      const mult = row.engineering === 'specialist' ? 1.25
                 : row.engineering === 'experienced' ? 1.0 : 0.8;
      const fee = Math.round(seatPrice(champ.class, champ.prestige,
                                       player.fia_rating, player.reputation) * mult / 1000) * 1000;
      return Object.assign(row, { fee, affordable: fee <= player.capital,
        home: row.country === player.country });
    }).sort((a, b) => a.fee - b.fee);

  // free drivers the player could sign into a second car
  const scouting = myTeam ? db.prepare(`
    SELECT d.id, d.name, d.country, d.fia_rating, d.reputation,
           2020 - d.birth_year age, b.name block
    FROM drivers d JOIN blocks b ON b.id = d.block_id
    WHERE d.is_player = 0 AND d.status = 'active'
      AND d.id NOT IN (SELECT ed.driver_id FROM entry_drivers ed
                       JOIN entries e ON e.id = ed.entry_id WHERE e.season = ?)
      AND d.block_id IN (SELECT block_id FROM championship_blocks WHERE championship_id = ?)
    LIMIT 12`).all(season.season, champ.id).map(d => ({
      id: d.id, name: d.name, country: d.country, age: d.age,
      rating: d.fia_rating, reputation: d.reputation, block: d.block,
      // a countryman who is Bronze or Silver brings local backing
      home: d.country === player.country && (!d.fia_rating || d.fia_rating === 'Bronze' || d.fia_rating === 'Silver'),
      pays: seatPrice(champ.class, champ.prestige, d.fia_rating, d.reputation)
    })) : [];

  const t = tier(champ.class);
  const rounds = db.prepare(`SELECT rounds FROM championships WHERE id = ?`).get(champ.id).rounds;
  // one-make series quote their own car; open classes quote the cheapest
  const cheapCar = champ.model_id
    ? db.prepare(`SELECT price_new p FROM car_models WHERE id = ?`).get(champ.model_id).p
    : db.prepare(`SELECT MIN(price_new) p FROM car_models
        WHERE purchasable = 1 AND class IN (${
          champ.class === 'gt4' ? "'gt4'" : "'gt3_gen1','gt3_gen2','gto'"})`).get().p;
  const crew = CREW_PER_ROUND[t];

  return {
    privateerCost: {
      car: cheapCar,
      crewLow: crew[0] * rounds, crewHigh: crew[1] * rounds,
      totalLow: (cheapCar || 0) + crew[0] * rounds,
      totalHigh: (cheapCar || 0) + crew[1] * rounds
    },
    championship: champ.name, championshipClass: champ.class,
    week: season.week, open: season.week <= 4,
    capital: player.capital, hasSeat: !!seat,
    team: myTeam ? { id: myTeam.id, name: myTeam.name, engineering: myTeam.engineering } : null,
    canFormTeam: !myTeam && player.capital >= MIN_CAPITAL[t],
    minCapital: MIN_CAPITAL[t],
    coreCost: CORE_BY_CLASS[t],
    seats, scouting
  };
}

// ---------------------------------------------------------------- actions
function takeSeat(db, entryId) {
  const ctx = context(db);
  if (!ctx) throw new Error('No career open.');
  if (ctx.seat) throw new Error('You already have a seat this season.');
  if (ctx.season.week > 4) throw new Error('The entry list for this season has closed.');

  const row = db.prepare(`
    SELECT e.*, t.engineering, t.name team, cm.name car
    FROM entries e JOIN teams t ON t.id = e.team_id
    JOIN chassis ch ON ch.id = e.chassis_id JOIN car_models cm ON cm.id = ch.model_id
    WHERE e.id = ?`).get(entryId);
  if (!row) throw new Error('That seat is gone.');

  const mult = row.engineering === 'specialist' ? 1.25
             : row.engineering === 'experienced' ? 1.0 : 0.8;
  const fee = Math.round(seatPrice(ctx.champ.class, ctx.champ.prestige,
                                   ctx.player.fia_rating, ctx.player.reputation) * mult / 1000) * 1000;
  if (fee > ctx.player.capital) throw new Error('You cannot afford that seat.');

  return db.transaction(() => {
    const role = db.prepare(`SELECT COUNT(*) n FROM entry_drivers WHERE entry_id = ?`).get(entryId).n + 1;
    db.prepare(`INSERT INTO entry_drivers (entry_id,driver_id,role,seat_fee) VALUES (?,?,?,?)`)
      .run(entryId, ctx.player.id, role, fee);
    db.prepare(`UPDATE drivers SET capital = capital - ? WHERE id = ?`).run(fee, ctx.player.id);
    db.prepare(`INSERT INTO ledger (season,week,entity_type,entity_id,amount,reason)
                VALUES (?,?,'driver',?,?, 'seat_fee')`)
      .run(ctx.season.season, ctx.season.week, ctx.player.id, -fee);
    db.prepare(`UPDATE news SET read = 1 WHERE headline = 'You have no car yet'`).run();
    db.prepare(`INSERT INTO news (season,week,category,headline,body) VALUES (?,?,'market',?,?)`)
      .run(ctx.season.season, ctx.season.week, `You have signed with ${row.team}`,
           `${row.car} in the ${ctx.champ.name}. Seat fee ${fee}.`);
    return { team: row.team, car: row.car, fee, capital: ctx.player.capital - fee };
  })();
}

function formTeam(db, engineering, customName) {
  const ctx = context(db);
  if (!ctx || !ctx.champ) throw new Error('No championship.');
  if (ctx.season.week > 4) throw new Error('Teams can only be formed in the winter.');
  const existing = db.prepare(`SELECT id FROM teams WHERE owner_driver_id = ?
      AND is_privateer = 0 AND status = 'active'`).get(ctx.player.id);
  if (existing) throw new Error('You already run a team.');

  const t = tier(ctx.champ.class);
  const cost = CORE_BY_CLASS[t][engineering];
  if (!cost) throw new Error('Unknown engineering level.');
  if (ctx.player.capital < MIN_CAPITAL[t])
    throw new Error(`Forming a team here needs at least ${MIN_CAPITAL[t]} in capital.`);
  if (cost > ctx.player.capital) throw new Error('You cannot afford that engineering core.');

  return db.transaction(() => {
    const name = (customName || '').trim() ||
                 `${ctx.player.name.split(' ').pop()} Racing`;
    const teamId = db.prepare(`INSERT INTO teams
        (name,country,block_id,founded_season,is_privateer,owner_driver_id,capital,engineering,goals)
        VALUES (?,?,?,?,0,?,?,?, 'normal')`)
      .run(name, ctx.player.country, ctx.player.block_id, ctx.season.season,
           ctx.player.id, 0, engineering).lastInsertRowid;

    // a car already bought as a privateer moves under the new team
    const priv = db.prepare(`SELECT id FROM teams WHERE owner_driver_id = ? AND is_privateer = 1`)
      .get(ctx.player.id);
    if (priv) {
      db.prepare(`UPDATE chassis SET owner_team_id = ? WHERE owner_team_id = ?`).run(teamId, priv.id);
      db.prepare(`UPDATE entries SET team_id = ? WHERE team_id = ?`).run(teamId, priv.id);
      db.prepare(`UPDATE teams SET status = 'folded' WHERE id = ?`).run(priv.id);
    }

    db.prepare(`UPDATE drivers SET capital = capital - ? WHERE id = ?`).run(cost, ctx.player.id);
    db.prepare(`UPDATE career SET player_team_id = ? WHERE id = 1`).run(teamId);
    db.prepare(`INSERT INTO ledger (season,week,entity_type,entity_id,amount,reason)
                VALUES (?,?,'driver',?,?, 'team_formation')`)
      .run(ctx.season.season, ctx.season.week, ctx.player.id, -cost);
    db.prepare(`INSERT INTO news (season,week,category,headline,body) VALUES (?,?,'team',?,?)`)
      .run(ctx.season.season, ctx.season.week, `${name} has been founded`,
           `Engineering: ${engineering}.`);
    return { team: name, engineering, cost, capital: ctx.player.capital - cost };
  })();
}

// Sign a paying driver into one of the team's cars.
function signDriver(db, driverId, entryId) {
  const ctx = context(db);
  if (!ctx) throw new Error('No career open.');
  if (ctx.season.week > 4) throw new Error('Signings are closed for this season.');
  const team = db.prepare(`SELECT * FROM teams WHERE owner_driver_id = ?
      AND status='active' AND is_privateer = 0`).get(ctx.player.id);
  if (!team) throw new Error('You do not run a team.');

  const entry = db.prepare(`SELECT * FROM entries WHERE id = ? AND team_id = ?`).get(entryId, team.id);
  if (!entry) throw new Error('That car is not yours.');
  const filled = db.prepare(`SELECT COUNT(*) n FROM entry_drivers WHERE entry_id = ?`).get(entryId).n;
  const need = db.prepare(`SELECT drivers_per_car FROM championship_levels cl
     JOIN championships c ON c.level_id = cl.id WHERE c.id = ?`).get(entry.championship_id).drivers_per_car;
  if (filled >= need) throw new Error('That car already has its drivers.');

  const d = db.prepare(`SELECT * FROM drivers WHERE id = ?`).get(driverId);
  if (!d) throw new Error('Unknown driver.');
  const busy = db.prepare(`SELECT 1 FROM entry_drivers ed JOIN entries e ON e.id = ed.entry_id
     WHERE ed.driver_id = ? AND e.season = ?`).get(driverId, ctx.season.season);
  if (busy) throw new Error('That driver has already signed elsewhere.');

  const fee = seatPrice(ctx.champ.class, ctx.champ.prestige, d.fia_rating, d.reputation);
  return db.transaction(() => {
    db.prepare(`INSERT INTO entry_drivers (entry_id,driver_id,role,seat_fee) VALUES (?,?,?,?)`)
      .run(entryId, driverId, filled + 1, fee);
    db.prepare(`UPDATE drivers SET capital = capital + ? WHERE id = ?`).run(fee, ctx.player.id);
    db.prepare(`INSERT INTO ledger (season,week,entity_type,entity_id,amount,reason)
                VALUES (?,?,'driver',?,?, 'seat_fee_received')`)
      .run(ctx.season.season, ctx.season.week, ctx.player.id, fee);
    db.prepare(`INSERT INTO news (season,week,category,headline,body) VALUES (?,?,'team',?,?)`)
      .run(ctx.season.season, ctx.season.week, `${d.name} joins ${team.name}`, '');
    return { driver: d.name, fee, capital: ctx.player.capital + fee };
  })();
}

module.exports = { offers, takeSeat, formTeam, signDriver, CORE_BY_CLASS, MIN_CAPITAL };
