'use strict';
const { between, irange, round3, ageUp } = require('./population');
const { pick } = require('./names');

// Share of a grid run by a proper team rather than a lone owner-driver.
const TEAM_SHARE = { gt5: 0.28, gt4: 0.75, gt3: 0.92, lmdh: 1.0 };

// The eleven permanent ARC franchises are read straight from the livery pool,
// which is already named after them.
function arcFranchises(liveries) {
  const byTeam = new Map();
  for (const l of liveries) {
    const name = l.livery_name.replace(/\s*#\S+$/, '').trim();
    if (!byTeam.has(name)) byTeam.set(name, []);
    byTeam.get(name).push(l);
  }
  return [...byTeam.entries()].map(([name, cars]) => ({ name, cars }));
}

// Most outfits run one car. A few run two, and a very few run three.
const FLEET = {
  gt5:  [0.70, 0.95, 1.00],      // 70% one car, 25% two, 5% three
  gt4:  [0.55, 0.88, 1.00],
  gt3:  [0.45, 0.82, 0.96],
  lmdh: [0.00, 0.00, 1.00]
};
const MAX_CARS = 4;

const ENGINEERING = ['amateurs', 'experienced', 'specialist'];
const GOALS = ['low_pressure', 'normal', 'normal', 'max_pressure'];

// The eleven ARC franchises are permanent, so each has a settled character:
// one is a proper operation, one is a shoestring, most sit between.
const ARC_ENG = ['specialist', 'specialist', 'experienced', 'experienced', 'experienced',
                 'experienced', 'experienced', 'amateurs', 'amateurs', 'amateurs', 'amateurs'];

function engineeringFor(cls, r) {
  if (cls === 'gt5')  return r() < 0.72 ? 'amateurs' : 'experienced';
  if (cls === 'gt4')  return r() < 0.30 ? 'amateurs' : (r() < 0.75 ? 'experienced' : 'specialist');
  return r() < 0.25 ? 'experienced' : 'specialist';
}

// The player starts with skills, a rating if the tier needs one, and nothing else.
// Buying a car or taking a paid drive is the first real decision of the career,
// and it happens in the Market or the Office, not here.
function placePlayer(db, world, ctx, profile) {
  const { r } = ctx;
  const p = db.prepare(`SELECT * FROM drivers WHERE is_player = 1`).get();
  if (!p) return null;

  const cls = profile.entry === 'gt4' ? 'gt4' : 'gt5';
  const champ = db.prepare(`
      SELECT c.* FROM championships c
      JOIN championship_blocks cb ON cb.championship_id = c.id
      WHERE cb.block_id = ? AND c.class = ? AND c.active_from = 1
      LIMIT 1`).get(p.block_id, cls)
    || db.prepare(`SELECT * FROM championships WHERE class = ? AND active_from = 1 LIMIT 1`).get(cls);
  if (!champ) return null;

  const age = 2020 - p.birth_year;
  const e = profile.experience;
  const j = (b, sp = .05) => round3(Math.min(.95, Math.max(.05, b + between(r, -sp, sp))));
  db.prepare(`INSERT INTO driver_skills
    (driver_id,race_skill,qualifying_skill,wet_skill,start_reactions,aggression,defending,
     consistency,stamina,avoidance_of_mistakes,avoidance_of_forced_mistakes,tyre_management,
     fuel_management,weather_tyre_changes,blue_flag_conceding)
    VALUES (@id,@rs,@qs,@ws,@sr,@ag,@df,@co,@st,@am,@af,@tm,@fm,@wt,@bf)`).run({
      id: p.id, rs: j(e), qs: j(e), ws: j(e - .03, .06), sr: j(e, .07),
      ag: round3(between(r, .35, .65)), df: j(e - .04, .06), co: j(e - .02),
      st: j(ageUp(r, age, { speed: e, judgement: e, stamina: .80 }).st, .04),
      am: j(e - .02), af: j(e - .02), tm: j(e - .03), fm: j(e - .03),
      wt: j(e - .04, .06), bf: round3(between(r, .40, .80))
    });

  if (cls !== 'gt5')
    db.prepare(`UPDATE drivers SET fia_rating = ? WHERE id = ?`)
      .run(age < 25 ? 'Silver' : 'Bronze', p.id);

  db.prepare(`UPDATE career SET player_championship_id = ? WHERE id = 1`).run(champ.id);

  // the seat is held open until week 4; the Market fills it
  db.prepare(`INSERT INTO news (season,week,category,headline,body)
    VALUES (1,1,'market',?,?)`).run(
      'You have no car yet',
      `A place is open in the ${champ.name} but the entry list closes at the end of week 4. ` +
      `Buy a car in the Market, or look for a paid drive in the Office.`);

  return { championship: champ.id, seat: 'reserved' };
}

function buildEntries(db, world, ctx, profile) {
  const { pool, nf, tf, r } = ctx;
  const YEAR = 2020;

  const ins = {
    team:    db.prepare(`INSERT INTO teams
       (name,country,block_id,founded_season,is_privateer,owner_driver_id,capital,engineering,goals)
       VALUES (@name,@country,@block,1,@priv,@owner,@capital,@eng,@goals)`),
    chassis: db.prepare(`INSERT INTO chassis (model_id,owner_team_id,bought_season,bought_new,value)
       VALUES (?,?,1,1,?)`),
    entry:   db.prepare(`INSERT INTO entries
       (season,championship_id,team_id,chassis_id,livery_id,class_cup,works_support)
       VALUES (1,@champ,@team,@chassis,@livery,@cup,@works)`),
    seat:    db.prepare(`INSERT INTO entry_drivers (entry_id,driver_id,role,seat_fee)
       VALUES (?,?,?,?)`),
    rating:  db.prepare(`UPDATE drivers SET fia_rating = ? WHERE id = ?`),
    perf:    db.prepare(`INSERT INTO car_performance
       (model_id,season,weight_scalar,power_scalar,drag_scalar) VALUES (?,1,?,?,?)`)
  };

  // season-one scalars are the measured baselines, untouched
  for (const m of db.prepare(`SELECT * FROM car_models`).all())
    ins.perf.run(m.id, m.base_weight_scalar, m.base_power_scalar, m.base_drag_scalar);

  const modelRow = Object.fromEntries(
    db.prepare(`SELECT id,name,class,price_new FROM car_models`).all().map(m => [m.name, m]));
  const liveriesFor = id =>
    db.prepare(`SELECT id,livery_name,sponsor_level FROM liveries WHERE model_id = ? ORDER BY id`).all(id);

  const feeds = {};
  for (const row of db.prepare(`SELECT * FROM championship_blocks`).all())
    (feeds[row.championship_id] ||= []).push(row.block_id);

  const taken = new Set();                       // driver ids already seated
  const stats = { teams: 0, privateers: 0, entries: 0, seats: 0 };

  // Drivers are drawn strongest-first from the blocks that feed the championship,
  // so the higher the tier the better the field.
  const form = d => d.sk.race_skill + d.sk.consistency;

  function draw(champId, n, cls) {
    const src = (feeds[champId] || []).flatMap(b => pool[b] || []);
    const free = src.filter(d => !taken.has(d.id));
    let out;
    if (cls === 'gt5') {
      out = free.sort((a, b) => form(b) - form(a)).slice(0, n);
    } else {
      // above GT5 a grid is part seasoned money, part young talent on the way up
      const young = free.filter(d => d.age <= 25)
                        .sort((a, b) => (b.pot.speed + b.sk.race_skill) - (a.pot.speed + a.sk.race_skill));
      const rest  = free.filter(d => d.age > 25).sort((a, b) => form(b) - form(a));
      const nYoung = Math.round(n * 0.40);
      out = young.slice(0, nYoung).concat(rest.slice(0, n - Math.min(nYoung, young.length)));
    }
    for (const d of out) taken.add(d.id);
    return out;
  }

  const champs = world.championships
    .filter(c => c.active_from === 1 && !c.shares_entries_with);

  // GT4 first: it should take the best of each continent before GT5 fills up.
  champs.sort((a, b) => (a.cls === 'gt4' ? -1 : 1) - (b.cls === 'gt4' ? -1 : 1));

  const playerCls = profile && profile.entry === 'gt4' ? 'gt4' : 'gt5';
  const playerBlock = profile ? profile.block : null;
  const playerChamp = playerBlock ? db.prepare(`
      SELECT c.id FROM championships c JOIN championship_blocks cb ON cb.championship_id = c.id
      WHERE cb.block_id = ? AND c.class = ? AND c.active_from = 1 LIMIT 1`)
      .get(playerBlock, playerCls) : null;

  for (const c of champs) {
    // two places are held in the player's championship: one for them, one for a
    // second car if they ever run a team
    const grid = c.grid_first - (playerChamp && playerChamp.id === c.id ? 2 : 0);
    const perCar = c.drivers_per_car;
    const dbChamp = db.prepare(`SELECT * FROM championships WHERE id = ?`).get(c.id);

    // which models are eligible, and their livery pools
    const models = c.model
      ? [modelRow[c.model]]
      : db.prepare(`SELECT id,name,class,price_new FROM car_models
                    WHERE class IN (${c.cls === 'gt4' ? "'gt4'" : "'gt3_gen1','gt3_gen2','gto'"})
                      AND purchasable = 1`).all();
    const pools = Object.fromEntries(models.map(m => [m.id, liveriesFor(m.id)]));



    const isArc = c.id === 'australasian_arc';

    // In the player's own championship, hold one plain number back per model so
    // there is always something to buy in the Market. Franchise series are
    // exempt: their cars belong to the teams and are never sold.
    if (playerChamp && playerChamp.id === c.id && !isArc) {
      for (const m of models) {
        const pl = pools[m.id];
        for (let k = 0; k < 2; k++) {
          const i = pl.findIndex(x => x.sponsor_level === 'low');
          if (i >= 0) pl.splice(i, 1); else if (pl.length) pl.pop();
        }
      }
    }

    const franchises = isArc ? arcFranchises(pools[models[0].id]) : null;

    const drivers = draw(c.id, grid * perCar, c.cls);
    let di = 0;
    const fleets = [];            // teams already created for this championship

    for (let i = 0; i < grid; i++) {
      if (di >= drivers.length) break;
      const crew = drivers.slice(di, di + perCar);
      if (crew.length < perCar) break;
      di += perCar;

      const lead = crew[0];
      const model = models.length === 1 ? models[0] : pick(r, models);

      // livery: privateers get the plainest cars first
      const teamRun = isArc ? true : r() < TEAM_SHARE[c.cls];
      const wanted = teamRun ? ['high', 'medium', 'low'] : ['low', 'medium', 'high'];
      let lv = null;
      if (isArc) {
        const f = franchises[i % franchises.length];
        lv = f.cars.shift();
      } else {
        for (const level of wanted) {
          const idx = pools[model.id].findIndex(x => x.sponsor_level === level);
          if (idx >= 0) { lv = pools[model.id].splice(idx, 1)[0]; break; }
        }
      }
      if (!lv) break;                              // pool exhausted

      const eng = isArc ? ARC_ENG[(i % franchises.length) % ARC_ENG.length]
                        : (teamRun ? engineeringFor(c.cls, r) : 'amateurs');

      // an existing team may add this car to its fleet rather than a new outfit
      let teamId = null, reused = null;
      if (isArc) {
        // the eleven franchises are one team apiece, running two cars
        const f = franchises[i % franchises.length];
        if (f.teamId) teamId = f.teamId;
      } else if (teamRun) {
        const roll = r();
        const wants = FLEET[c.cls][0] > roll ? 1 : (FLEET[c.cls][1] > roll ? 2 : 3);
        reused = fleets.find(f => f.cars < Math.min(f.wants, MAX_CARS));
        if (reused) { teamId = reused.id; reused.cars++; }
        else if (wants > 1) { /* a new team that intends to grow */ }
      }

      if (!teamId) {
        const teamName = isArc
          ? franchises[i % franchises.length].name
          : (teamRun ? tf.make(lead.name) : `${lead.name.split(' ').pop()} (privateer)`);
        teamId = ins.team.run({
          name: teamName, country: lead.code, block: lead.block,
          priv: teamRun ? 0 : 1, owner: teamRun ? null : lead.id,
          capital: Math.round(between(r, teamRun ? 180000 : 90000, teamRun ? 1400000 : 420000) / 1000) * 1000,
          eng, goals: pick(r, GOALS)
        }).lastInsertRowid;
        teamRun ? stats.teams++ : stats.privateers++;
        if (isArc) franchises[i % franchises.length].teamId = teamId;
        if (teamRun && !isArc) {
          const roll = r();
          const wants = FLEET[c.cls][0] > roll ? 1 : (FLEET[c.cls][1] > roll ? 2 : 3);
          if (wants > 1) fleets.push({ id: teamId, cars: 1, wants });
        }
      }

      const value = model.price_new ? Math.round(model.price_new * 0.8) : 0;
      const chassisId = ins.chassis.run(model.id, teamId, value).lastInsertRowid;
      // franchise cars are kept year after year and drift apart a little
      if (isArc)
        db.prepare(`UPDATE chassis SET dev_bonus = ? WHERE id = ?`)
          .run(round3(between(r, -0.10, 0.10)), chassisId);

      const entryId = ins.entry.run({
        champ: c.id, team: teamId, chassis: chassisId, livery: lv.id,
        cup: null, works: (teamRun && eng === 'specialist' && r() < 0.35) ? 1 : 0
      }).lastInsertRowid;
      stats.entries++;

      crew.forEach((d, role) => {
        // FIA rating is handed out when a driver first appears in GT4 or above
        if (c.cls !== 'gt5' && !d.rating) {
          d.rating = d.age < 25 ? 'Silver' : 'Bronze';
          ins.rating.run(d.rating, d.id);
        }
        const fee = c.cls === 'gt5' ? irange(r, 15000, 22000)
                  : c.cls === 'gt4' ? irange(r, 22000, 32000)
                                    : irange(r, 45000, 92000);
        ins.seat.run(entryId, d.id, role + 1, teamRun ? fee : 0);
        stats.seats++;
      });
    }
  }
  return stats;
}

module.exports = { buildEntries, placePlayer };
