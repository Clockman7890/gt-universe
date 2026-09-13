'use strict';
const { rng, pick, NameFactory, TeamFactory } = require('./names');

// ---------------------------------------------------------------- helpers
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round3 = v => Math.round(v * 1000) / 1000;
const between = (r, lo, hi) => lo + r() * (hi - lo);
const irange = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

// Yearly change per skill family, by age. Speed peaks late twenties, judgement
// keeps improving into the forties, stamina starts falling after thirty.
function yearlyGain(age, r) {
  if (age <= 18) return [between(r,.035,.045), between(r,.030,.040), between(r,.020,.030)];
  if (age <= 22) return [between(r,.030,.040), between(r,.025,.035), between(r,.015,.025)];
  if (age <= 27) return [between(r,.018,.028), between(r,.020,.030), between(r,.005,.012)];
  if (age <= 33) return [between(r,.008,.015), between(r,.015,.025), between(r,-.002,.003)];
  if (age <= 39) return [between(r,-.002,.002), between(r,.008,.015), between(r,-.018,-.010)];
  if (age <= 45) return [between(r,-.015,-.008), between(r,.002,.008), between(r,-.028,-.018)];
  return [between(r,-.025,-.015), between(r,-.003,0), between(r,-.035,-.025)];
}

// Walk a driver from 17 to their current age so season one has plausible history.
function ageUp(r, age, pot) {
  let sp = between(r, .30, .44), ju = between(r, .26, .40), st = between(r, .40, .55);
  for (let a = 17; a < age; a++) {
    const [ds, dj, dt] = yearlyGain(a, r);
    sp = clamp(sp + ds, .10, pot.speed);
    ju = clamp(ju + dj, .10, pot.judgement);
    st = clamp(st + dt, .10, pot.stamina);
  }
  return { sp, ju, st };
}

// The eighteen AMS2 attributes, derived from the three families with jitter.
// Nobody who has reached a national championship is slow in absolute terms, so
// the three pace skills have a floor.
const FLOOR = 0.49;
function skills(r, f) {
  const j = (base, spread = .04) => round3(clamp(base + between(r, -spread, spread), .05, .99));
  const jp = (base, spread = .04) => round3(clamp(base + between(r, -spread, spread), FLOOR, .99));
  return {
    race_skill: jp(f.sp), qualifying_skill: jp(f.sp), start_reactions: j(f.sp, .07),
    consistency: j(f.ju), avoidance_of_mistakes: j(f.ju),
    avoidance_of_forced_mistakes: j(f.ju), wet_skill: jp(f.ju, .06),
    tyre_management: j(f.ju, .05), fuel_management: j(f.ju, .05),
    weather_tyre_changes: j(f.ju, .06), defending: j(f.ju, .06),
    aggression: round3(clamp(between(r, .25, .80), .05, .95)),
    stamina: j(f.st), blue_flag_conceding: round3(between(r, .30, .80))
  };
}

function fiaRating(age, cls) {
  if (cls === 'gt5') return null;          // no rating below GT4
  if (age < 25) return 'Silver';
  return age >= 40 ? 'Bronze' : (Math.random() < 0 ? 'Silver' : 'Bronze');
}

// ---------------------------------------------------------------- main
function generatePopulation(db, world, blocks, countries, namesDb, seed = 12345) {
  const r  = rng(seed);
  const nf = new NameFactory(namesDb, seed);
  const tf = new TeamFactory(seed + 1);

  const champs = db.prepare(`SELECT * FROM championships WHERE active_from = 1`).all();
  const byId   = Object.fromEntries(champs.map(c => [c.id, c]));
  const wById  = Object.fromEntries(world.championships.map(c => [c.id, c]));
  const feeds  = {};
  for (const row of db.prepare(`SELECT * FROM championship_blocks`).all())
    (feeds[row.championship_id] ||= []).push(row.block_id);

  const countryByBlock = {};
  for (const c of countries) (countryByBlock[c.block] ||= []).push(c.code);

  // ---- 1. how many drivers each block has to supply --------------------
  const demand = {};
  for (const c of champs) {
    const w = wById[c.id];
    if (w.shares_entries_with) continue;
    const seats = (w.grid_first || w.grid) * w.drivers_per_car;
    const src = feeds[c.id] || [];
    const total = src.reduce((s, b) => s + blocks.find(x => x.id === b).weight, 0) || 1;
    for (const b of src) {
      const share = blocks.find(x => x.id === b).weight / total;
      demand[b] = (demand[b] || 0) + seats * share;
    }
  }

  // ---- 2. drivers -------------------------------------------------------
  const insDriver = db.prepare(`INSERT INTO drivers
    (name,country,block_id,birth_year,is_player,origin,fia_rating,reputation,capital,
     passive_income,pot_speed,pot_judgement,pot_stamina)
    VALUES (@name,@country,@block,@birth,0,'gt5',NULL,0,@capital,@passive,@ps,@pj,@pt)`);
  const insSkills = db.prepare(`INSERT INTO driver_skills
    (driver_id,race_skill,qualifying_skill,wet_skill,start_reactions,aggression,defending,
     consistency,stamina,avoidance_of_mistakes,avoidance_of_forced_mistakes,tyre_management,
     fuel_management,weather_tyre_changes,blue_flag_conceding)
    VALUES (@id,@race_skill,@qualifying_skill,@wet_skill,@start_reactions,@aggression,@defending,
     @consistency,@stamina,@avoidance_of_mistakes,@avoidance_of_forced_mistakes,@tyre_management,
     @fuel_management,@weather_tyre_changes,@blue_flag_conceding)`);

  const pool = {};                                   // block -> [driver rows]
  const YEAR = 2020;
  for (const b of blocks) {
    const need = Math.ceil((demand[b.id] || 0) * 1.12) + 2;
    const codes = countryByBlock[b.id] || [];
    if (!codes.length) continue;
    pool[b.id] = [];
    for (let i = 0; i < need; i++) {
      // ages skew young; a long tail of gentlemen drivers keeps GT5 honest
      const age = r() < .55 ? irange(r, 18, 29) : (r() < .7 ? irange(r, 30, 41) : irange(r, 42, 52));
      const code = pick(r, codes);
      const pot = {
        speed:     round3(between(r, .73, .80)),
        judgement: round3(between(r, .70, .86)),
        stamina:   round3(between(r, .68, .84))
      };
      const fam = ageUp(r, age, pot);
      const sk  = skills(r, fam);
      const wealth = b.passive;
      const fullName = nf.driver(code, YEAR - age);
      const id = insDriver.run({
        name: fullName, country: code, block: b.id, birth: YEAR - age,
        capital: Math.round(between(r, 120000, 900000) * wealth / 100) * 100,
        passive: Math.round(between(r, 12000, 240000) * wealth / 1000) * 1000,
        ps: pot.speed, pj: pot.judgement, pt: pot.stamina
      }).lastInsertRowid;
      insSkills.run(Object.assign({ id }, sk));
      pool[b.id].push({ id, name: fullName, age, code, block: b.id, sk, pot, rating: null });
    }
    // strongest first, so promotion and seat priority read naturally
    pool[b.id].sort((a, c) => (c.sk.race_skill + c.sk.consistency) - (a.sk.race_skill + a.sk.consistency));
  }

  return { pool, demand, nf, tf, r };
}

module.exports = { generatePopulation, ageUp, skills, yearlyGain, clamp, round3, between, irange };
