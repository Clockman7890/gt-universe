'use strict';
const fs = require('fs');
const path = require('path');

// The tier the player belongs to this season, and the seat being held for them.
function context(db) {
  const p = db.prepare(`SELECT * FROM drivers WHERE is_player = 1`).get();
  if (!p) return null;
  const season = db.prepare(`SELECT season, week FROM career WHERE id = 1`).get();

  // a seat already taken this season, if any
  const seat = db.prepare(`
    SELECT e.id entry_id, e.championship_id, e.livery_id, ch.id chassis_id, ch.model_id,
           t.id team_id, t.is_privateer
    FROM entry_drivers ed
    JOIN entries e ON e.id = ed.entry_id
    JOIN chassis ch ON ch.id = e.chassis_id
    JOIN teams t ON t.id = e.team_id
    WHERE ed.driver_id = ? AND e.season = ?`).get(p.id, season.season);

  // otherwise the championship their block feeds
  const target = db.prepare(`SELECT player_championship_id FROM career WHERE id = 1`).get();
  const champ = seat
    ? db.prepare(`SELECT * FROM championships WHERE id = ?`).get(seat.championship_id)
    : (target && target.player_championship_id
        ? db.prepare(`SELECT * FROM championships WHERE id = ?`).get(target.player_championship_id)
        : null);

  const team = db.prepare(`SELECT * FROM teams WHERE owner_driver_id = ?
      AND is_privateer = 0 AND status = 'active'`).get(p.id);

  return { player: p, season, seat, champ, team };
}

// Everything on sale, with the liveries still free in that championship.
function list(db) {
  const ctx = context(db);
  if (!ctx || !ctx.champ) return { models: [], open: false };
  const { player, season, champ, seat } = ctx;

  const FRANCHISE = new Set(['australasian_arc']);
  if (FRANCHISE.has(champ.id))
    return { models: [], championship: champ.name, open: season.week <= 4, week: season.week,
             capital: player.capital, hasCar: false, hasSeat: !!seat,
             note: 'Cars in this series belong to the teams. Look for a seat in the Office.' };

  const eligible = champ.model_id
    ? [champ.model_id]
    : db.prepare(`SELECT id FROM car_models WHERE class IN (${
        champ.class === 'gt4' ? "'gt4'" : "'gt3_gen1','gt3_gen2','gto'"
      }) AND purchasable = 1`).all().map(r => r.id);

  const rows = db.prepare(`
    SELECT cm.*, m.name manufacturer FROM car_models cm
    JOIN manufacturers m ON m.id = cm.manufacturer_id
    WHERE cm.purchasable = 1 ORDER BY cm.price_new DESC`).all();

  // A privateer runs a modest livery by preference, but if every modest number
  // in the series is taken he takes whatever is left rather than being told to
  // go home. Running under a works livery is a smaller oddity than a career
  // that cannot continue.
  const freeLiveries = db.prepare(`
    SELECT l.id, l.livery_name, l.sponsor_level FROM liveries l
    WHERE l.model_id = ?
      AND l.id NOT IN (SELECT livery_id FROM entries WHERE season = ? AND championship_id = ?)
    ORDER BY CASE l.sponsor_level WHEN 'high' THEN 2 ELSE 0 END, l.id`);

  const models = rows.map(m => {
    const ok = eligible.includes(m.id);
    const liveries = ok ? freeLiveries.all(m.id, season.season, champ.id) : [];
    let why = null;
    if (!ok) why = `Not eligible in the ${champ.name}`;
    else if (!liveries.length) why = 'No free entry number left';
    else if (m.price_new > player.capital) why = 'Not enough capital';
    return {
      id: m.id, name: m.name, manufacturer: m.manufacturer, cls: m.class,
      price: m.price_new, power: null, image: m.name,
      affordable: ok && liveries.length > 0 && m.price_new <= player.capital,
      why, liveries
    };
  });

  // second-hand stock only appears once cars have been raced and sold on
  const used = db.prepare(`SELECT COUNT(*) n FROM chassis WHERE for_sale = 1`).get().n;

  return {
    models,
    used,
    usedNote: used ? null
      : (season.season === 1
          ? 'Nobody has a car to sell yet. Every chassis on the grid was bought new this winter, '
            + 'so the second-hand market opens from season two onwards.'
          : 'No cars are listed for sale at the moment. Teams usually sell in the winter, '
            + 'after the season has decided who is moving up and who is folding.'),
    championship: champ.name,
    open: ctx.season.week <= 4,
    week: season.week,
    capital: player.capital,
    hasCar: !!(seat && seat.is_privateer),
    hasSeat: !!seat,
    team: ctx.team ? ctx.team.name : null,
    // a team may keep buying; a lone driver stops at one seat
    canBuy: !seat || !!ctx.team
  };
}

