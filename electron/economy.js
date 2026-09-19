'use strict';
const { rng, pick } = require('./names');

// ---------------------------------------------------------------- the bills
// Per round. Crew hire is what a privateer pays to have anyone at all in the
// pit; a team with its own staff has paid that up front and only pays the
// per-car running cost.
const CREW_PRIVATEER = { gt5: [8000, 14000], gt4: [30000, 45000],
                         gt3: [70000, 110000], lmdh: [120000, 180000] };
const CREW_TEAM      = { gt5: [1500, 2500],  gt4: [6000, 9000],
                         gt3: [18000, 26000], lmdh: [40000, 60000] };
const TRAVEL_HOME    = { gt5: 4000,  gt4: 12000, gt3: 32000, lmdh: 85000 };
const TRAVEL_AWAY    = { gt5: 9000,  gt4: 26000, gt3: 70000, lmdh: 150000 };

const tierOf = cls => cls === 'gt5' ? 'gt5' : cls === 'gt4' ? 'gt4'
                    : cls === 'lmdh' ? 'lmdh' : 'gt3';

// What one entry must find to make the trip.
function roundCost(db, entryId, roundId) {
  const row = db.prepare(`
    SELECT ch.class, t.is_privateer, t.block_id, t.id team_id, t.owner_driver_id,
           b.continent AS team_continent, tr.continent AS track_continent,
           (SELECT COUNT(*) FROM entries e2 WHERE e2.team_id = t.id AND e2.season = e.season) fleet
    FROM entries e
    JOIN teams t ON t.id = e.team_id
    JOIN blocks b ON b.id = t.block_id
    JOIN championships ch ON ch.id = e.championship_id
    JOIN rounds r ON r.id = @round
    JOIN tracks tr ON tr.id = r.track_id
    WHERE e.id = @entry`).get({ entry: entryId, round: roundId });
  if (!row) return null;

  const t = tierOf(row.class);
  const band = row.is_privateer ? CREW_PRIVATEER[t] : CREW_TEAM[t];
  const mid = Math.round((band[0] + band[1]) / 2);
  const away = row.team_continent !== row.track_continent;
  const travel = away ? TRAVEL_AWAY[t] : TRAVEL_HOME[t];

  return { crew: mid, travel, total: mid + travel, away,
           teamId: row.team_id, ownerDriverId: row.owner_driver_id,
           isPrivateer: !!row.is_privateer, tier: t };
}

// Money is held by the owner when there is one, and by the team otherwise.
function purseOf(db, cost) {
  if (cost.ownerDriverId) {
    const d = db.prepare(`SELECT capital FROM drivers WHERE id = ?`).get(cost.ownerDriverId);
    return { kind: 'driver', id: cost.ownerDriverId, capital: d ? d.capital : 0 };
  }
  const t = db.prepare(`SELECT capital FROM teams WHERE id = ?`).get(cost.teamId);
  return { kind: 'team', id: cost.teamId, capital: t ? t.capital : 0 };
}

