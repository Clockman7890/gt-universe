'use strict';

// ---------------------------------------------------------------- calendar
// The template in championship_tracks becomes real rounds and legs for a season.
function buildCalendar(db, season) {
  const champs = db.prepare(`SELECT * FROM championships WHERE active_from <= ?`).all(season);
  const year = db.prepare(`SELECT calendar_year FROM career WHERE id = 1`).get().calendar_year
             + (season - db.prepare(`SELECT season FROM career WHERE id = 1`).get().season);

  const insRound = db.prepare(`INSERT INTO rounds
    (season,event_type,championship_id,round_no,track_id,week,race_date,grid_size,mixed_with)
    VALUES (?,'championship',?,?,?,?,?,?,?)`);
  const insLeg = db.prepare(`INSERT INTO legs
    (round_id,leg_no,distance_km,laps,race_date,start_time,practice_min,quali_min,
     ai_opponents,skip_quali)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);

  for (const c of champs) {
    const lvl = db.prepare(`SELECT * FROM championship_levels WHERE id = ?`).get(c.level_id);
    const tpl = db.prepare(`SELECT * FROM championship_tracks WHERE championship_id = ?
                            ORDER BY round_no`).all(c.id);
    // an endurance championship runs the sprint field, so it counts that one's cars
    const fieldOf = c.shares_entries_with || c.id;
    const entries = db.prepare(`SELECT COUNT(*) n FROM entries
                                WHERE season = ? AND championship_id = ?`).get(season, fieldOf).n;
    if (!entries) continue;

    for (const t of tpl) {
      const track = db.prepare(`SELECT * FROM tracks WHERE id = ?`).get(t.track_id);
      const roundId = insRound.run(season, c.id, t.round_no, t.track_id, t.week,
        weekToDate(year, t.week), Math.min(entries, track.max_grid), null).lastInsertRowid;

      const km = t.distance_override || lvl.distance_km;
      const laps = Math.ceil(km / track.length_km);
      const plan = weekendPlan(c.class, lvl, km, weekToDate(year, t.week));
      for (const L of plan) {
        insLeg.run(roundId, L.leg, km, laps, L.date, L.start,
                   L.practice, L.quali, Math.max(0, entries - 1), L.skipQuali ? 1 : 0);
      }
    }
  }
}

// Average race pace, used to work out when the second leg can start.
const SPEED = { gt5: 128, gt4: 150, gt3: 170, lmdh: 190 };

// The clock runs at double speed, so a real minute costs two in-game minutes.
const hhmm = m => `${String(Math.floor((m / 60) % 24)).padStart(2, '0')}:` +
                  `${String(Math.round(m) % 60).padStart(2, '0')}`;
const dayBefore = iso => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

// Two short races run on Saturday and Sunday. One long race split in two runs
// on the Sunday, the second half starting after the first has finished.
function weekendPlan(cls, lvl, km, sunday) {
  const saturday = dayBefore(sunday);
  const tier = cls === 'gt5' ? 'gt5' : cls === 'gt4' ? 'gt4' : cls === 'lmdh' ? 'lmdh' : 'gt3';

  if (!lvl.two_leg) {
    // GT5 qualifies on both days; GT4 and GT3 Sprint take Sunday's grid
    // from Saturday's finishing order
    const open = cls === 'gt5' ? [9 * 60, 10 * 60] : [12 * 60, 13 * 60];
    const qualiSunday = cls === 'gt5' || cls === 'gt3';
    return [
      { leg: 1, date: saturday, start: hhmm(open[0]),
        practice: lvl.practice_minutes, quali: lvl.qualifying_minutes, skipQuali: 0 },
      { leg: 2, date: sunday, start: hhmm(open[1]),
        practice: 0, quali: qualiSunday ? lvl.qualifying_minutes : 0,
        skipQuali: qualiSunday ? 0 : 1 }
    ];
  }

  // one race, two stints, same day
  const start = km >= 200 ? 10 * 60 : (tier === 'lmdh' ? 12 * 60 : 11 * 60);
  const hour = m => Math.ceil(m / 60) * 60;
  let t = hour(start + lvl.practice_minutes * 2);        // qualifying, on the hour
  const legStart = hour(t + lvl.qualifying_minutes * 2); // race, on the hour
  const legReal = km / SPEED[tier] * 60;
  // the second stint also has to begin on the hour
  const secondStart = Math.ceil((legStart + legReal * 2 + 40) / 60) * 60;
  return [
    { leg: 1, date: sunday, start: hhmm(start),
      practice: lvl.practice_minutes, quali: lvl.qualifying_minutes, skipQuali: 0 },
    { leg: 2, date: sunday, start: hhmm(secondStart),
      practice: 0, quali: 0, skipQuali: 1 }
  ];
}

// Race day is the Sunday of that week; AMS2 only uses it to pick the weather.
function weekToDate(year, week) {
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const d = new Date(jan1.getTime() + ((week - 1) * 7 + 6) * 86400000);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- lookup
// The next round the player is entered in, and whether it is this week.
function nextRound(db) {
  const c = db.prepare(`SELECT season, week, player_driver_id FROM career WHERE id = 1`).get();
  const row = db.prepare(`
    SELECT r.*, ch.name championship, ch.class, ch.level_id, t.name track, t.length_km, t.max_grid
    FROM rounds r
    JOIN championships ch ON ch.id = r.championship_id
    JOIN tracks t ON t.id = r.track_id
    WHERE r.season = ? AND r.played = 0
      AND r.championship_id IN (
        SELECT e.championship_id FROM entries e
        JOIN entry_drivers ed ON ed.entry_id = e.id
        WHERE ed.driver_id = ? AND e.season = ?)
    ORDER BY r.week, r.round_no LIMIT 1`).get(c.season, c.player_driver_id, c.season);
  if (!row) return null;
  row.thisWeek = row.week === c.week;
  row.weeksAway = row.week - c.week;
  row.legs = db.prepare(`SELECT * FROM legs WHERE round_id = ? ORDER BY leg_no`).all(row.id);
  return row;
}

// ---------------------------------------------------------------- XML
const FIELDS = ['race_skill', 'qualifying_skill', 'aggression', 'defending', 'stamina',
  'consistency', 'start_reactions', 'wet_skill', 'tyre_management', 'fuel_management',
  'blue_flag_conceding', 'weather_tyre_changes', 'avoidance_of_mistakes',
  'avoidance_of_forced_mistakes'];

const f3 = v => Number(v).toFixed(3);
// Automobilista 2 draws plain ASCII, so accents and the like are folded down
// before the name ever reaches the file.
const FOLD = {
  'à':'a','á':'a','â':'a','ã':'a','ä':'a','å':'a','ā':'a','ă':'a','ą':'a',
  'ç':'c','ć':'c','č':'c','ĉ':'c','ċ':'c',
  'ď':'d','đ':'d','ð':'d',
  'è':'e','é':'e','ê':'e','ë':'e','ē':'e','ĕ':'e','ė':'e','ę':'e','ě':'e',
  'ĝ':'g','ğ':'g','ġ':'g','ģ':'g',
  'ĥ':'h','ħ':'h',
  'ì':'i','í':'i','î':'i','ï':'i','ĩ':'i','ī':'i','ĭ':'i','į':'i','ı':'i',
  'ĵ':'j','ķ':'k',
  'ĺ':'l','ļ':'l','ľ':'l','ł':'l',
  'ñ':'n','ń':'n','ņ':'n','ň':'n',
  'ò':'o','ó':'o','ô':'o','õ':'o','ö':'o','ø':'o','ō':'o','ŏ':'o','ő':'o',
  'ŕ':'r','ŗ':'r','ř':'r',
  'ś':'s','ŝ':'s','ş':'s','š':'s','ș':'s','ß':'ss',
  'ţ':'t','ť':'t','ŧ':'t','ț':'t',
  'ù':'u','ú':'u','û':'u','ü':'u','ũ':'u','ū':'u','ŭ':'u','ů':'u','ű':'u','ų':'u',
  'ŵ':'w','ý':'y','ÿ':'y','ŷ':'y',
  'ź':'z','ż':'z','ž':'z',
  'æ':'ae','œ':'oe','þ':'th','ŀ':'l','ŉ':'n'
};
function ascii(str) {
  let out = '';
  for (const ch of String(str)) {
    const low = ch.toLowerCase();
    if (FOLD[low]) {
      const folded = FOLD[low];
      out += ch === low ? folded
           : folded.charAt(0).toUpperCase() + folded.slice(1);
    } else if (ch.charCodeAt(0) < 128) {
      out += ch;
    } else {
      // anything still outside ASCII is dropped rather than drawn as a box
      const norm = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      out += /^[\x00-\x7F]+$/.test(norm) ? norm : '';
    }
  }
  return out;
}

const esc = s => ascii(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                         .replace(/"/g, '&quot;');

function driverBlock(row, grid) {
  const lines = [`<driver livery_name="${esc(row.livery_name)}">`];
  lines.push(`  <name>${esc(row.name)}</name>`);
  lines.push(`  <country>${esc(row.country)}</country>`);
  for (const k of FIELDS) lines.push(`  <${k}>${f3(row[k])}</${k}>`);
  // an artificial grid order for the second leg, from the first leg's result
  if (grid !== undefined) lines.push(`  <qualifying_skill>${f3(grid)}</qualifying_skill>`);
  lines.push(`  <vehicle_reliability>${f3(row.reliability)}</vehicle_reliability>`);
  lines.push(`  <weight_scalar>${f3(row.weight_scalar)}</weight_scalar>`);
  lines.push(`  <power_scalar>${f3(row.power_scalar)}</power_scalar>`);
  lines.push(`  <drag_scalar>${f3(row.drag_scalar)}</drag_scalar>`);
  lines.push(`</driver>`);
  return lines.join('\n');
}

// Everything on the grid for one leg, grouped by the file AMS2 reads it from.
function gridFor(db, round, legNo) {
  const season = db.prepare(`SELECT season, player_driver_id FROM career WHERE id = 1`).get();
  // the field is this championship's own, unless it borrows another's
  const borrows = db.prepare(`SELECT shares_entries_with s FROM championships WHERE id = ?`)
    .get(round.championship_id);
  const fieldChamp = (borrows && borrows.s) || round.championship_id;

  const rows = db.prepare(`
    SELECT e.id entry_id, l.livery_name, cm.ai_file, cm.id model_id,
           d.id driver_id, d.name, d.country, d.is_player,
           s.race_skill, s.qualifying_skill, s.aggression, s.defending, s.stamina,
           s.consistency, s.start_reactions, s.wet_skill, s.tyre_management,
           s.fuel_management, s.blue_flag_conceding, s.weather_tyre_changes,
           s.avoidance_of_mistakes, s.avoidance_of_forced_mistakes,
           cp.weight_scalar, cp.power_scalar, cp.drag_scalar, ch.dev_bonus,
           t.engineering, t.name team_name, t.is_privateer, ed.role
    FROM entries e
    JOIN chassis ch ON ch.id = e.chassis_id
    JOIN car_models cm ON cm.id = ch.model_id
    JOIN liveries l ON l.id = e.livery_id
    JOIN teams t ON t.id = e.team_id
    JOIN car_performance cp ON cp.model_id = cm.id AND cp.season = e.season
    JOIN entry_drivers ed ON ed.entry_id = e.id AND ed.role = ?
    JOIN drivers d ON d.id = ed.driver_id
    JOIN driver_skills s ON s.driver_id = d.id
    WHERE e.season = ? AND e.championship_id = ?
      AND e.id NOT IN (SELECT entry_id FROM round_absences WHERE round_id = ?)`)
    .all(legNo === 2 ? 2 : 1, season.season, fieldChamp, round.id);

  // Teams with better engineering break down less often, but nothing is safe:
  // even a specialist outfit sits well short of certainty.
  const REL = { amateurs: 0.68, experienced: 0.78, specialist: 0.86 };
  // the same crew spread over more cars gets less time on each of them
  const FLEET_PENALTY = { 1: 1.00, 2: 0.96, 3: 0.91, 4: 0.85 };
  const fleetSize = {};
  for (const r of rows) fleetSize[r.team_name] = (fleetSize[r.team_name] || 0) + 1;

  for (const r of rows) {
    const n = Math.min(4, fleetSize[r.team_name] || 1);
    r.reliability = (REL[r.engineering] || 0.72) * (FLEET_PENALTY[n] || 0.85);

    // a car that has been worked on carries a little more pace: one per cent of
    // power is worth about 0.13s, so convert the seconds back into a scalar
    const dev = r.dev_bonus || 0;
    if (dev) {
      const clamp = v => Math.min(1.100, Math.max(0.900, v));
      r.power_scalar  = clamp(r.power_scalar  + dev / 0.13 * 0.01);
      r.weight_scalar = clamp(r.weight_scalar - dev / 0.10 * 0.004);
    }
  }
  return rows;
}

// Build the files and the instruction block for one leg.
function prepareLeg(db, round, legNo) {
  const leg = db.prepare(`SELECT * FROM legs WHERE round_id = ? AND leg_no = ?`)
                .get(round.id, legNo);
  const lvl = db.prepare(`SELECT * FROM championship_levels WHERE id = ?`).get(round.level_id);
  const me = db.prepare(`SELECT player_driver_id p FROM career WHERE id = 1`).get().p;

  let rows = gridFor(db, round, legNo);
  if (!rows.length && legNo === 2) rows = gridFor(db, round, 1);   // one-driver classes

  // second leg of a two-leg round starts in first-leg finishing order
  let gridOrder = null;
  if (leg.skip_quali) {
    const res = db.prepare(`
      SELECT r.entry_id, r.finish_pos FROM results r
      JOIN legs l ON l.id = r.leg_id
      WHERE l.round_id = ? AND l.leg_no = 1 AND r.finish_pos IS NOT NULL
      ORDER BY r.finish_pos`).all(round.id);
    if (res.length > 1) {
      gridOrder = new Map();
      res.forEach((r, i) => gridOrder.set(r.entry_id, 1 - i / (res.length - 1)));
    }
  }

  // Every entry goes in, the player's included: without it the game would not
  // apply their scalars or reliability. The opponent count is one short of the
  // grid, so the livery they pick is the one left over.
  const byFile = {};
  let playerLivery = null, playerGrid = null;
  for (const r of rows) {
    if (r.is_player) {
      playerLivery = r.livery_name;
      if (gridOrder) playerGrid = [...gridOrder.keys()].indexOf(r.entry_id) + 1;
    }
    (byFile[r.ai_file] ||= []).push(
      driverBlock(r, gridOrder ? gridOrder.get(r.entry_id) : undefined));
  }

  const files = Object.entries(byFile).map(([name, blocks]) => ({
    name,
    xml: ['<?xml version="1.0" encoding="UTF-8"?>', '<custom_ai_drivers>',
          ...blocks, '</custom_ai_drivers>', ''].join('\r\n')
  }));

  const sim = db.prepare(`SELECT * FROM sim_constants WHERE id = 1`).get();

  // The clock runs at x2, so a real minute costs two in-game minutes. These are
  // the times the player will actually see on the in-game clock.
  // AMS2 takes a start time per session and only on the hour, so each session
  // begins at the first whole hour after the one before it has finished.
  const nextHour = m => Math.ceil(m / 60) * 60;
  const mins = leg.start_time.split(':').reduce((h, m) => h * 60 + +m, 0);
  const speed = SPEED[round.class === 'gt5' ? 'gt5' : round.class === 'gt4' ? 'gt4'
                    : round.class === 'lmdh' ? 'lmdh' : 'gt3'];
  const raceReal = leg.distance_km / speed * 60;

  const sessions = [];
  let t = mins;
  if (leg.practice_min) {
    const end = t + leg.practice_min * 2;
    sessions.push({ name: 'Practice', start: hhmm(t), ends: hhmm(end), real: leg.practice_min });
    t = nextHour(end);
  }
  if (leg.quali_min) {
    const end = t + leg.quali_min * 2;
    sessions.push({ name: 'Qualifying', start: hhmm(t), ends: hhmm(end), real: leg.quali_min });
    t = nextHour(end);
  }
  sessions.push({
    name: leg.leg_no === 2 && lvl.two_leg ? 'Race — second stint' : 'Race',
    start: hhmm(t), ends: hhmm(t + raceReal * 2), real: Math.round(raceReal)
  });

  // one-make series line up on the grid; everything else rolls
  const startType = round.class === 'gt5' ? 'Standing' : 'Rolling';

  return {
    sessions, startType,
    leg: legNo, laps: leg.laps, distance: leg.distance_km,
    startTime: leg.start_time, date: leg.race_date || round.race_date,
    aiOpponents: rows.filter(r => !r.is_player).length,
    practice: leg.practice_min,
    qualifying: leg.quali_min || null,
    qualifyingPrivate: !!lvl.qualifying_private,
    stops: lvl.mandatory_stops,
    window: lvl.pit_window_from ? [lvl.pit_window_from, lvl.pit_window_to] : null,
    playerLivery, playerGrid,
    timeMultiplier: sim.time_multiplier, tyreWear: sim.tyre_wear,
    fuelUsage: sim.fuel_usage, damage: sim.damage,
    files
  };
}

module.exports = { buildCalendar, nextRound, prepareLeg, weekToDate };
