'use strict';
// What happens between one season and the next.
//
// A season is not a fresh world. The teams that survived the year are still
// there, still own their cars, and still want drivers. People have got a year
// older: some quicker, some slower, a few too old to carry on. The championship
// tables decide who moved up. Only once all that has settled does the player
// get their four weeks to arrange a drive, which is why this has to run before
// week one rather than at week five.

const { rng, pick, pickWeighted, NameFactory, TeamFactory } = require('./names');
const { ageUp, skills, yearlyGain, clamp, round3, between, irange } = require('./population');
const { lockEntries } = require('./season');

const SKILL_FIELDS = ['race_skill', 'qualifying_skill', 'start_reactions', 'consistency',
  'avoidance_of_mistakes', 'avoidance_of_forced_mistakes', 'wet_skill', 'tyre_management',
  'fuel_management', 'weather_tyre_changes', 'defending', 'aggression', 'stamina',
  'blue_flag_conceding'];

const SPEED_FIELDS = ['race_skill', 'qualifying_skill', 'start_reactions'];
const JUDGE_FIELDS = ['consistency', 'avoidance_of_mistakes', 'avoidance_of_forced_mistakes',
  'wet_skill', 'tyre_management', 'fuel_management', 'weather_tyre_changes', 'defending'];

const RETIRE_AT = 55;

// ---------------------------------------------------------------- a year older
// Skills move by age, each family at its own rate, never past the ceiling the
// driver was born with.
function ageEveryone(db, r, year) {
  const rows = db.prepare(`
    SELECT d.id, d.birth_year, d.pot_speed, d.pot_judgement, d.pot_stamina, s.*
    FROM drivers d JOIN driver_skills s ON s.driver_id = d.id
    WHERE d.status = 'active'`).all();

  const set = db.prepare(`UPDATE driver_skills SET ` +
    SKILL_FIELDS.map(f => `${f} = @${f}`).join(', ') + ` WHERE driver_id = @id`);

  let faster = 0, slower = 0;
  for (const d of rows) {
    const age = year - d.birth_year;
    const [ds, dj, dt] = yearlyGain(age, r);
    const next = { id: d.id };
    for (const f of SKILL_FIELDS) {
      let v = d[f];
      if (SPEED_FIELDS.includes(f)) v = clamp(v + ds, 0.10, d.pot_speed);
      else if (JUDGE_FIELDS.includes(f)) v = clamp(v + dj, 0.10, d.pot_judgement);
      else if (f === 'stamina') v = clamp(v + dt, 0.10, d.pot_stamina);
      next[f] = round3(v);
    }
    if (next.race_skill > d.race_skill) faster++;
    else if (next.race_skill < d.race_skill) slower++;
    set.run(next);
  }
  return { aged: rows.length, faster, slower };
}

// ---------------------------------------------------------------- hanging up
// Age ends everyone eventually. Before that it is a matter of whether there is
// any point carrying on: no drive last year, no progress for years, or no money
// left to pay for a season.
function retirements(db, r, year, season) {
  const rows = db.prepare(`
    SELECT d.id, d.name, d.birth_year, d.capital, d.passive_income, d.is_player,
           (SELECT COUNT(*) FROM entry_drivers ed JOIN entries e ON e.id = ed.entry_id
            WHERE ed.driver_id = d.id AND e.season = ?) raced
    FROM drivers d WHERE d.status = 'active' AND d.is_player = 0`).all(season - 1);

  const out = [];
  for (const d of rows) {
    const age = year - d.birth_year;
    if (age >= RETIRE_AT) { out.push({ ...d, age, why: 'age' }); continue; }

    let chance = 0.02;
    if (age >= 45) chance *= 3;
    else if (age >= 38) chance *= 1.8;
    if (!d.raced) chance *= 3;                       // a year on the sidelines
    if (d.capital + d.passive_income < 40000) chance *= 2.5;
    if (r() < Math.min(0.85, chance)) out.push({ ...d, age, why: !d.raced ? 'no drive' : 'money' });
  }

  const mark = db.prepare(`UPDATE drivers SET status = 'retired', retired_season = ? WHERE id = ?`);
  for (const d of out) mark.run(season, d.id);
  return out;
}

