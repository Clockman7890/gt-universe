'use strict';
const { context } = require('./market');

const CORE = { amateurs: 10000, experienced: 25000, specialist: 50000 };
const CORE_BY_CLASS = {
  gt5: { amateurs: 10000, experienced: 25000, specialist: 50000 },
  gt4: { amateurs: 40000, experienced: 90000, specialist: 180000 },
  gt3: { amateurs: 180000, experienced: 320000, specialist: 500000 }
};
const MIN_CAPITAL = { gt5: 250000, gt4: 850000, gt3: 2600000 };

// What a class asks of a driver's own purse before it will have him at all,
// whether he owns the car or is paid to sit in somebody else's. A GT4 weekend
// costs money a GT5 season never sees — tyres, travel, a bill after a shunt —
// and a driver who cannot carry that is no use to a team either. Short of it,
// the only road open is his own regional GT5 series.
// GT5 turns nobody away: it is the way in. GT4 is the first door with a price
// on it. GT3 is scaled from the GT4 figure by what the classes actually cost to
// run — a seat is 225k against 520k, a crew 30-45k a round against 70-110k,
// both a little over twice — which puts the GT3 floor just under the price of
// the seat itself. Change either number here and the whole ladder follows.
const MIN_TO_RACE = { gt5: 0, gt4: 200000, gt3: 500000, lmdh: 500000 };

// Buildings and equipment, paid once and kept for life. A team that works its
// way up pays less than one that starts at the top, and nobody founds a team
// straight into GT3 — that workshop has to be earned.
const FACILITIES = { gt5: 50000, gt4: 100000 };
const UPGRADE    = { gt4: 30000, gt3: 15000 };

// what a privateer pays to rent a crew, per round
const CREW_PER_ROUND = { gt5: [8000, 14000], gt4: [30000, 45000], gt3: [70000, 110000] };

const tier = cls => (cls === 'gt5' || cls === 'gt4') ? cls : 'gt3';

// Series where the cars belong to permanent franchises: a driver can only buy
// a seat, never own a car or found a team.
const FRANCHISE = new Set(['australasian_arc']);

// Nobody hands a seat to a stranger. The better the outfit, the more it wants
// to see first — a name it recognises, or at least a licence above bronze.
function willHave(row, player) {
  const need = row.engineering === 'specialist' ? 0.34
             : row.engineering === 'experienced' ? 0.14 : 0.0;
  const rep = player.reputation || 0;
  const rated = player.fia_rating === 'Gold' || player.fia_rating === 'Platinum' ? 0.18
              : player.fia_rating === 'Silver' ? 0.08 : 0;
  if (rep + rated >= need) return null;
  return row.engineering === 'specialist'
    ? 'they only take drivers with a name'
    : 'you are unknown to them';
}