// Buying a car is also entering the championship: team, chassis, entry, seat.
function buy(db, modelId, liveryId) {
  const ctx = context(db);
  if (!ctx || !ctx.champ) throw new Error('No championship to enter.');
  if (ctx.season.week > 4) throw new Error('The entry list for this season has closed.');
  if (ctx.seat && !ctx.team)
    throw new Error('You already have a seat this season.');

  const p = ctx.player, champ = ctx.champ;
  const m = db.prepare(`SELECT * FROM car_models WHERE id = ? AND purchasable = 1`).get(modelId);
  if (!m) throw new Error('That car is not for sale.');
  if (m.price_new > p.capital) throw new Error('You cannot afford that car.');

  const lv = db.prepare(`
    SELECT * FROM liveries WHERE id = ? AND model_id = ?
      AND id NOT IN (SELECT livery_id FROM entries WHERE season = ? AND championship_id = ?)`)
    .get(liveryId, modelId, ctx.season.season, champ.id);
  if (!lv) throw new Error('That entry number has just been taken.');

  return db.transaction(() => {
    // a car for an existing team. The owner climbs into the first one themselves;
    // anything after that needs a driver signing in the Office.
    if (ctx.team) {
      const chassisId = db.prepare(`INSERT INTO chassis
          (model_id,owner_team_id,bought_season,bought_new,value) VALUES (?,?,?,1,?)`)
        .run(m.id, ctx.team.id, ctx.season.season, Math.round(m.price_new * 0.8)).lastInsertRowid;
      const entryId = db.prepare(`INSERT INTO entries
          (season,championship_id,team_id,chassis_id,livery_id,class_cup,works_support)
          VALUES (?,?,?,?,?,NULL,0)`)
        .run(ctx.season.season, champ.id, ctx.team.id, chassisId, lv.id).lastInsertRowid;
      db.prepare(`UPDATE drivers SET capital = capital - ? WHERE id = ?`).run(m.price_new, p.id);
      db.prepare(`INSERT INTO ledger (season,week,entity_type,entity_id,amount,reason)
          VALUES (?,?,'driver',?,?, 'car_purchase')`)
        .run(ctx.season.season, ctx.season.week, p.id, -m.price_new);
      const takesIt = !ctx.seat;
      if (takesIt)
        db.prepare(`INSERT INTO entry_drivers (entry_id,driver_id,role,seat_fee) VALUES (?,?,1,0)`)
          .run(entryId, p.id);

      db.prepare(`UPDATE news SET read = 1 WHERE headline = 'You have no car yet'`).run();
      db.prepare(`INSERT INTO news (season,week,category,headline,body) VALUES (?,?,'team',?,?)`)
        .run(ctx.season.season, ctx.season.week,
             takesIt ? `${ctx.team.name} enters the ${champ.name}`
                     : `${ctx.team.name} enters another car`,
             `${m.name} as ${lv.livery_name}.` + (takesIt ? '' : ' Needs a driver.'));
      return { model: m.name, livery: lv.livery_name, championship: champ.name,
               spent: m.price_new, capital: p.capital - m.price_new, needsDriver: !takesIt };
    }

    const teamId = db.prepare(`INSERT INTO teams
        (name,country,block_id,founded_season,is_privateer,owner_driver_id,capital,engineering,goals)
        VALUES (?,?,?,?,1,?,?, 'amateurs','normal')`)
      .run(`${p.name.split(' ').pop()} (privateer)`, p.country, p.block_id,
           ctx.season.season, p.id, 0).lastInsertRowid;

    const chassisId = db.prepare(`INSERT INTO chassis
        (model_id,owner_team_id,bought_season,bought_new,value)
        VALUES (?,?,?,1,?)`)
      .run(m.id, teamId, ctx.season.season, Math.round(m.price_new * 0.8)).lastInsertRowid;

    const entryId = db.prepare(`INSERT INTO entries
        (season,championship_id,team_id,chassis_id,livery_id,class_cup,works_support)
        VALUES (?,?,?,?,?,NULL,0)`)
      .run(ctx.season.season, champ.id, teamId, chassisId, lv.id).lastInsertRowid;

    db.prepare(`INSERT INTO entry_drivers (entry_id,driver_id,role,seat_fee) VALUES (?,?,1,0)`)
      .run(entryId, p.id);

    db.prepare(`UPDATE drivers SET capital = capital - ? WHERE id = ?`).run(m.price_new, p.id);
    db.prepare(`INSERT INTO ledger (season,week,entity_type,entity_id,amount,reason)
        VALUES (?,?,'driver',?,?, 'car_purchase')`)
      .run(ctx.season.season, ctx.season.week, p.id, -m.price_new);

    db.prepare(`UPDATE news SET read = 1 WHERE headline = 'You have no car yet'`).run();
    db.prepare(`INSERT INTO news (season,week,category,headline,body) VALUES (?,?,'market',?,?)`)
      .run(ctx.season.season, ctx.season.week, `You have entered the ${champ.name}`,
           `${m.name}, running as ${lv.livery_name}.`);

    return { model: m.name, livery: lv.livery_name, championship: champ.name,
             spent: m.price_new, capital: p.capital - m.price_new };
  })();
}

