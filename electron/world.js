'use strict';

// Fills every static reference table from resources/world.json.
// Runs once, inside the transaction that creates a new career.
function buildWorld(db, world, blocks, countries, alreadySeeded = false) {
  const ins = {
    block:   db.prepare(`INSERT INTO blocks (id,name,continent,production_weight,passive_multiplier)
                         VALUES (?,?,?,?,?)`),
    country: db.prepare(`INSERT INTO countries (code,name,block_id,weight) VALUES (?,?,?,?)`),
    track:   db.prepare(`INSERT INTO tracks (name,country,length_km,max_grid,continent)
                          VALUES (?,?,?,?,?)`),
    man:     db.prepare(`INSERT INTO manufacturers (name,customer_only) VALUES (?,?)`),
    model:   db.prepare(`INSERT INTO car_models
                (name,manufacturer_id,class,ai_file,price_new,purchasable,running_cost_index,
                 works_support,base_weight_scalar,base_power_scalar,base_drag_scalar,
                 bop_drift_min,bop_drift_max)
                VALUES (@name,@man,@cls,@ai,@price,@buy,@run,@works,@w,@p,@d,@dmin,@dmax)`),
    livery:  db.prepare(`INSERT INTO liveries (model_id,livery_name,sponsor_level) VALUES (?,?,?)`),
    level:   db.prepare(`INSERT INTO championship_levels
                (id,races_per_round,distance_km,two_leg,drivers_per_car,practice_minutes,
                 qualifying_minutes,qualifying_private,pole_points,mandatory_stops,
                 pit_window_from,pit_window_to,latest_start)
                VALUES (@id,@races,@km,@two,@drv,@prac,@qual,@priv,@pole,@stops,@wf,@wt,@late)`),
    points:  db.prepare(`INSERT INTO points_scheme (level_id,position,points) VALUES (?,?,?)`),
    champ:   db.prepare(`INSERT INTO championships
                (id,name,level_id,class,model_id,home_continent,prestige,rounds,min_grid,winter,active_from)
                VALUES (@id,@name,@level,@cls,@model,@cont,@prest,@rounds,@min,@winter,@from)`),
    cblock:  db.prepare(`INSERT INTO championship_blocks (championship_id,block_id) VALUES (?,?)`),
    ctrack:  db.prepare(`INSERT INTO championship_tracks
                (championship_id,round_no,track_id,week,distance_override) VALUES (?,?,?,?,?)`)
  };

  if (!alreadySeeded) {
    for (const b of blocks)    ins.block.run(b.id, b.name, b.continent, b.weight, b.passive);
    for (const c of countries) ins.country.run(c.code, c.name, c.block, 1.0);
  }

  const trackId = {};
  for (const t of world.tracks) {
    trackId[t.name] = ins.track.run(t.name, null, t.km, t.max_grid,
                                    t.continent || 'europe').lastInsertRowid;
  }

  const CUSTOMER_ONLY = new Set(['Nissan', 'Ginetta', 'Ultima', 'Puma', 'Mitsubishi']);
  const manId = {};
  for (const m of world.manufacturers) {
    manId[m] = ins.man.run(m, CUSTOMER_ONLY.has(m) ? 1 : 0).lastInsertRowid;
  }

  // GTO cars never receive a negative BoP adjustment — they are already at the floor.
  const modelId = {};
  for (const m of world.models) {
    const gto = m.cls === 'gto';
    modelId[m.name] = ins.model.run({
      name: m.name, man: manId[m.manufacturer], cls: m.cls, ai: m.ai_file,
      price: m.price, buy: m.purchasable ? 1 : 0, run: m.run_cost, works: m.works ? 1 : 0,
      w: m.scalars.weight, p: m.scalars.power, d: m.scalars.drag,
      dmin: gto ? 0 : -0.030, dmax: gto ? 0.015 : 0.030
    }).lastInsertRowid;

    // Liveries with the fewest sponsors go to privateers first. The pool is
    // ordered as the game lists it, so the tail of each model is the plain end.
    const n = m.liveries.length;
    m.liveries.forEach((lv, i) => {
      const level = i >= n - Math.ceil(n / 3) ? 'low' : (i < Math.floor(n / 3) ? 'high' : 'medium');
      ins.livery.run(modelId[m.name], lv, level);
    });
  }

  for (const l of world.levels) {
    ins.level.run({
      id: l.id, races: l.races, km: l.km, two: l.two_leg ? 1 : 0, drv: l.drivers,
      prac: l.practice, qual: l.quali, priv: l.private ? 1 : 0, pole: l.pole,
      stops: l.stops, wf: l.window ? l.window[0] : null, wt: l.window ? l.window[1] : null,
      late: l.latest_start
    });
    world.points.forEach((pts, i) => ins.points.run(l.id, i + 1, pts));
  }

  const byContinent = {};
  for (const b of blocks) (byContinent[b.continent] ||= []).push(b.id);

  for (const c of world.championships) {
    ins.champ.run({
      id: c.id, name: c.name, level: c.level, cls: c.cls,
      model: c.model ? modelId[c.model] : null, cont: c.continent, prest: c.prestige,
      rounds: c.rounds, min: c.cls === 'gt5' ? 10 : 12,
      winter: c.winter ? 1 : 0, from: c.active_from
    });

    // GT5 draws from its own block; everything above draws from the whole continent.
    const feeds = c.cls === 'gt5' ? [c.id] : (byContinent[c.continent] || []);
    for (const b of feeds) if (blocks.some(x => x.id === b)) ins.cblock.run(c.id, b);

    const big = new Set(world.big_tracks);
    c.calendar.forEach((t, i) => {
      const override = (c.cls === 'gt3' && big.has(t)) ? 250 : null;
      ins.ctrack.run(c.id, i + 1, trackId[t], c.weeks[i], override);
    });
  }

  return { trackId, modelId, manId };
}

module.exports = { buildWorld };