// How many people take up racing this year, and where they come from.
//
// This deliberately does NOT look at how many seats are empty. Counting the
// grid and then producing exactly enough drivers to fill it means a
// championship can never be short, which is the opposite of how racing works:
// a series that cannot find drivers runs a thin grid until it becomes worth
// entering. Production follows the regions and the countries that actually
// produce racing drivers, and the grids take what that gives them.
//
// A region's intake is its share of a modest worldwide crop, set against the
// people already racing there. Somewhere with a lot of active drivers keeps
// producing more of them; somewhere small stays small.
const INTAKE = 0.060;          // newcomers per active driver per year, worldwide
const INTAKE_MIN = 6;
const INTAKE_MAX = 34;

function intake(db, r) {
  const active = db.prepare(`SELECT COUNT(*) n FROM drivers
                             WHERE status = 'active' AND is_player = 0`).get().n;
  const crop = Math.round(active * INTAKE * (0.82 + r() * 0.36));
  return Math.max(INTAKE_MIN, Math.min(INTAKE_MAX, crop));
}

// New people arrive, weighted to the blocks that produce most and, inside each
// block, to the countries that produce most.
function newTalent(db, world, r, namesDb, year, count) {
  if (count <= 0) return [];
  const blocks = db.prepare(`SELECT id, continent, production_weight FROM blocks`).all();
  const total = blocks.reduce((m, b) => m + b.production_weight, 0);
  const countries = {};
  for (const b of blocks)
    countries[b.id] = db.prepare(`SELECT code, weight FROM countries WHERE block_id = ?`).all(b.id);

  const nf = new NameFactory(namesDb, (year * 31 + count) >>> 0);
  const insD = db.prepare(`INSERT INTO drivers
    (name,country,block_id,birth_year,is_player,origin,fia_rating,reputation,capital,
     passive_income,pot_speed,pot_judgement,pot_stamina)
    VALUES (@name,@country,@block,@birth,0,'gt5',NULL,0,@capital,@passive,@ps,@pj,@pt)`);
  const insS = db.prepare(`INSERT INTO driver_skills
    (driver_id,` + SKILL_FIELDS.join(',') + `)
    VALUES (@id,` + SKILL_FIELDS.map(f => '@' + f).join(',') + `)`);

  // every place is drawn from the world's production, nobody is conscripted
  const queue = [];
  for (let k = 0; k < count; k++) queue.push(null);

  const made = [];
  for (const forced of queue) {
    let block = forced;
    if (!block) {
      let roll = r() * total; block = blocks[0];
      for (const b of blocks) { roll -= b.production_weight; if (roll <= 0) { block = b; break; } }
    }
    const pool = countries[block.id] || [{ code: 'GBR', weight: 1 }];
    const code = pickWeighted(r, pool, x => x.weight).code;
    const age = irange(r, 18, 24);
    const pot = {
      speed: round3(between(r, 0.62, 0.95)),
      judgement: round3(between(r, 0.60, 0.95)),
      stamina: round3(between(r, 0.62, 0.95))
    };
    const wealth = db.prepare(`SELECT passive_multiplier m FROM blocks WHERE id = ?`)
      .get(block.id).m;

    const id = insD.run({
      name: nf.driver(code, year - age), country: code, block: block.id,
      birth: year - age,
      capital: Math.round(between(r, 150000, 3000000) * wealth / 1000) * 1000,
      passive: Math.round(between(r, 10000, 300000) * wealth / 1000) * 1000,
      ps: pot.speed, pj: pot.judgement, pt: pot.stamina
    }).lastInsertRowid;

    const f = ageUp(r, age, pot);
    insS.run(Object.assign({ id }, skills(r, f)));
    made.push({ id, age, country: code });
  }
  return made;
}