function charge(db, purse, amount, season, week, reason, roundId, entryId) {
  const kind = purse.kind === 'driver' ? 'drivers' : 'teams';
  db.prepare(`UPDATE ${kind} SET capital = capital - ? WHERE id = ?`).run(amount, purse.id);
  db.prepare(`INSERT INTO ledger
              (season,week,round_id,entry_id,entity_type,entity_id,amount,reason)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(season, week, roundId || null, entryId || null, purse.kind, purse.id, -amount, reason);
}

// The player pays for their own meeting, once, when they commit to running it.
function chargePlayerRound(db, roundId, entryId) {
  const c = db.prepare(`SELECT season, week FROM career WHERE id = 1`).get();
  const cost = roundCost(db, entryId, roundId);
  if (!cost) return null;
  const purse = purseOf(db, cost);
  // Guarded per car, not per payer. An owner running two entries is the payer
  // for both, so matching on who paid made the second car free: the first
  // charge satisfied the guard and the other car travelled for nothing.
  const already = db.prepare(`SELECT 1 FROM ledger WHERE round_id = ? AND entry_id = ?
                              AND reason = 'race_costs'`).get(roundId, entryId);
  if (already) return { alreadyPaid: true, total: cost.total };
  charge(db, purse, cost.total, c.season, c.week, 'race_costs', roundId, entryId);
  return Object.assign(cost, { paid: true, capital: purse.capital - cost.total });
}

// How deep anyone is allowed to go before they simply cannot travel.
const OVERDRAFT = { gt5: -50000, gt4: -150000, gt3: -400000, lmdh: -600000 };

// ------------------------------------------------------- who makes the trip
// Called as a round comes up. Every entry that cannot pay its way stays home.
function settleRound(db, roundId) {
  const c = db.prepare(`SELECT season, week, player_driver_id FROM career WHERE id = 1`).get();
  const round = db.prepare(`
    SELECT r.*, ch.name championship,
           COALESCE(ch.shares_entries_with, ch.id) field_champ
    FROM rounds r
    JOIN championships ch ON ch.id = r.championship_id WHERE r.id = ?`).get(roundId);
  if (!round) return { missing: [] };

  const entries = db.prepare(`
    SELECT e.id, t.name team,
           (SELECT d.name FROM entry_drivers ed JOIN drivers d ON d.id = ed.driver_id
            WHERE ed.entry_id = e.id ORDER BY ed.role LIMIT 1) driver,
           (SELECT ed.driver_id FROM entry_drivers ed
            WHERE ed.entry_id = e.id ORDER BY ed.role LIMIT 1) driver_id
    FROM entries e JOIN teams t ON t.id = e.team_id
    WHERE e.season = ? AND e.championship_id = ?`).get ? db.prepare(`
    SELECT e.id, t.name team,
           (SELECT d.name FROM entry_drivers ed JOIN drivers d ON d.id = ed.driver_id
            WHERE ed.entry_id = e.id ORDER BY ed.role LIMIT 1) driver,
           (SELECT ed.driver_id FROM entry_drivers ed
            WHERE ed.entry_id = e.id ORDER BY ed.role LIMIT 1) driver_id
    FROM entries e JOIN teams t ON t.id = e.team_id
    WHERE e.season = ? AND e.championship_id = ?`).all(c.season, round.field_champ) : [];

  const missing = [];
  const tx = db.transaction(() => {
    for (const e of entries) {
      const already = db.prepare(`SELECT 1 FROM round_absences WHERE round_id = ? AND entry_id = ?`)
        .get(roundId, e.id);
      if (already) continue;
      const paid = db.prepare(`SELECT 1 FROM ledger WHERE round_id = ? AND entry_id = ?
                               AND reason = 'race_costs'`).get(roundId, e.id);
      if (paid) continue;

      const cost = roundCost(db, e.id, roundId);
      if (!cost) continue;
      const purse = purseOf(db, cost);
      const floor = OVERDRAFT[cost.tier];

      // the player decides for themselves; everyone else is decided by the bank
      if (e.driver_id === c.player_driver_id) continue;

      if (purse.capital - cost.total < floor) {
        db.prepare(`INSERT INTO round_absences (round_id,entry_id,reason)
                    VALUES (?,?,'no_funds')`).run(roundId, e.id);
        missing.push({ entryId: e.id, team: e.team, driver: e.driver });
      } else {
        charge(db, purse, cost.total, c.season, c.week, 'race_costs', roundId, e.id);
      }
    }
  });
  tx();
  return { missing, round: round.round_no, championship: round.championship };
}

// The player chooses to skip: no costs, no result, and the paddock notices.
function withdraw(db, roundId, entryId) {
  const c = db.prepare(`SELECT season, week FROM career WHERE id = 1`).get();
  db.prepare(`INSERT OR REPLACE INTO round_absences (round_id,entry_id,reason)
              VALUES (?,?,'withdrawn')`).run(roundId, entryId);
  const who = db.prepare(`
    SELECT d.name, t.name team, ch.name championship, tr.name track
    FROM entries e JOIN teams t ON t.id = e.team_id
    JOIN championships ch ON ch.id = e.championship_id
    JOIN rounds r ON r.id = @round JOIN tracks tr ON tr.id = r.track_id
    LEFT JOIN entry_drivers ed ON ed.entry_id = e.id AND ed.role = 1
    LEFT JOIN drivers d ON d.id = ed.driver_id
    WHERE e.id = @entry`).get({ round: roundId, entry: entryId });
  if (who)
    db.prepare(`INSERT INTO news (season,week,category,headline,body) VALUES (?,?,'driver',?,?)`)
      .run(c.season, c.week, `${who.name || who.team} withdraws from ${who.track}`,
           `${who.championship}. No entry this round.`);
  dirtyNews(db);
  return true;
}

function dirtyNews() { /* nothing to do; kept for clarity at the call site */ }

function absentEntries(db, roundId) {
  return db.prepare(`SELECT entry_id, reason FROM round_absences WHERE round_id = ?`)
    .all(roundId).reduce((m, r) => (m[r.entry_id] = r.reason, m), {});
}

// ---------------------------------------------------------------- backers
const SPONSOR_PAY = { gt5: [3000, 8000], gt4: [9000, 22000],
                      gt3: [30000, 70000], lmdh: [90000, 180000] };

const TIER_WORDS = {
  local:         ['Garage', 'Tyres', 'Motors', 'Autoparts', 'Fuels', 'Bodyshop'],
  regional:      ['Logistics', 'Insurance', 'Brakes', 'Lubricants', 'Haulage'],
  national:      ['Telecom', 'Bank', 'Energy', 'Airlines', 'Electronics'],
  international: ['Group', 'Global', 'Industries', 'Holdings', 'Worldwide']
};
const PREFIX = ['Aster', 'Brava', 'Corva', 'Delta', 'Eiger', 'Falk', 'Girona',
                'Halden', 'Ionis', 'Koro', 'Lumen', 'Maro', 'Nexo', 'Orla',
                'Praxa', 'Quill', 'Rova', 'Silla', 'Torvi', 'Umbra', 'Vanta'];

// How many backers a driver can carry at once.
function slots(driver) {
  const rep = driver.reputation || 0;
  let n = rep >= 0.8 ? 5 : rep >= 0.6 ? 4 : rep >= 0.4 ? 3 : rep >= 0.2 ? 2 : 1;
  if (driver.fia_rating === 'Platinum') n += 1;
  return Math.min(6, n);
}

function tierFor(rep, r) {
  const roll = r() * 0.6 + rep * 0.5;
  return roll > 0.95 ? 'international' : roll > 0.7 ? 'national'
       : roll > 0.4 ? 'regional' : 'local';
}

const TIER_MULT = { local: 1.0, regional: 1.6, national: 2.6, international: 4.2 };

// After a round: good results attract money, and money runs out in time.
function reviewSponsors(db, roundId) {
  const c = db.prepare(`SELECT season, week, player_driver_id FROM career WHERE id = 1`).get();
  const round = db.prepare(`
    SELECT r.*, ch.class, ch.prestige FROM rounds r
    JOIN championships ch ON ch.id = r.championship_id WHERE r.id = ?`).get(roundId);
  if (!round) return [];

  // A sponsorship is bought by the round, not by the race, and a round can be
  // two races on the same weekend. So nothing is counted down or paid out until
  // every leg of the meeting is behind us: a backer who signed for five rounds
  // does not walk out between Saturday and Sunday. This also keeps the player
  // honest with the rest of the field — the player's legs come through here one
  // at a time, the AI's arrive as a finished round, and before this the player
  // was being paid twice a weekend.
  const legsLeft = db.prepare(`SELECT COUNT(*) n FROM legs
                               WHERE round_id = ? AND simulated = 0`).get(roundId).n;
  if (legsLeft) return [];

  const tier = tierOf(round.class);
  const r = rng((roundId * 2654435761 + c.season) >>> 0);
  const signed = [];

  const perDriver = db.prepare(`
    SELECT res.driver_id,
           SUM(CASE WHEN res.finish_pos = 1 THEN 1 ELSE 0 END) wins,
           SUM(CASE WHEN res.finish_pos <= 3 AND res.finish_pos IS NOT NULL THEN 1 ELSE 0 END) podiums,
           SUM(CASE WHEN res.points > 0 THEN 1 ELSE 0 END) scores
    FROM results res JOIN legs l ON l.id = res.leg_id
    WHERE l.round_id = ? GROUP BY res.driver_id`).all(roundId);

  const tx = db.transaction(() => {
    for (const row of perDriver) {
      const d = db.prepare(`SELECT * FROM drivers WHERE id = ?`).get(row.driver_id);
      if (!d) continue;

      // pay out what is already signed
      const live = db.prepare(`SELECT * FROM sponsors WHERE driver_id = ? AND rounds_left > 0`)
        .all(d.id);
      let paid = 0;
      for (const s of live) paid += s.per_round;
      if (paid) {
        db.prepare(`UPDATE drivers SET capital = capital + ? WHERE id = ?`).run(paid, d.id);
        db.prepare(`INSERT INTO ledger (season,week,round_id,entity_type,entity_id,amount,reason)
                    VALUES (?,?,?,'driver',?,?, 'sponsorship')`)
          .run(c.season, c.week, roundId, d.id, paid);
      }

      // and see whether anyone new is interested
      const held = db.prepare(`SELECT COUNT(*) n FROM sponsors WHERE driver_id = ? AND rounds_left > 0`)
        .get(d.id).n;
      if (held >= slots(d)) continue;

      const chance = 0.03 + row.wins * 0.20 + row.podiums * 0.07 + row.scores * 0.02
                   + (d.reputation || 0) * 0.12;
      if (r() > chance) continue;

      const st = tierFor(d.reputation || 0, r);
      const band = SPONSOR_PAY[tier];
      const pay = Math.round((band[0] + r() * (band[1] - band[0])) * TIER_MULT[st]
                             * round.prestige / 500) * 500;
      const name = `${pick(r, PREFIX)} ${pick(r, TIER_WORDS[st])}`;
      // three to ten race weekends: less than a season at the short end, two at
      // the long one, so a good run is worth something beyond the prize money
      const rounds = 3 + Math.floor(r() * 8);

      db.prepare(`INSERT INTO sponsors (driver_id,name,per_round,rounds_left,season_signed,tier)
                  VALUES (?,?,?,?,?,?)`).run(d.id, name, pay, rounds, c.season, st);

      if (d.is_player)
        db.prepare(`INSERT INTO news (season,week,category,headline,body) VALUES (?,?,'driver',?,?)`)
          .run(c.season, c.week, `${name} comes on board`,
               `${pay} a round for the next ${rounds} race weekends.`);
      signed.push({ driver: d.name, sponsor: name, pay, rounds, isPlayer: !!d.is_player });
    }

    // Counted down only after everyone has been paid for the round they just
    // ran. The other way round costs a backer's final round: the term ticks to
    // zero, the payout skips it as expired, and the driver never sees the money
    // he was owed for the weekend he just did.
    db.prepare(`UPDATE sponsors SET rounds_left = rounds_left - 1
                WHERE driver_id IN (SELECT DISTINCT res.driver_id FROM results res
                                    JOIN legs l ON l.id = res.leg_id WHERE l.round_id = ?)
                  AND rounds_left > 0`).run(roundId);

    db.prepare(`DELETE FROM sponsors WHERE rounds_left <= 0`).run();
  });
  tx();
  return signed;
}

function sponsorsOf(db, driverId) {
  return db.prepare(`SELECT name, per_round, rounds_left, tier FROM sponsors
                     WHERE driver_id = ? ORDER BY per_round DESC`).all(driverId);
}

// ------------------------------------------------------------ the reckoning
// Racing on somebody else's money only works while somebody else keeps lending
// it. Three states, and the player is always told which one they are in:
//
//   ok        the books balance, carry on
//   must_sell overdrawn, but the cars are worth more than the debt — sell one
//   ruined    overdrawn with nothing left worth enough to cover it
//
// The middle state is the important one. It is the difference between a bad
// year and the end of a career, and it is only reachable if the player can
// actually see their cars and sell them, which is why their team is never
// wound up for them.
function solvency(db) {
  const me = db.prepare(`SELECT id, capital, passive_income FROM drivers WHERE is_player = 1`).get();
  if (!me) return null;

  // what the cars would fetch: the same seven tenths a dealer pays, and only
  // cars not already committed to this season's entry list
  const cars = db.prepare(`
    SELECT ch.id, ch.value, cm.name model,
           (SELECT COUNT(*) FROM entries e WHERE e.chassis_id = ch.id
             AND e.season = (SELECT season FROM career WHERE id = 1)) entered
    FROM chassis ch
    JOIN car_models cm ON cm.id = ch.model_id
    JOIN teams t ON t.id = ch.owner_team_id
    WHERE t.owner_driver_id = ?`).all(me.id);

  const sellable = cars.reduce((n, c) => n + Math.round(c.value * 0.7), 0);
  const net = me.capital + sellable;

  return {
    capital: me.capital,
    cars: cars.length,
    sellable,
    net,
    passive: me.passive_income,
    state: me.capital >= 0 ? 'ok' : (net >= 0 ? 'must_sell' : 'ruined')
  };
}

// Called as a season turns over. Ruin is only declared at that point: inside a
// season a driver can still be paid, win something, or find a backer.
function callTheReceivers(db, season) {
  const s = solvency(db);
  if (!s || s.state !== 'ruined') return null;
  const already = db.prepare(`SELECT game_over_season g FROM career WHERE id = 1`).get().g;
  if (already) return { season: already, already: true };

  db.prepare(`UPDATE career SET game_over_season = ? WHERE id = 1`).run(season);
  db.prepare(`INSERT INTO news (season,week,category,headline,body) VALUES (?,1,'driver',?,?)`)
    .run(season, 'Your career is over',
         `You owe ${Math.abs(s.capital).toLocaleString('en-GB')} and everything you own `
         + `together is worth ${s.sellable.toLocaleString('en-GB')}. There is nothing left `
         + `to sell that would cover it, and nobody will put you in a car.`);
  return { season, ...s };
}

// ------------------------------------------------------------ yearly income
// Passive income lands in week 1, for everyone who is still racing.
function payPassive(db) {
  const c = db.prepare(`SELECT season, week FROM career WHERE id = 1`).get();
  const n = db.prepare(`
    UPDATE drivers SET capital = capital + passive_income WHERE status = 'active'`).run().changes;
  db.prepare(`INSERT INTO ledger (season,week,entity_type,entity_id,amount,reason)
      SELECT ?, ?, 'driver', id, passive_income, 'passive_income'
      FROM drivers WHERE status = 'active'`).run(c.season, c.week);
  return n;
}

module.exports = {
  roundCost, purseOf, settleRound, withdraw, absentEntries, chargePlayerRound,
  reviewSponsors, sponsorsOf, payPassive, slots, solvency, callTheReceivers,
  CREW_PRIVATEER, CREW_TEAM, TRAVEL_HOME, TRAVEL_AWAY, OVERDRAFT
};