// ---------------------------------------------------------------- the garage
// An engine is good for thirty hours. The last third of that life costs
// reliability, and past it the thing is running on borrowed time. A rebuild
// puts it back to nothing, at a price that scales with the class.
const ENGINE_LIFE = 30;
const REBUILD = { gt5: 9000, gt4: 26000, gt3_gen1: 48000, gt3_gen2: 72000,
                  gto: 34000, lmdh: 140000 };

// Fraction of the car's reliability left, given the hours on the engine.
function engineHealth(hours) {
  const used = Math.max(0, hours) / ENGINE_LIFE;
  if (used <= 0.65) return 1;
  if (used <= 1) return 1 - (used - 0.65) * 0.34;      // down to about 0.88
  return Math.max(0.55, 0.88 - (used - 1) * 0.6);      // past its life, badly
}

function rebuildQuote(db, chassisId) {
  const row = db.prepare(`
    SELECT ch.id, ch.engine_hours, ch.value, cm.class, cm.name model,
           t.owner_driver_id
    FROM chassis ch JOIN car_models cm ON cm.id = ch.model_id
    JOIN teams t ON t.id = ch.owner_team_id
    WHERE ch.id = ?`).get(chassisId);
  if (!row) return null;
  const full = REBUILD[row.class] || 30000;
  // a barely used engine costs less to freshen than a worn one
  const share = Math.min(1, row.engine_hours / ENGINE_LIFE);
  const cost = Math.max(Math.round(full * 0.25 / 100) * 100,
                        Math.round(full * share / 100) * 100);
  return { chassisId: row.id, model: row.model, hours: row.engine_hours,
           cost, health: engineHealth(row.engine_hours), life: ENGINE_LIFE,
           mine: !!row.owner_driver_id };
}

function rebuildEngine(db, chassisId) {
  const c = db.prepare(`SELECT season, week, player_driver_id FROM career WHERE id = 1`).get();
  const q = rebuildQuote(db, chassisId);
  if (!q) throw new Error('No such car.');
  const own = db.prepare(`
    SELECT 1 FROM chassis ch JOIN teams t ON t.id = ch.owner_team_id
    WHERE ch.id = ? AND t.owner_driver_id = ?`).get(chassisId, c.player_driver_id);
  if (!own) throw new Error('That car is not yours to work on.');
  const me = db.prepare(`SELECT capital FROM drivers WHERE id = ?`).get(c.player_driver_id);
  if (me.capital < q.cost) throw new Error('You cannot afford the rebuild.');

  return db.transaction(() => {
    db.prepare(`UPDATE chassis SET engine_hours = 0 WHERE id = ?`).run(chassisId);
    db.prepare(`UPDATE drivers SET capital = capital - ? WHERE id = ?`)
      .run(q.cost, c.player_driver_id);
    db.prepare(`INSERT INTO ledger (season,week,entity_type,entity_id,amount,reason)
                VALUES (?,?,'driver',?,?, 'engine_rebuild')`)
      .run(c.season, c.week, c.player_driver_id, -q.cost);
    return { model: q.model, cost: q.cost, capital: me.capital - q.cost };
  })();
}