// ---------------------------------------------------------------- licences
// A rating follows what a driver did, a season behind. Winning in GT3 makes a
// professional of you; turning up in GT4 makes you an amateur with a licence.
function reviewRatings(db, season, year) {
  const last = season - 1;
  const rows = db.prepare(`
    SELECT d.id, d.name, d.birth_year, d.fia_rating, d.is_player,
           ch.class, SUM(res.points) pts,
           SUM(CASE WHEN res.finish_pos = 1 THEN 1 ELSE 0 END) wins,
           SUM(CASE WHEN res.finish_pos <= 3 AND res.finish_pos IS NOT NULL THEN 1 ELSE 0 END) pods
    FROM results res
    JOIN legs l ON l.id = res.leg_id
    JOIN rounds r ON r.id = l.round_id
    JOIN championships ch ON ch.id = r.championship_id
    JOIN drivers d ON d.id = res.driver_id
    WHERE r.season = ? AND d.status = 'active'
    GROUP BY d.id, ch.class`).all(last);

  const best = {};
  const order = { gt5: 0, gt4: 1, gt3: 2, lmdh: 3 };
  for (const row of rows) {
    const cur = best[row.id];
    if (!cur || order[row.class] > order[cur.class]) best[row.id] = row;
  }

  const up = db.prepare(`UPDATE drivers SET fia_rating = ? WHERE id = ?`);
  const RANK = { Bronze: 0, Silver: 1, Gold: 2, Platinum: 3 };
  const NAME = ['Bronze', 'Silver', 'Gold', 'Platinum'];
  const changed = [];

  for (const id of Object.keys(best)) {
    const row = best[id];
    const age = year - row.birth_year;
    let want = RANK[row.fia_rating] !== undefined ? RANK[row.fia_rating] : -1;

    if (row.class === 'gt5') {
      // GT5 carries no licence; a driver only gets one on stepping up
      if (want < 0) continue;
    } else {
      if (want < 0) want = age < 25 ? 1 : 0;                 // Silver young, Bronze otherwise
      if (row.class === 'gt3' || row.class === 'lmdh') {
        if (row.wins >= 3) want = Math.max(want, 3);
        else if (row.wins >= 1 || row.pods >= 4) want = Math.max(want, 2);
      } else if (row.class === 'gt4') {
        if (row.wins >= 3 || row.pods >= 5) want = Math.max(want, 2);
        else if (row.wins >= 1) want = Math.max(want, 1);
      }
    }
    want = Math.min(3, Math.max(0, want));
    if (NAME[want] !== row.fia_rating) {
      up.run(NAME[want], row.id);
      changed.push({ id: row.id, name: row.name, from: row.fia_rating, to: NAME[want],
                     isPlayer: !!row.is_player });
    }
  }
  return changed;
}

