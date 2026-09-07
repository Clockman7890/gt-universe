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

  const freeLiveries = db.prepare(`
    SELECT l.id, l.livery_name, l.sponsor_level FROM liveries l
    WHERE l.model_id = ?
      AND l.sponsor_level IN ('low','medium')
      AND l.id NOT IN (SELECT livery_id FROM entries WHERE season = ? AND championship_id = ?)
    ORDER BY l.id`);

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

  return {
    models,
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
    // an extra car for an existing team, rather than a first entry
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
      db.prepare(`INSERT INTO news (season,week,category,headline,body) VALUES (?,?,'team',?,?)`)
        .run(ctx.season.season, ctx.season.week,
             `${ctx.team.name} enters a second car`, `${m.name} as ${lv.livery_name}. Needs a driver.`);
      return { model: m.name, livery: lv.livery_name, championship: champ.name,
               spent: m.price_new, capital: p.capital - m.price_new, needsDriver: true };
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

// One image at a time, as a data URL, so the renderer needs no file access.
function image(resourcesDir, modelName, specs) {
  const s = specs.find(x => x.model === modelName);
  if (!s) return null;
  const f = path.join(resourcesDir, 'car_images', s.image);
  try {
    return 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
  } catch (_) { return null; }
}

module.exports = { list, buy, image, context };