// ---------------------------------------------------------------- selling
// A dealer takes a car at seven tenths of its book value. A car in a race
// entry cannot be sold out from under the entry.
function sellQuote(db, chassisId) {
  const row = db.prepare(`
    SELECT ch.id, ch.value, ch.engine_hours, cm.name model, cm.class,
           (SELECT COUNT(*) FROM entries e
            WHERE e.chassis_id = ch.id
              AND e.season = (SELECT season FROM career WHERE id = 1)) entered
    FROM chassis ch JOIN car_models cm ON cm.id = ch.model_id
    JOIN teams t ON t.id = ch.owner_team_id
    WHERE ch.id = ? AND t.owner_driver_id = (SELECT player_driver_id FROM career WHERE id = 1)`)
    .get(chassisId);
  if (!row) return null;
  // a tired engine is the buyer's problem, and priced accordingly
  const wear = 1 - (1 - engineHealth(row.engine_hours)) * 0.8;
  return { chassisId: row.id, model: row.model,
           offer: Math.round(row.value * 0.7 * wear / 100) * 100,
           value: row.value, entered: !!row.entered };
}

function sellCar(db, chassisId) {
  const c = db.prepare(`SELECT season, week, player_driver_id FROM career WHERE id = 1`).get();
  const q = sellQuote(db, chassisId);
  if (!q) throw new Error('That car is not yours to sell.');
  if (q.entered) throw new Error('That car is entered this season. Withdraw it first.');

  return db.transaction(() => {
    const team = db.prepare(`SELECT owner_team_id t FROM chassis WHERE id = ?`).get(chassisId).t;
    // The row stays: results and old entry lists point at it, and a season's
    // history should not change because a car was sold afterwards. Handing it
    // to nobody is what takes it out of the world.
    db.prepare(`UPDATE chassis SET owner_team_id = NULL, for_sale = 0,
                asking_price = NULL, dev_bonus = 0 WHERE id = ?`).run(chassisId);
    db.prepare(`UPDATE drivers SET capital = capital + ? WHERE id = ?`)
      .run(q.offer, c.player_driver_id);
    db.prepare(`INSERT INTO ledger (season,week,entity_type,entity_id,amount,reason)
                VALUES (?,?,'driver',?,?, 'car_sale')`)
      .run(c.season, c.week, c.player_driver_id, q.offer);
    db.prepare(`INSERT INTO news (season,week,category,headline,body) VALUES (?,?,'market',?,?)`)
      .run(c.season, c.week, `You have sold the ${q.model}`, `A dealer took it.`);
    const left = db.prepare(`SELECT COUNT(*) n FROM chassis WHERE owner_team_id = ?`)
      .get(team).n;
    return { model: q.model, offer: q.offer, carsLeft: left };
  })();
}