// ---------------------------------------------------------------- the grids
// Teams that can still pay carry their cars into the new year and look for
// drivers. Teams that cannot fold, and their cars go on the second-hand market.
function carryTeamsForward(db, world, r, season) {
  const last = season - 1;
  const folded = [], kept = [];

  const teams = db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM entries e WHERE e.team_id = t.id AND e.season = ?) ran
    FROM teams t WHERE t.status = 'active'`).all(last);

  const me = playerId(db);
  for (const t of teams) {
    if (!t.ran) continue;                                  // never raced, nothing to carry
    // The player's own team is never wound up behind their back. A bankrupt AI
    // owner simply disappears and his cars go on the market; doing that to the
    // player took the one asset they could have sold to dig themselves out and
    // left them with a debt, no car, and nothing to press. Their reckoning is
    // handled where they can see it and act on it.
    if (t.owner_driver_id === me) { kept.push(t); continue; }
    const purse = t.owner_driver_id
      ? db.prepare(`SELECT capital, status FROM drivers WHERE id = ?`).get(t.owner_driver_id)
      : { capital: t.capital, status: 'active' };

    // an owner who has retired takes the team with him
    const gone = !purse || purse.status === 'retired' || purse.capital < -20000;
    if (gone) {
      db.prepare(`UPDATE teams SET status = 'folded', folded_season = ? WHERE id = ?`)
        .run(season, t.id);
      db.prepare(`UPDATE chassis SET for_sale = 1,
                    asking_price = CAST(value * 0.7 AS INTEGER)
                  WHERE owner_team_id = ?`).run(t.id);
      folded.push(t.name);
    } else {
      kept.push(t);
    }
  }
  return { kept, folded };
}

// Everything a chassis loses by being a year older.
function depreciate(db, season) {
  db.prepare(`UPDATE chassis SET value = CAST(value * 0.88 AS INTEGER)
              WHERE bought_season < ?`).run(season);
}

// Every AI outfit freshens its engines in the off-season; that is what a winter
// is for. The player's cars are left alone, because deciding whether to spend
// the money is the player's game to play. A car from a folded team keeps some
// of its hours: that is why it is cheap.
function serviceAiCars(db) {
  const me = playerId(db);
  db.prepare(`
    UPDATE chassis SET engine_hours = CASE WHEN for_sale = 1
                       THEN MIN(engine_hours, 11) ELSE 0 END
    WHERE engine_hours > 0
      AND owner_team_id NOT IN (SELECT id FROM teams WHERE owner_driver_id = ?)`).run(me);
}

// Rebuild the entry lists: surviving teams re-enter, their drivers stay where
// they are wanted, and whatever is still open is filled from the free pool.
let _me = null;
const playerId = db => (_me !== null ? _me
  : (_me = db.prepare(`SELECT player_driver_id p FROM career WHERE id = 1`).get().p));

function rebuildEntries(db, world, r, season, playerChampId, moving = new Set()) {
  const champs = db.prepare(`
    SELECT c.*, (
      SELECT MAX(cl.drivers_per_car) FROM championships c2
      JOIN championship_levels cl ON cl.id = c2.level_id
      WHERE c2.id = c.id OR c2.shares_entries_with = c.id
    ) drivers_per_car
    FROM championships c
    WHERE c.active_from <= ? AND c.shares_entries_with IS NULL`).all(season);

  // anyone promoted out of this class is already spoken for
  const taken = new Set(moving);
  const insEntry = db.prepare(`INSERT INTO entries
    (season,championship_id,team_id,chassis_id,livery_id,class_cup,works_support)
    VALUES (?,?,?,?,?,NULL,0)`);
  const insSeat = db.prepare(`INSERT INTO entry_drivers (entry_id,driver_id,role,seat_fee)
    VALUES (?,?,?,0)`);

  const summary = [];
  for (const c of champs) {
    // Room enough for the field the series settles at, not the one it opened
    // with. Whatever the returning teams do not take is filled afterwards.
    const w = world.championships.find(x => x.id === c.id) || {};
    // Two places are kept back for the player's four weeks. Without this the
    // returning teams take the whole grid the moment the winter ends, and in a
    // one-make series — where the number of cars is the number of liveries that
    // exist — there is then literally no way in until next winter.
    const HELD_FOR_THE_PLAYER = 2;
    const room = Math.max(c.min_grid, (w.grid || c.min_grid) - HELD_FOR_THE_PLAYER);

    // last year's teams in this championship, with the cars they own
    // The player's own cars are left out: they sit in the garage until their
    // owner decides what to do with them. Nobody else climbs into them.
    const last = db.prepare(`
      SELECT e.team_id, e.chassis_id, e.livery_id, t.name team, t.status
      FROM entries e JOIN teams t ON t.id = e.team_id
      WHERE e.season = @last AND e.championship_id = @champ
        AND (t.owner_driver_id IS NULL OR t.owner_driver_id <> @me)
      ORDER BY e.id`).all({ last: season - 1, champ: c.id, me: playerId(db) });

    let placed = 0;
    for (const old of last) {
      if (placed >= room) break;
      if (old.status !== 'active') continue;
      const chassis = db.prepare(`SELECT * FROM chassis WHERE id = ? AND for_sale = 0`)
        .get(old.chassis_id);
      if (!chassis) continue;

      // the number is kept unless somebody already has it this year
      const free = db.prepare(`SELECT 1 FROM entries WHERE season = ? AND championship_id = ?
                               AND livery_id = ?`).get(season, c.id, old.livery_id);
      let livery = old.livery_id;
      if (free) {
        const alt = db.prepare(`
          SELECT l.id FROM liveries l
          WHERE l.model_id = ?
            AND l.id NOT IN (SELECT livery_id FROM entries WHERE season = ? AND championship_id = ?)
          ORDER BY CASE l.sponsor_level WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                   l.id LIMIT 1`).get(chassis.model_id, season, c.id);
        if (!alt) continue;
        livery = alt.id;
      }

      const entryId = insEntry.run(season, c.id, old.team_id, old.chassis_id, livery).lastInsertRowid;
      placed++;

      // the drivers who were in this car, if they are still racing
      const before = db.prepare(`
        SELECT ed.driver_id, ed.role FROM entry_drivers ed
        JOIN entries e ON e.id = ed.entry_id
        JOIN drivers d ON d.id = ed.driver_id
        WHERE e.season = ? AND e.championship_id = ? AND e.team_id = ?
          AND d.status = 'active' AND d.is_player = 0
        ORDER BY ed.role`).all(season - 1, c.id, old.team_id);

      let role = 1;
      for (const b of before) {
        if (role > c.drivers_per_car) break;
        if (taken.has(b.driver_id)) continue;
        if (r() < 0.22) continue;                       // some move on regardless
        insSeat.run(entryId, b.driver_id, role++);
        taken.add(b.driver_id);
      }
      // any seat still open goes to the best free driver the region has
      while (role <= c.drivers_per_car) {
        // a driver promised to the class above is not available down here
        const d = db.prepare(`
          SELECT d.id FROM drivers d
          JOIN driver_skills s ON s.driver_id = d.id
          WHERE d.status = 'active' AND d.is_player = 0
            AND d.block_id IN (SELECT block_id FROM championship_blocks WHERE championship_id = ?)
            AND d.id NOT IN (SELECT ed.driver_id FROM entry_drivers ed
                             JOIN entries e2 ON e2.id = ed.entry_id WHERE e2.season = ?)
          ORDER BY s.race_skill DESC LIMIT 40`).all(c.id, season)
          .find(x => !taken.has(x.id));
        if (!d) break;
        insSeat.run(entryId, d.id, role++);
        taken.add(d.id);
      }
    }
    summary.push({ championship: c.name, cars: placed, of: room });
  }
  return summary;
}

// ---------------------------------------------------------------- the letter
// One item in the player's news: where they finished, what it cost, what they
// may enter now. Everything they need before spending their four weeks.
function briefing(db, season) {
  const c = db.prepare(`SELECT player_driver_id p, calendar_year y FROM career WHERE id = 1`).get();
  const me = db.prepare(`SELECT * FROM drivers WHERE id = ?`).get(c.p);
  if (!me) return null;
  const last = season - 1;

  const ran = db.prepare(`
    SELECT ch.name, ch.id, ch.class, SUM(res.points) pts,
           SUM(CASE WHEN res.finish_pos = 1 THEN 1 ELSE 0 END) wins,
           SUM(CASE WHEN res.finish_pos <= 3 AND res.finish_pos IS NOT NULL THEN 1 ELSE 0 END) pods
    FROM results res JOIN legs l ON l.id = res.leg_id JOIN rounds r ON r.id = l.round_id
    JOIN championships ch ON ch.id = r.championship_id
    WHERE r.season = ? AND res.driver_id = ?
    GROUP BY ch.id ORDER BY pts DESC LIMIT 1`).get(last, c.p);

  let place = null;
  if (ran) {
    const table = db.prepare(`
      SELECT res.driver_id, SUM(res.points) pts FROM results res
      JOIN legs l ON l.id = res.leg_id JOIN rounds r ON r.id = l.round_id
      WHERE r.season = ? AND r.championship_id = ?
      GROUP BY res.driver_id ORDER BY pts DESC`).all(last, ran.id);
    place = table.findIndex(x => x.driver_id === c.p) + 1;
  }

  const cars = db.prepare(`
    SELECT cm.name, ch.value, ch.engine_hours FROM chassis ch
    JOIN car_models cm ON cm.id = ch.model_id
    JOIN teams t ON t.id = ch.owner_team_id
    WHERE t.owner_driver_id = ? AND t.status = 'active'`).all(c.p);

  const spent = db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM ledger
                            WHERE entity_type = 'driver' AND entity_id = ? AND season = ?`)
    .get(c.p, last).n;

  const eur = n => '€' + Number(n || 0).toLocaleString('en-GB');
  const lines = [];
  lines.push(ran
    ? `${ran.name} — finished ${place || '–'}${place ? ordinal(place) : ''} on ${ran.pts || 0} points, ` +
      `${ran.wins || 0} win${ran.wins === 1 ? '' : 's'}, ${ran.pods || 0} podium${ran.pods === 1 ? '' : 's'}.`
    : 'You did not race last season.');
  lines.push(`Licence: ${me.fia_rating || 'none yet'}.   Capital ${eur(me.capital)}, ` +
             `passive income ${eur(me.passive_income)}.`);
  if (spent) lines.push(`The season came to ${spent < 0 ? '' : '+'}${eur(spent)} overall.`);
  for (const car of cars)
    lines.push(`${car.name} — ${car.engine_hours.toFixed(1)} engine hours, ` +
               `book value ${eur(car.value)}, worth ${eur(Math.round(car.value * 0.7))} to a dealer.`);
  lines.push('Entries close at the end of week 4. Buy a car in the Market, take a seat in the ' +
             'Office, or arrange both from Home.');

  return { headline: `Winter briefing — season ${season}`, body: lines.join('\n') };
}