// A stable ±18% per team, so the paddock does not quote one price.
function teamFactor(id, goals) {
  let h = (id * 2654435761) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 2246822507) >>> 0; h ^= h >>> 13;
  const spread = 0.82 + (h % 1000) / 1000 * 0.36;
  const ambition = goals === 'max_pressure' ? 1.08 : goals === 'low_pressure' ? 0.94 : 1.0;
  return spread * ambition;
}

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
           cm.name car, l.livery_name livery, e.id entry_id, ch.dev_bonus,
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
      // every outfit prices its own seat: a settled team asks more, one that
      // needs the money asks less
      // a quicker car is worth more to sit in
      const pace = 1 + (row.dev_bonus || 0) * 0.9;
      const fee = Math.round(seatPrice(champ.class, champ.prestige,
                             player.fia_rating, player.reputation)
                             * mult * pace * teamFactor(row.team_id, row.goals) / 500) * 500;
      const refuses = willHave(row, player);
      return Object.assign(row, {
        fee, refuses,
        affordable: !refuses && fee <= player.capital,
        home: row.country === player.country
      });
    }).sort((a, b) => (a.refuses ? 1 : 0) - (b.refuses ? 1 : 0) || a.fee - b.fee);

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
      pays: Math.round(seatPrice(champ.class, champ.prestige, d.fia_rating, d.reputation)
                       * teamFactor(d.id, 'normal') / 500) * 500
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
    franchiseOnly: FRANCHISE.has(champ.id),
    upgrade: upgradeDue(db),
    canFormTeam: !myTeam && t !== 'gt3' && !FRANCHISE.has(champ.id)
                 && player.capital >= MIN_CAPITAL[t],
    noTeamsHere: t === 'gt3',
    minCapital: MIN_CAPITAL[t],
    facilityCost: FACILITIES[t] || null,
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
    SELECT e.*, t.engineering, t.name team, t.id team_id, t.goals, cm.name car,
           (SELECT MAX(cl.drivers_per_car) FROM championships c2
            JOIN championship_levels cl ON cl.id = c2.level_id
            WHERE c2.id = e.championship_id
               OR c2.shares_entries_with = e.championship_id) seats
    FROM entries e JOIN teams t ON t.id = e.team_id
    JOIN chassis ch ON ch.id = e.chassis_id JOIN car_models cm ON cm.id = ch.model_id
    WHERE e.id = ?`).get(entryId);
  if (!row) throw new Error('That seat is gone.');

  // The floor applies to a hired driver exactly as it does to an owner: the
  // class costs what it costs whoever's name is on the car.
  const floor = MIN_TO_RACE[ctx.champ.class] || 0;
  if (ctx.player.capital < floor)
    throw new Error(`A ${ctx.champ.class.toUpperCase()} drive needs at least ` +
                    `€${floor.toLocaleString('en-GB')} in capital, even as a hired driver.`);

  const refuses = willHave(row, ctx.player);
  if (refuses) throw new Error(`They are not interested — ${refuses}.`);

  const mult = row.engineering === 'specialist' ? 1.25
             : row.engineering === 'experienced' ? 1.0 : 0.8;
  const fee = Math.round(seatPrice(ctx.champ.class, ctx.champ.prestige,
                         ctx.player.fia_rating, ctx.player.reputation)
                         * mult * teamFactor(row.team_id, row.goals) / 500) * 500;
  if (fee > ctx.player.capital) throw new Error('You cannot afford that seat.');

  return db.transaction(() => {
    const inCar = db.prepare(`
      SELECT ed.role, ed.driver_id, d.name FROM entry_drivers ed
      JOIN drivers d ON d.id = ed.driver_id
      WHERE ed.entry_id = ? ORDER BY ed.role`).all(entryId);

    // a paying driver takes the seat; if the car is full the slowest of the
    // incumbents loses his drive
    let role, dropped = null;
    if (inCar.length < row.seats) {
      role = inCar.length + 1;
    } else {
      const worst = db.prepare(`
        SELECT ed.role, ed.driver_id, d.name FROM entry_drivers ed
        JOIN drivers d ON d.id = ed.driver_id
        JOIN driver_skills s ON s.driver_id = d.id
        WHERE ed.entry_id = ? ORDER BY s.race_skill ASC LIMIT 1`).get(entryId);
      role = worst.role; dropped = worst.name;
      db.prepare(`DELETE FROM entry_drivers WHERE entry_id = ? AND driver_id = ?`)
        .run(entryId, worst.driver_id);
    }

    db.prepare(`INSERT INTO entry_drivers (entry_id,driver_id,role,seat_fee) VALUES (?,?,?,?)`)
      .run(entryId, ctx.player.id, role, fee);
    if (dropped)
      db.prepare(`INSERT INTO news (season,week,category,headline,body) VALUES (?,?,'driver',?,?)`)
        .run(ctx.season.season, ctx.season.week,
             `${dropped} loses his seat at ${row.team}`,
             'Replaced by a driver bringing a budget.');
    db.prepare(`UPDATE drivers SET capital = capital - ? WHERE id = ?`).run(fee, ctx.player.id);
    db.prepare(`INSERT INTO ledger (season,week,entity_type,entity_id,amount,reason)
                VALUES (?,?,'driver',?,?, 'seat_fee')`)
      .run(ctx.season.season, ctx.season.week, ctx.player.id, -fee);
    db.prepare(`UPDATE news SET read = 1 WHERE headline = 'You have no car yet'`).run();
    db.prepare(`INSERT INTO news (season,week,category,headline,body) VALUES (?,?,'market',?,?)`)
      .run(ctx.season.season, ctx.season.week, `You have signed with ${row.team}`,
           `${row.car} in the ${ctx.champ.name}. Seat fee ${fee}.`);
    return { team: row.team, car: row.car, fee, dropped,
             capital: ctx.player.capital - fee };
  })();
}

function formTeam(db, engineering, customName) {
  const ctx = context(db);
  if (!ctx || !ctx.champ) throw new Error('No championship.');
  if (ctx.season.week > 4) throw new Error('Teams can only be formed in the winter.');
  const existing = db.prepare(`SELECT id FROM teams WHERE owner_driver_id = ?
      AND is_privateer = 0 AND status = 'active'`).get(ctx.player.id);
  if (existing) throw new Error('You already run a team.');

  if (FRANCHISE.has(ctx.champ.id))
    throw new Error('The cars in this series belong to its teams. You can only take a seat.');
  const t = tier(ctx.champ.class);
  if (t === 'gt3')
    throw new Error('No team is founded straight into GT3. Build one lower down, ' +
                    'race it a season, and bring the workshop up.');
  const core = CORE_BY_CLASS[t][engineering];
  if (!core) throw new Error('Unknown engineering level.');
  const facility = FACILITIES[t];
  const cost = core + facility;
  if (ctx.player.capital < MIN_CAPITAL[t])
    throw new Error(`Forming a team here needs at least ${MIN_CAPITAL[t]} in capital.`);
  if (cost > ctx.player.capital)
    throw new Error('You cannot afford the workshop and that engineering core.');

  return db.transaction(() => {
    const name = (customName || '').trim() ||
                 `${ctx.player.name.split(' ').pop()} Racing`;
    const teamId = db.prepare(`INSERT INTO teams
        (name,country,block_id,founded_season,is_privateer,owner_driver_id,capital,
         engineering,facilities,goals)
        VALUES (?,?,?,?,0,?,?,?,?, 'normal')`)
      .run(name, ctx.player.country, ctx.player.block_id, ctx.season.season,
           ctx.player.id, 0, engineering, t).lastInsertRowid;

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
           `Workshop fitted for ${t.toUpperCase()}. Engineering: ${engineering}.`);
    return { team: name, engineering, cost, facility, core,
             capital: ctx.player.capital - cost };
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

  const fee = Math.round(seatPrice(ctx.champ.class, ctx.champ.prestige,
                         d.fia_rating, d.reputation) * teamFactor(d.id, 'normal') / 500) * 500;
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

// --------------------------------------------------- bringing a team up a tier
// Buildings and equipment are bought once and kept. A team that works its way
// up pays only the difference between the workshop it has and the one the next
// class needs, and never pays for a tier it has already been fitted for.
const TIER_ORDER = ['gt5', 'gt4', 'gt3'];

function upgradeDue(db) {
  const c = db.prepare(`SELECT player_driver_id, player_championship_id FROM career
                        WHERE id = 1`).get();
  const team = db.prepare(`SELECT * FROM teams WHERE owner_driver_id = ?
      AND status = 'active' AND is_privateer = 0`).get(c.player_driver_id);
  if (!team || !c.player_championship_id) return null;
  const champ = db.prepare(`SELECT class FROM championships WHERE id = ?`)
    .get(c.player_championship_id);
  if (!champ) return null;

  const want = tier(champ.class);
  const have = team.facilities || 'gt5';
  const from = TIER_ORDER.indexOf(have), to = TIER_ORDER.indexOf(want);
  if (to <= from) return null;

  let cost = 0;
  const steps = [];
  for (let k = from + 1; k <= to; k++) {
    cost += UPGRADE[TIER_ORDER[k]] || 0;
    steps.push(TIER_ORDER[k]);
  }
  return { team: team.name, teamId: team.id, from: have, to: want, steps, cost };
}

function upgradeTeam(db) {
  const c = db.prepare(`SELECT season, week, player_driver_id FROM career WHERE id = 1`).get();
  if (c.week > 4) throw new Error('The workshop can only be rebuilt in the winter.');
  const due = upgradeDue(db);
  if (!due) throw new Error('Your workshop is already fit for that class.');

  const me = db.prepare(`SELECT capital FROM drivers WHERE id = ?`).get(c.player_driver_id);
  if (me.capital < due.cost)
    throw new Error('You cannot afford to rebuild the workshop for that class.');

  return db.transaction(() => {
    db.prepare(`UPDATE teams SET facilities = ? WHERE id = ?`).run(due.to, due.teamId);
    db.prepare(`UPDATE drivers SET capital = capital - ? WHERE id = ?`)
      .run(due.cost, c.player_driver_id);
    db.prepare(`INSERT INTO ledger (season,week,entity_type,entity_id,amount,reason)
                VALUES (?,?,'driver',?,?, 'facilities')`)
      .run(c.season, c.week, c.player_driver_id, -due.cost);
    db.prepare(`INSERT INTO news (season,week,category,headline,body) VALUES (?,?,'team',?,?)`)
      .run(c.season, c.week, `${due.team} rebuilds for ${due.to.toUpperCase()}`,
           `Workshop and equipment brought up from ${due.from.toUpperCase()}.`);
    return Object.assign(due, { capital: me.capital - due.cost });
  })();
}

// ------------------------------------------------------------- where to race
// The championships the player may enter this winter. A driver may always go
// back down, stay where they are, or take one step up; GT3 asks for a licence,
// which means a season already spent in GT4.
function eligible(db) {
  const c = db.prepare(`SELECT season, week, player_driver_id, player_championship_id,
                               champ_chosen_season
                        FROM career WHERE id = 1`).get();
  const me = db.prepare(`SELECT * FROM drivers WHERE id = ?`).get(c.player_driver_id);
  if (!me) return null;

  const raced = db.prepare(`
    SELECT DISTINCT ch.class FROM entries e
    JOIN entry_drivers ed ON ed.entry_id = e.id
    JOIN championships ch ON ch.id = e.championship_id
    WHERE ed.driver_id = ?`).all(me.id).map(r => r.class);

  // The tier they count as is the highest they have raced, or the one they are
  // already aiming at if they have not raced yet: a driver who chose GT4 at the
  // start has not driven a race, but GT4 is still where they belong.
  const aiming = c.player_championship_id
    ? db.prepare(`SELECT class FROM championships WHERE id = ?`).get(c.player_championship_id)
    : null;
  if (aiming) raced.push(aiming.class);

  const ORDER = ['gt5', 'gt4', 'gt3', 'lmdh'];
  const best = raced.reduce((m, x) => Math.max(m, ORDER.indexOf(x)), -1);
  const ceiling = Math.min(ORDER.length - 1, best + 1);

  const rows = db.prepare(`
    SELECT c.id, c.name, c.class, c.prestige, c.home_continent,
           (SELECT COUNT(*) FROM entries e WHERE e.season = @season AND e.championship_id = c.id) cars,
           (SELECT COUNT(*) FROM championship_blocks cb
            WHERE cb.championship_id = c.id AND cb.block_id = @block) mine
    FROM championships c
    WHERE c.active_from <= @season AND c.shares_entries_with IS NULL
    ORDER BY c.class, c.prestige DESC`).all({ season: c.season, block: me.block_id });

  const out = [];
  for (const row of rows) {
    const at = ORDER.indexOf(row.class);
    if (at < 0 || at > ceiling) continue;
    // GT5 is regional: only the series that feeds the player's own block.
    // Above that a driver travels, but their own continent comes first.
    if (row.class === 'gt5' && !row.mine) continue;
    if (row.class === 'gt3' && best < ORDER.indexOf('gt4')) continue;

    const home = db.prepare(`SELECT continent FROM blocks WHERE id = ?`).get(me.block_id).continent;
    // Shown, not hidden: a driver should be able to see the class he cannot
    // afford yet, and what it would take to get there.
    const floor = MIN_TO_RACE[row.class] || 0;
    const short = me.capital < floor;
    out.push({
      id: row.id, name: row.name, cls: row.class, cars: row.cars,
      home: row.home_continent === home,
      current: row.id === c.player_championship_id,
      step: at > best ? 'up' : at === best ? 'same' : 'down',
      locked: short, floor,
      why: short ? `Needs €${floor.toLocaleString('en-GB')} in capital` : null
    });
  }
  return { season: c.season, open: c.week <= 4, rating: me.fia_rating,
           current: c.player_championship_id,
           settled: c.champ_chosen_season === c.season,
           options: out };
}

// Point the player at a championship. Only possible while nothing has been
// bought or signed, and only inside the four weeks.
function choose(db, championshipId) {
  const c = db.prepare(`SELECT season, week, player_driver_id FROM career WHERE id = 1`).get();
  if (c.week > 4) throw new Error('Entries are closed for this season.');
  const seat = db.prepare(`
    SELECT 1 FROM entry_drivers ed JOIN entries e ON e.id = ed.entry_id
    WHERE ed.driver_id = ? AND e.season = ?`).get(c.player_driver_id, c.season);
  if (seat) throw new Error('You already have a drive this season.');

  const list = eligible(db);
  const want = list && list.options.find(o => o.id === championshipId);
  if (!want) throw new Error('You are not eligible for that championship yet.');
  if (want.locked)
    throw new Error(`Racing in ${want.name} needs at least ` +
                    `€${want.floor.toLocaleString('en-GB')} in capital, owned car or hired seat. ` +
                    `Your own GT5 series is the road open to you.`);

  // Recording the season as well as the championship is what tells Home the
  // question has been answered. It is deliberately not carried forward: a new
  // season asks again, which is the whole point of the choice.
  db.prepare(`UPDATE career SET player_championship_id = ?, champ_chosen_season = ?
              WHERE id = 1`).run(championshipId, c.season);
  const name = db.prepare(`SELECT name FROM championships WHERE id = ?`).get(championshipId).name;
  db.prepare(`INSERT INTO news (season,week,category,headline,body) VALUES (?,?,'market',?,?)`)
    .run(c.season, c.week, `You are aiming at the ${name}`,
         'Buy a car in the Market or take a seat in the Office before week 4 is out.');
  return { championship: name };
}

module.exports = { offers, takeSeat, formTeam, signDriver, eligible, choose,
                   upgradeDue, upgradeTeam,
                   CORE_BY_CLASS, MIN_CAPITAL, FACILITIES, UPGRADE };