// ---------------------------------------------------------------- second hand
// What is actually on the second-hand market, and whether the player could
// enter it in the championship they are aiming at.
function usedList(db) {
  const ctx = context(db);
  if (!ctx) return { cars: [], note: null };
  const { player, season, champ } = ctx;

  const rows = db.prepare(`
    SELECT ch.id, ch.value, ch.asking_price, ch.engine_hours, ch.chassis_hours,
           ch.bought_season, cm.id model_id, cm.name model, cm.class,
           m.name manufacturer, t.name seller
    FROM chassis ch
    JOIN car_models cm ON cm.id = ch.model_id
    JOIN manufacturers m ON m.id = cm.manufacturer_id
    LEFT JOIN teams t ON t.id = ch.owner_team_id
    WHERE ch.for_sale = 1
      AND (t.owner_driver_id IS NULL OR t.owner_driver_id <> @me)
    ORDER BY ch.value DESC`).all({ me: player.id });

  const eligible = champ && champ.model_id
    ? [champ.model_id]
    : champ ? db.prepare(`SELECT id FROM car_models WHERE class IN (${
        champ.class === 'gt4' ? "'gt4'" : "'gt3_gen1','gt3_gen2','gto'"
      })`).all().map(r => r.id) : [];

  const freeLiveries = db.prepare(`
    SELECT l.id, l.livery_name, l.sponsor_level FROM liveries l
    WHERE l.model_id = ?
      AND l.id NOT IN (SELECT livery_id FROM entries WHERE season = ? AND championship_id = ?)
    ORDER BY CASE l.sponsor_level WHEN 'high' THEN 2 ELSE 0 END, l.id`);

  const cars = rows.map(r => {
    const price = r.asking_price || Math.round(r.value * 1.0);
    const ok = champ ? eligible.includes(r.model_id) : false;
    const liveries = ok ? freeLiveries.all(r.model_id, season.season, champ.id) : [];
    let why = null;
    if (!champ) why = 'No championship chosen yet';
    else if (!ok) why = `Not eligible in the ${champ.name}`;
    else if (!liveries.length) why = 'No free entry number left';
    else if (price > player.capital) why = 'Not enough capital';
    return {
      chassisId: r.id, model: r.model, manufacturer: r.manufacturer, cls: r.class,
      price, hours: r.engine_hours, health: engineHealth(r.engine_hours),
      age: season.season - r.bought_season, seller: r.seller,
      affordable: ok && liveries.length > 0 && price <= player.capital,
      why, liveries
    };
  });

  return {
    cars,
    championship: champ ? champ.name : null,
    open: season.week <= 4,
    capital: player.capital,
    note: cars.length ? null
      : (season.season === 1
          ? 'Nobody has a car to sell yet. Every chassis on the grid was bought new this '
            + 'winter, so the second-hand market opens from season two onwards.'
          : 'No cars are listed at the moment. Teams sell in the winter, once the season '
            + 'has decided who is moving up and who is folding.')
  };
}

function buyUsed(db, chassisId, liveryId) {
  const ctx = context(db);
  if (!ctx || !ctx.champ) throw new Error('No championship to enter.');
  if (ctx.season.week > 4) throw new Error('The entry list for this season has closed.');
  if (ctx.seat && !ctx.team) throw new Error('You already have a seat this season.');

  const p = ctx.player, champ = ctx.champ;
  const car = db.prepare(`SELECT ch.*, cm.name model, cm.id model_id FROM chassis ch
    JOIN car_models cm ON cm.id = ch.model_id
    WHERE ch.id = ? AND ch.for_sale = 1`).get(chassisId);
  if (!car) throw new Error('That car has just been sold.');
  const price = car.asking_price || car.value;
  if (price > p.capital) throw new Error('You cannot afford that car.');

  const lv = db.prepare(`
    SELECT * FROM liveries WHERE id = ? AND model_id = ?
      AND id NOT IN (SELECT livery_id FROM entries WHERE season = ? AND championship_id = ?)`)
    .get(liveryId, car.model_id, ctx.season.season, champ.id);
  if (!lv) throw new Error('That entry number has just been taken.');

  return db.transaction(() => {
    let teamId = ctx.team ? ctx.team.id : null;
    if (!teamId) {
      const priv = db.prepare(`SELECT id FROM teams WHERE owner_driver_id = ?
          AND is_privateer = 1 AND status = 'active'`).get(p.id);
      teamId = priv ? priv.id : db.prepare(`INSERT INTO teams
          (name,country,block_id,founded_season,is_privateer,owner_driver_id,capital,
           engineering,facilities,goals)
          VALUES (?,?,?,?,1,?,0,'amateurs','gt5','normal')`)
        .run(`${p.name.split(' ').pop()} (privateer)`, p.country, p.block_id,
             ctx.season.season, p.id).lastInsertRowid;
    }

    db.prepare(`UPDATE chassis SET owner_team_id = ?, for_sale = 0, asking_price = NULL
                WHERE id = ?`).run(teamId, chassisId);
    const entryId = db.prepare(`INSERT INTO entries
        (season,championship_id,team_id,chassis_id,livery_id,class_cup,works_support)
        VALUES (?,?,?,?,?,NULL,0)`)
      .run(ctx.season.season, champ.id, teamId, chassisId, lv.id).lastInsertRowid;
    if (!ctx.seat)
      db.prepare(`INSERT INTO entry_drivers (entry_id,driver_id,role,seat_fee) VALUES (?,?,1,0)`)
        .run(entryId, p.id);

    db.prepare(`UPDATE drivers SET capital = capital - ? WHERE id = ?`).run(price, p.id);
    db.prepare(`INSERT INTO ledger (season,week,entity_type,entity_id,amount,reason)
                VALUES (?,?,'driver',?,?, 'car_purchase_used')`)
      .run(ctx.season.season, ctx.season.week, p.id, -price);
    db.prepare(`UPDATE news SET read = 1 WHERE headline = 'You have no car yet'`).run();
    db.prepare(`INSERT INTO news (season,week,category,headline,body) VALUES (?,?,'market',?,?)`)
      .run(ctx.season.season, ctx.season.week,
           `You have bought a used ${car.model}`,
           `${car.engine_hours.toFixed(1)} hours on the engine. Running as ${lv.livery_name}.`);
    return { model: car.model, livery: lv.livery_name, spent: price,
             hours: car.engine_hours, capital: p.capital - price,
             needsDriver: !!ctx.seat };
  })();
}