const ordinal = n => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
};

// ---------------------------------------------------------------- all of it
function runWinter(db, world, namesDb, toSeason) {
  const car = db.prepare(`SELECT calendar_year, season, player_championship_id pc FROM career
                          WHERE id = 1`).get();
  const year = car.calendar_year + (toSeason - 1);
  const r = rng((toSeason * 2654435761) >>> 0);

  const out = db.transaction(() => {
    // Last season is settled before anyone ages out of it: a champion who
    // retires this winter still collects the title he won.
    const titles = awardTitles(db, toSeason - 1, toSeason);
    const aged = ageEveryone(db, r, year);
    const gone = retirements(db, r, year, toSeason);
    // The crop is what the world produces, not what the grids are missing. A
    // year where more people stop than start leaves the paddock thinner, and
    // the thin grids that follow are the point rather than a fault.
    const fresh = newTalent(db, world, r, namesDb, year, intake(db, r));
    const rated = reviewRatings(db, toSeason, year);
    depreciate(db, toSeason);
    const teams = carryTeamsForward(db, world, r, toSeason);
    serviceAiCars(db);

    // who steps up a class, decided before anyone is re-seated where they were
    const step = promote(db, world, toSeason);
    rebuildEntries(db, world, r, toSeason, car.pc, step.moving);

    // Anything still short is filled by somebody new: a championship running
    // for the first time has no history to carry, and a folded team leaves a
    // hole. Two places stay open everywhere so the player has a way in.
    const grids = lockEntries(db, world, 2, step.prefer, step.moving);

    // licences for everyone the winter has just put into a graded seat
    const graded = gradeSeats(db, toSeason, year);

    // the championships that exist for the first time this year
    const arrived = db.prepare(`SELECT name, class FROM championships WHERE active_from = ?`)
      .all(toSeason);

    const news = db.prepare(`INSERT INTO news (season,week,category,headline,body)
                             VALUES (?,1,?,?,?)`);
    if (arrived.length) {
      const cls = [...new Set(arrived.map(a => a.class.toUpperCase()))].join(' and ');
      news.run(toSeason, 'manufacturer', `${cls} arrives`,
        arrived.map(a => a.name).join('\n') +
        `\n\nRunning for the first time this season.`);
    }
    if (gone.length) {
      const named = gone.filter(g => g.why === 'age').slice(0, 6).map(g => `${g.name} (${g.age})`);
      news.run(toSeason, 'driver', `${gone.length} drivers have stopped racing`,
        (named.length ? named.join(', ') + '.\n' : '') +
        `${fresh.length} newcomers take their place.`);
    }
    const promoted = rated.filter(x => x.to === 'Gold' || x.to === 'Platinum');
    if (promoted.length)
      news.run(toSeason, 'driver', 'Licences are reviewed',
        promoted.slice(0, 8).map(x => `${x.name} — ${x.to}`).join('\n'));

    const brief = briefing(db, toSeason);
    if (brief) news.run(toSeason, 'market', brief.headline, brief.body);

    return { aged, retired: gone.length, newcomers: fresh.length, rated: rated.length,
             folded: teams.folded, grids, arrived: arrived.map(a => a.name), titles, graded };
  });
  return out();
}

// A licence is issued on stepping up, not a year afterwards. The ratings review
// works from last season's results, so a driver the winter has just put into a
// GT3 or GT4 seat has nothing to be judged on and stays ungraded for his whole
// first season there. That left most of a new GT3 field unrated and every one of
// them swept into the Bronze cup, the second best driver in the championship
// among them. Anyone holding a graded seat without a licence gets one now, on
// the same rule used when a career is first built: Silver if he is young enough
// to be worth watching, Bronze otherwise.
function gradeSeats(db, season, year) {
  const rows = db.prepare(`
    SELECT DISTINCT d.id, d.name, d.birth_year FROM entry_drivers ed
    JOIN entries e ON e.id = ed.entry_id
    JOIN championships c ON c.id = e.championship_id
    JOIN drivers d ON d.id = ed.driver_id
    WHERE e.season = ? AND c.class IN ('gt4','gt3','lmdh') AND d.fia_rating IS NULL`)
    .all(season);
  const set = db.prepare(`UPDATE drivers SET fia_rating = ? WHERE id = ?`);
  for (const d of rows) set.run(year - d.birth_year < 25 ? 'Silver' : 'Bronze', d.id);
  return rows.length;
}

// ---------------------------------------------------------------- moving up
// A class does not recruit strangers. The people who fill GT3 are the ones who
// earned it in GT4 last year, and the size of a new championship's grid is
// however many of them are ready — not a number decided in advance and then
// made true by inventing drivers to meet it.
const STEP_DOWN = { gt4: 'gt5', gt3: 'gt4', lmdh: 'gt3' };