// ---------------------------------------------------------- a car you own
// A chassis in the garage is not automatically on next year's grid: the entry
// lists are rebuilt every winter and the player's own cars are deliberately
// left out of that, so their owner can decide what to do with them. This is
// how they decide to race it again. Without it a car bought in season one
// became an ornament — the only ways onto a grid were buying another car or
// buying a seat, and a driver who had spent his money on the car he already
// owned could do neither.
function ownedCars(db) {
  const ctx = context(db);
  if (!ctx) return { cars: [], championship: null, open: false };
  const { player, season, champ, seat } = ctx;

  const mine = db.prepare(`
    SELECT ch.id, ch.value, ch.engine_hours, cm.id model_id, cm.name model, cm.class,
           t.id team_id, t.name team, t.is_privateer,
           (SELECT COUNT(*) FROM entries e WHERE e.chassis_id = ch.id
             AND e.season = @season) entered
    FROM chassis ch
    JOIN car_models cm ON cm.id = ch.model_id
    JOIN teams t ON t.id = ch.owner_team_id
    WHERE t.owner_driver_id = @me AND t.status = 'active'`)
    .all({ me: player.id, season: season.season });

  const eligible = champ && champ.model_id
    ? [champ.model_id]
    : champ ? db.prepare(`SELECT id FROM car_models WHERE class IN (${
        champ.class === 'gt4' ? "'gt4'" : "'gt3_gen1','gt3_gen2','gto'"
      })`).all().map(r => r.id) : [];

  const freeLiveries = db.prepare(`
    SELECT l.id, l.livery_name FROM liveries l
    WHERE l.model_id = ?
      AND l.id NOT IN (SELECT livery_id FROM entries WHERE season = ? AND championship_id = ?)
    ORDER BY l.id`);

  const cars = mine.map(c => {
    const fits = champ ? eligible.includes(c.model_id) : false;
    const liveries = fits && !c.entered ? freeLiveries.all(c.model_id, season.season, champ.id) : [];
    let why = null;
    if (c.entered) why = 'Already entered this season';
    else if (!champ) why = 'No championship chosen yet';
    else if (!fits) why = `Not eligible in the ${champ.name}`;
    else if (!liveries.length) why = 'No free entry number left';
    else if (seat && !ctx.team) why = 'You already have a drive this season';
    return { chassisId: c.id, model: c.model, cls: c.class, team: c.team,
             hours: c.engine_hours, value: c.value,
             canEnter: !why, why, liveries };
  });

  return { cars, championship: champ ? champ.name : null,
           open: season.week <= 4, hasSeat: !!seat };
}

function enterOwned(db, chassisId, liveryId) {
  const ctx = context(db);
  if (!ctx || !ctx.champ) throw new Error('Choose a championship first.');
  if (ctx.season.week > 4) throw new Error('The entry list for this season has closed.');
  const p = ctx.player, champ = ctx.champ;

  const car = db.prepare(`
    SELECT ch.*, cm.name model, cm.id model_id, cm.class, t.id team_id
    FROM chassis ch JOIN car_models cm ON cm.id = ch.model_id
    JOIN teams t ON t.id = ch.owner_team_id
    WHERE ch.id = ? AND t.owner_driver_id = ? AND t.status = 'active'`)
    .get(chassisId, p.id);
  if (!car) throw new Error('That car is not yours.');
  if (db.prepare(`SELECT 1 FROM entries WHERE chassis_id = ? AND season = ?`)
        .get(chassisId, ctx.season.season))
    throw new Error('That car is already entered this season.');

  const ok = champ.model_id ? champ.model_id === car.model_id
    : (champ.class === 'gt4' ? car.class === 'gt4'
       : ['gt3_gen1','gt3_gen2','gto'].includes(car.class));
  if (!ok) throw new Error(`A ${car.model} is not eligible in the ${champ.name}.`);

  const lv = db.prepare(`
    SELECT * FROM liveries WHERE id = ? AND model_id = ?
      AND id NOT IN (SELECT livery_id FROM entries WHERE season = ? AND championship_id = ?)`)
    .get(liveryId, car.model_id, ctx.season.season, champ.id);
  if (!lv) throw new Error('That entry number has just been taken.');

  return db.transaction(() => {
    const entryId = db.prepare(`INSERT INTO entries
        (season,championship_id,team_id,chassis_id,livery_id,class_cup,works_support)
        VALUES (?,?,?,?,?,NULL,0)`)
      .run(ctx.season.season, champ.id, car.team_id, chassisId, lv.id).lastInsertRowid;

    // the owner takes the wheel unless he has already signed for somebody else
    if (!ctx.seat)
      db.prepare(`INSERT INTO entry_drivers (entry_id,driver_id,role,seat_fee) VALUES (?,?,1,0)`)
        .run(entryId, p.id);

    db.prepare(`UPDATE news SET read = 1 WHERE headline = 'You have no car yet'`).run();
    db.prepare(`INSERT INTO news (season,week,category,headline,body) VALUES (?,?,'market',?,?)`)
      .run(ctx.season.season, ctx.season.week,
           `Your ${car.model} is entered in the ${champ.name}`,
           `Running as ${lv.livery_name}. ${car.engine_hours.toFixed(1)} hours on the engine.`);
    return { model: car.model, livery: lv.livery_name, championship: champ.name,
             needsDriver: !!ctx.seat };
  })();
}

// One image at a time, as a data URL, so the renderer needs no file access.
function image(resourcesDir, modelName, specs) {
  const s = specs.find(x => x.model === modelName);
  if (!s) return null;
  const f = path.join(resourcesDir, 'car_images', s.image);
  try {
    return 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
  } catch (_) { return null; }
}

// Buy a run of cars in one go. Privateers are held to a single entry.
function buyMany(db, modelId, liveryIds) {
  const ctx = context(db);
  if (!ctx) throw new Error('No career open.');
  if (!Array.isArray(liveryIds) || !liveryIds.length) throw new Error('Pick an entry number.');
  if (!ctx.team && liveryIds.length > 1)
    throw new Error('A privateer runs one car. Found a team first if you want more.');
  const out = [];
  for (const lv of liveryIds) out.push(buy(db, modelId, lv));
  return { cars: out.length, model: out[0].model,
           liveries: out.map(o => o.livery), spent: out.reduce((n, o) => n + o.spent, 0),
           capital: out[out.length - 1].capital, championship: out[0].championship };
}

module.exports = { list, buy, buyMany, image, context, ownedCars, enterOwned,
                   usedList, buyUsed, sellQuote, sellCar,
                   rebuildQuote, rebuildEngine, engineHealth, ENGINE_LIFE };