function promote(db, world, season) {
  const prefer = {};                 // championship id -> [driver ids], best first
  const moving = new Set();
  const champs = db.prepare(`SELECT c.*, (
      SELECT MAX(cl.drivers_per_car) FROM championships c2
      JOIN championship_levels cl ON cl.id = c2.level_id
      WHERE c2.id = c.id OR c2.shares_entries_with = c.id) drivers_per_car
    FROM championships c
    WHERE c.active_from <= ? AND c.shares_entries_with IS NULL`).all(season);

  for (const c of champs) {
    const from = STEP_DOWN[c.class];
    if (!from) continue;
    const w = world.championships.find(x => x.id === c.id) || {};
    const age = season - (c.active_from || 1);
    const cars = age <= 0 ? ((w.grid_first || w.grid) || c.min_grid) : (w.grid || c.min_grid);
    const seats = cars * (c.drivers_per_car || 1);

    // Everybody who scored in the class below, in a region that feeds this
    // championship, best first. Scoring at all is the bar: a driver who never
    // troubled the points in GT4 has not earned a GT3 seat.
    const ready = db.prepare(`
      SELECT d.id, SUM(res.points) pts
      FROM results res
      JOIN legs l ON l.id = res.leg_id
      JOIN rounds r ON r.id = l.round_id
      JOIN championships low ON low.id = r.championship_id
      JOIN entry_drivers ed ON ed.entry_id = res.entry_id
      JOIN drivers d ON d.id = ed.driver_id
      WHERE r.season = @last AND low.class = @from
        AND d.status = 'active' AND d.is_player = 0
        AND d.block_id IN (SELECT block_id FROM championship_blocks
                           WHERE championship_id = @champ)
      GROUP BY d.id HAVING pts > 0
      ORDER BY pts DESC
      LIMIT @seats`).all({ last: season - 1, from, champ: c.id, seats });

    const take = ready.filter(x => !moving.has(x.id));
    if (!take.length) continue;
    prefer[c.id] = take.map(x => x.id);
    for (const x of take) moving.add(x.id);
  }
  return { prefer, moving };
}

// ---------------------------------------------------------------- the titles
// What a championship is worth at the end of it. The overall title is the one
// everybody wants; the licence cups are what a Silver or a Bronze can realistically
// win, and paying them makes the cup a goal rather than a line in a table.
const TITLE_PRIZE = { gt5: 20000, gt4: 70000, gt3: 260000, lmdh: 900000 };
const CUP_PRIZE   = { gt5: 0,     gt4: 30000, gt3: 110000, lmdh: 350000 };
const CUP_OF = { Platinum: 'Gold', Gold: 'Gold', Silver: 'Silver', Bronze: 'Bronze' };
const cupFor = rating => CUP_OF[rating] || 'Bronze';
const GRADED = new Set(['gt3', 'gt4', 'lmdh']);

// Decided on last season's results, paid and announced as the new year opens.
function awardTitles(db, lastSeason, toSeason) {
  const tierOf = cls => cls === 'gt5' ? 'gt5' : cls === 'gt4' ? 'gt4'
                      : cls === 'lmdh' ? 'lmdh' : 'gt3';
  const champs = db.prepare(`
    SELECT c.id, c.name, c.class, c.prestige FROM championships c
    WHERE EXISTS (SELECT 1 FROM rounds r WHERE r.championship_id = c.id
                  AND r.season = ? AND r.played = 1)`).all(lastSeason);

  const pay = db.prepare(`UPDATE drivers SET capital = capital + ?,
                          reputation = MIN(1.0, reputation + ?) WHERE id = ?`);
  const ledger = db.prepare(`INSERT INTO ledger (season,week,entity_type,entity_id,amount,reason)
                             VALUES (?,1,'driver',?,?,?)`);
  const news = db.prepare(`INSERT INTO news (season,week,category,headline,body)
                           VALUES (?,1,'driver',?,?)`);
  const awarded = [];

  for (const ch of champs) {
    const table = db.prepare(`
      SELECT d.id, d.name, d.is_player, d.fia_rating rating, SUM(res.points) pts,
             SUM(CASE WHEN res.finish_pos = 1 THEN 1 ELSE 0 END) wins
      FROM results res
      JOIN legs l ON l.id = res.leg_id
      JOIN rounds r ON r.id = l.round_id
      JOIN (SELECT DISTINCT r2.entry_id, lg.round_id, r2.driver_id
            FROM results r2 JOIN legs lg ON lg.id = r2.leg_id) crew
           ON crew.entry_id = res.entry_id AND crew.round_id = l.round_id
      JOIN drivers d ON d.id = crew.driver_id
      WHERE r.season = ? AND r.championship_id = ?
      GROUP BY d.id HAVING pts > 0
      ORDER BY pts DESC, wins DESC`).all(lastSeason, ch.id);
    if (!table.length) continue;

    const t = tierOf(ch.class);
    const give = (row, amount, rep, what) => {
      const money = Math.round(amount * ch.prestige / 500) * 500;
      if (money) {
        pay.run(money, rep, row.id);
        ledger.run(toSeason, row.id, money, what === 'title' ? 'title_prize' : 'cup_prize');
      } else {
        pay.run(0, rep, row.id);
      }
      awarded.push({ championship: ch.name, driver: row.name, what, money,
                     isPlayer: !!row.is_player });
      return money;
    };

    const winner = table[0];
    const money = give(winner, TITLE_PRIZE[t] || 0, 0.10, 'title');
    news.run(toSeason, `${winner.name} takes the ${ch.name}`,
      `${winner.pts} points, ${winner.wins} win${winner.wins === 1 ? '' : 's'}.` +
      (money ? `\nPrize ${money.toLocaleString('en-GB')}.` : ''));

    if (!GRADED.has(ch.class)) continue;
    const lines = [];
    for (const cup of ['Gold', 'Silver', 'Bronze']) {
      const best = table.find(x => cupFor(x.rating) === cup);
      // the overall champion does not also collect his own cup
      if (!best || best.id === winner.id) continue;
      const m = give(best, CUP_PRIZE[t] || 0, 0.06, 'cup');
      lines.push(`${cup} Cup — ${best.name}, ${best.pts} points` +
                 (m ? ` (${m.toLocaleString('en-GB')})` : ''));
    }
    if (lines.length)
      news.run(toSeason, `${ch.name} licence cups`, lines.join('\n'));
  }
  return awarded;
}

module.exports = { runWinter, briefing, awardTitles, gradeSeats, intake, promote, RETIRE_AT };
