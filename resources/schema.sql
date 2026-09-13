-- ============================================================================
--  GT UNIVERSE — SQLite schema
--  AMS2 GT career manager.  Electron + better-sqlite3.
--  Conventions: money in whole euros, distances in km, times in ms,
--  skills and scalars as REAL, seasons numbered from 1.
-- ============================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;


-- ============================================================================
--  1. STATIC REFERENCE  (seeded once, never changes during a career)
-- ============================================================================

CREATE TABLE blocks (
  id                TEXT PRIMARY KEY,          -- 'trofeo_adriatico'
  name              TEXT NOT NULL,             -- 'Trofeo Adriatico GT5'
  continent         TEXT NOT NULL,             -- europe | americas | asia_pacific | africa_gulf
  production_weight REAL NOT NULL,             -- share of new drivers, 0..1
  passive_multiplier REAL NOT NULL DEFAULT 1.0 -- wealth of the region
);

CREATE TABLE countries (
  code       TEXT PRIMARY KEY,                 -- 'GRC'
  name       TEXT NOT NULL,
  block_id   TEXT NOT NULL REFERENCES blocks(id),
  weight     REAL NOT NULL                     -- share within its block
);

CREATE TABLE tracks (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,             -- exactly as AMS2 names it
  country    TEXT,
  length_km  REAL NOT NULL,
  max_grid   INTEGER NOT NULL                  -- hard cap from the game
);

CREATE TABLE manufacturers (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  customer_only INTEGER NOT NULL DEFAULT 0     -- 1 = never offers works support (Nissan, Ginetta, Ultima)
);

CREATE TABLE car_models (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,         -- 'BMW M4 GT3'
  manufacturer_id INTEGER REFERENCES manufacturers(id),
  class          TEXT NOT NULL,                -- gt5 | gt4 | gt3_gen1 | gt3_gen2 | gto | lmdh
  ai_file        TEXT NOT NULL,                -- 'GT3_Gen2.xml' — where its entries are written
  price_new      INTEGER,                     -- NULL = never sold (LMDh, ARC franchise cars)
  purchasable    INTEGER NOT NULL DEFAULT 1,
  running_cost_index REAL NOT NULL DEFAULT 1.0,
  works_support  INTEGER NOT NULL DEFAULT 1,   -- 0 = no factory backing available
  -- measured BoP baseline (Barcelona, uniform 0.85 drivers)
  base_weight_scalar REAL NOT NULL DEFAULT 1.0,
  base_power_scalar  REAL NOT NULL DEFAULT 1.0,
  base_drag_scalar   REAL NOT NULL DEFAULT 1.0,
  bop_drift_min      REAL NOT NULL DEFAULT -0.030,  -- GTO cars get 0.000 here
  bop_drift_max      REAL NOT NULL DEFAULT  0.030
);

CREATE TABLE liveries (
  id          INTEGER PRIMARY KEY,
  model_id    INTEGER NOT NULL REFERENCES car_models(id),
  livery_name TEXT NOT NULL,                   -- verbatim AMS2 string, incl. '#36b' and ' - A.Maia Skin'
  sponsor_level TEXT NOT NULL DEFAULT 'medium',-- low | medium | high; low goes to privateers first
  UNIQUE (model_id, livery_name)
);

-- one row per tier, holds the session format
CREATE TABLE championship_levels (
  id                TEXT PRIMARY KEY,          -- gt5 | gt4 | gt3_sprint | gt3_endurance | lmdh | igtc
  races_per_round   INTEGER NOT NULL,
  distance_km       INTEGER NOT NULL,          -- per race, or per leg for two-leg formats
  two_leg           INTEGER NOT NULL DEFAULT 0,
  drivers_per_car   INTEGER NOT NULL DEFAULT 1,
  practice_minutes  INTEGER NOT NULL,
  qualifying_minutes INTEGER NOT NULL,
  qualifying_private INTEGER NOT NULL DEFAULT 0,
  pole_points       INTEGER NOT NULL DEFAULT 0,
  mandatory_stops   INTEGER NOT NULL DEFAULT 0,   -- per race or per leg
  pit_window_from   REAL,                         -- 0.40 = 40% distance; NULL = free
  pit_window_to     REAL,
  latest_start      TEXT                          -- '14:00' for GT5, NULL otherwise
);

-- these never change and are printed on every race card
CREATE TABLE sim_constants (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  time_multiplier   INTEGER NOT NULL DEFAULT 2,
  tyre_wear         REAL NOT NULL DEFAULT 1.0,
  fuel_usage        REAL NOT NULL DEFAULT 1.0,
  damage            TEXT NOT NULL DEFAULT 'full'
);

CREATE TABLE championships (
  id            TEXT PRIMARY KEY,              -- 'gtwc_europe_sprint'
  name          TEXT NOT NULL,
  level_id      TEXT NOT NULL REFERENCES championship_levels(id),
  class         TEXT NOT NULL,                 -- gt5 | gt4 | gt3 | lmdh
  model_id      INTEGER REFERENCES car_models(id),  -- one-make tiers only (GT5)
  home_continent TEXT NOT NULL,
  prestige      REAL NOT NULL,                 -- 1.00 European, 0.55 Africa & ME ...
  rounds        INTEGER NOT NULL,
  min_grid      INTEGER NOT NULL DEFAULT 10,
  winter        INTEGER NOT NULL DEFAULT 0,    -- 1 = runs weeks 5-10
  active_from   INTEGER NOT NULL DEFAULT 1     -- season it first appears (GT3 = 2, LMDh = 7)
);

CREATE TABLE championship_blocks (             -- which driver blocks feed a championship
  championship_id TEXT NOT NULL REFERENCES championships(id),
  block_id        TEXT NOT NULL REFERENCES blocks(id),
  PRIMARY KEY (championship_id, block_id)
);

CREATE TABLE championship_tracks (             -- the fixed calendar template
  championship_id TEXT NOT NULL REFERENCES championships(id),
  round_no        INTEGER NOT NULL,
  track_id        INTEGER NOT NULL REFERENCES tracks(id),
  week            INTEGER NOT NULL,            -- week of the season year
  distance_override INTEGER,                   -- for the two big events
  PRIMARY KEY (championship_id, round_no)
);

CREATE TABLE points_scheme (
  level_id  TEXT NOT NULL REFERENCES championship_levels(id),
  position  INTEGER NOT NULL,
  points    INTEGER NOT NULL,
  PRIMARY KEY (level_id, position)
);


-- ============================================================================
--  2. CAREER STATE
-- ============================================================================

CREATE TABLE career (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  created_at        TEXT NOT NULL,
  season            INTEGER NOT NULL DEFAULT 1,
  week              INTEGER NOT NULL DEFAULT 1,
  calendar_year     INTEGER NOT NULL DEFAULT 2020,  -- internal only, drives in-game weather
  player_driver_id  INTEGER,                        -- FK set after generation
  player_team_id    INTEGER,
  player_championship_id TEXT,           -- the seat being held for them
  ams2_path         TEXT,
  tutorial_step     INTEGER NOT NULL DEFAULT 0,  -- 0 welcome, 1 home, 2 market, 3 office, 4 done
  time_multiplier   INTEGER NOT NULL DEFAULT 2
);

CREATE TABLE seasons (
  season        INTEGER PRIMARY KEY,
  calendar_year INTEGER NOT NULL,
  closed        INTEGER NOT NULL DEFAULT 0
);


-- ============================================================================
--  3. PEOPLE
-- ============================================================================

CREATE TABLE drivers (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  country       TEXT NOT NULL REFERENCES countries(code),
  block_id      TEXT NOT NULL REFERENCES blocks(id),
  birth_year    INTEGER NOT NULL,
  is_player     INTEGER NOT NULL DEFAULT 0,
  origin        TEXT NOT NULL DEFAULT 'gt5',   -- gt5 | formula_graduate
  fia_rating    TEXT,                          -- NULL while still in GT5
  reputation    REAL NOT NULL DEFAULT 0.0,     -- 0..1, mapped to Unproven..Legend
  capital       INTEGER NOT NULL,
  passive_income INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',-- active | unemployed | retired
  retired_season INTEGER,
  watchlist_manufacturer_id INTEGER REFERENCES manufacturers(id),
  test_invites  INTEGER NOT NULL DEFAULT 0,
  shootout_wins INTEGER NOT NULL DEFAULT 0,
  -- hidden ceilings, one per family
  pot_speed     REAL NOT NULL,
  pot_judgement REAL NOT NULL,
  pot_stamina   REAL NOT NULL
);

-- live AMS2 attributes, one row per driver, rewritten every season
CREATE TABLE driver_skills (
  driver_id                    INTEGER PRIMARY KEY REFERENCES drivers(id),
  race_skill                   REAL NOT NULL,
  qualifying_skill             REAL NOT NULL,
  wet_skill                    REAL NOT NULL,
  start_reactions              REAL NOT NULL,
  aggression                   REAL NOT NULL,
  defending                    REAL NOT NULL,
  consistency                  REAL NOT NULL,
  stamina                      REAL NOT NULL,
  avoidance_of_mistakes        REAL NOT NULL,
  avoidance_of_forced_mistakes REAL NOT NULL,
  tyre_management              REAL NOT NULL,
  fuel_management              REAL NOT NULL,
  weather_tyre_changes         REAL NOT NULL,
  blue_flag_conceding          REAL NOT NULL DEFAULT 0.0
);

CREATE TABLE driver_history (                  -- one row per driver per season
  driver_id     INTEGER NOT NULL REFERENCES drivers(id),
  season        INTEGER NOT NULL,
  age           INTEGER NOT NULL,
  fia_rating    TEXT,
  championship_id TEXT REFERENCES championships(id),
  rounds_run    INTEGER NOT NULL DEFAULT 0,
  rounds_total  INTEGER NOT NULL DEFAULT 0,
  wins          INTEGER NOT NULL DEFAULT 0,
  podiums       INTEGER NOT NULL DEFAULT 0,
  points        INTEGER NOT NULL DEFAULT 0,
  final_position INTEGER,
  speed_gain    REAL NOT NULL DEFAULT 0,       -- applied at week 50
  promo_penalty REAL NOT NULL DEFAULT 0,       -- -0.050 / -0.030, halved to 65% inside a team
  PRIMARY KEY (driver_id, season)
);


-- ============================================================================
--  4. TEAMS, CARS, MONEY
-- ============================================================================

CREATE TABLE teams (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  country        TEXT NOT NULL REFERENCES countries(code),
  block_id       TEXT NOT NULL REFERENCES blocks(id),
  founded_season INTEGER NOT NULL,
  is_privateer   INTEGER NOT NULL DEFAULT 0,   -- 1 = single owner-driver, rented crew
  owner_driver_id INTEGER REFERENCES drivers(id),
  partner_driver_id INTEGER REFERENCES drivers(id),  -- 50% shareholder
  capital        INTEGER NOT NULL,
  engineering    TEXT NOT NULL DEFAULT 'amateurs', -- amateurs | experienced | specialist
  facilities     TEXT NOT NULL DEFAULT 'gt5',      -- highest tier the workshop is fit for
  goals          TEXT NOT NULL DEFAULT 'normal',   -- max_pressure | normal | low_pressure
  status         TEXT NOT NULL DEFAULT 'active',   -- active | distress | folded
  folded_season  INTEGER
);

-- an individual car with a history; scalars can differ per chassis
CREATE TABLE chassis (
  id              INTEGER PRIMARY KEY,
  model_id        INTEGER NOT NULL REFERENCES car_models(id),
  owner_team_id   INTEGER REFERENCES teams(id),
  bought_season   INTEGER NOT NULL,
  bought_new      INTEGER NOT NULL DEFAULT 1,
  value           INTEGER NOT NULL,            -- current book value
  engine_hours    REAL NOT NULL DEFAULT 0,     -- rebuild due at 30
  chassis_hours   REAL NOT NULL DEFAULT 0,     -- refresh due every 2 seasons
  dev_bonus       REAL NOT NULL DEFAULT 0,     -- team development, cumulative cap 0.30s, lost on sale
  wins            INTEGER NOT NULL DEFAULT 0,
  for_sale        INTEGER NOT NULL DEFAULT 0,
  asking_price    INTEGER
);

CREATE TABLE manufacturer_programs (
  manufacturer_id INTEGER NOT NULL REFERENCES manufacturers(id),
  season          INTEGER NOT NULL,
  class           TEXT NOT NULL,               -- gt3 | lmdh
  budget          INTEGER NOT NULL,
  drift_direction INTEGER NOT NULL DEFAULT 0,  -- -1/0/+1, max two seasons the same way
  drift_streak    INTEGER NOT NULL DEFAULT 0,
  lmdh_team_id    INTEGER REFERENCES teams(id),-- NULL = manufacturer sits the season out
  PRIMARY KEY (manufacturer_id, season, class)
);

CREATE TABLE ledger (                          -- every euro that moves
  id          INTEGER PRIMARY KEY,
  season      INTEGER NOT NULL,
  week        INTEGER NOT NULL,
  entity_type TEXT NOT NULL,                   -- driver | team | manufacturer
  entity_id   INTEGER NOT NULL,
  amount      INTEGER NOT NULL,                -- signed
  reason      TEXT NOT NULL                    -- seat_fee | prize | dnf | repair | salary | ...
);


-- ============================================================================
--  5. ENTRIES AND RESULTS
-- ============================================================================

CREATE TABLE entries (
  id              INTEGER PRIMARY KEY,
  season          INTEGER NOT NULL,
  championship_id TEXT NOT NULL REFERENCES championships(id),
  team_id         INTEGER NOT NULL REFERENCES teams(id),
  chassis_id      INTEGER NOT NULL REFERENCES chassis(id),
  livery_id       INTEGER NOT NULL REFERENCES liveries(id),
  class_cup       TEXT,                        -- pro | gold | silver | bronze | NULL below GT3
  works_support   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (season, championship_id, livery_id)
);

CREATE TABLE entry_drivers (
  entry_id  INTEGER NOT NULL REFERENCES entries(id),
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  role      INTEGER NOT NULL,                  -- 1 = driver A, 2 = driver B, 3 = one-off hire
  seat_fee  INTEGER NOT NULL DEFAULT 0,        -- what the driver pays (negative = salary)
  PRIMARY KEY (entry_id, driver_id)
);

CREATE TABLE rounds (                          -- resolved calendar for one season
  id              INTEGER PRIMARY KEY,
  season          INTEGER NOT NULL,
  event_type      TEXT NOT NULL DEFAULT 'championship',
                  -- championship | invitational | young_test | shootout | guest_seat
  championship_id TEXT REFERENCES championships(id),   -- NULL for special events
  round_no        INTEGER NOT NULL,
  track_id        INTEGER NOT NULL REFERENCES tracks(id),
  week            INTEGER NOT NULL,
  race_date       TEXT NOT NULL,               -- ISO date given to AMS2 for weather
  grid_size       INTEGER NOT NULL,
  mixed_with      TEXT,                        -- 'gt4', 'gt3' or 'lmdh' on the shared events
  played          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (season, event_type, championship_id, round_no)
);

CREATE TABLE legs (                            -- one race, or one half of an endurance round
  id           INTEGER PRIMARY KEY,
  round_id     INTEGER NOT NULL REFERENCES rounds(id),
  leg_no       INTEGER NOT NULL,               -- 1 or 2
  distance_km  INTEGER NOT NULL,
  laps         INTEGER NOT NULL,
  race_date    TEXT,                          -- each race of a weekend has its own day
  start_time   TEXT NOT NULL,                  -- 'HH:MM' handed to AMS2
  practice_min INTEGER NOT NULL DEFAULT 0,
  quali_min    INTEGER NOT NULL DEFAULT 0,
  ai_opponents INTEGER NOT NULL,               -- entries - 1 when the player races
  skip_quali   INTEGER NOT NULL DEFAULT 0,
  player_grid  INTEGER,                        -- set manually in AMS2 on leg 2
  files_written TEXT,                          -- 'GT3.xml,GT3_Gen2.xml'
  simulated    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (round_id, leg_no)
);

CREATE TABLE results (
  id          INTEGER PRIMARY KEY,
  leg_id      INTEGER NOT NULL REFERENCES legs(id),
  entry_id    INTEGER NOT NULL REFERENCES entries(id),
  driver_id   INTEGER NOT NULL REFERENCES drivers(id),
  grid_pos    INTEGER,
  finish_pos  INTEGER,
  status      TEXT NOT NULL DEFAULT 'finished',-- finished | dnf_mechanical | dnf_incident | dns
  best_lap_ms INTEGER,
  points      REAL NOT NULL DEFAULT 0,
  damage_cost INTEGER NOT NULL DEFAULT 0,
  UNIQUE (leg_id, entry_id)
);

-- per-model scalars actually written to XML for a given season
CREATE TABLE car_performance (
  model_id      INTEGER NOT NULL REFERENCES car_models(id),
  season        INTEGER NOT NULL,
  weight_scalar REAL NOT NULL,
  power_scalar  REAL NOT NULL,
  drag_scalar   REAL NOT NULL,
  bop_drift     REAL NOT NULL DEFAULT 0,
  dev_bonus     REAL NOT NULL DEFAULT 0,       -- manufacturer investment, permanent
  clamped       INTEGER NOT NULL DEFAULT 0,    -- 1 if a value hit 0.900 / 1.100
  PRIMARY KEY (model_id, season)
);


-- a one-weekend mechanical shortfall, applied on top of car_performance
CREATE TABLE weekend_faults (
  round_id     INTEGER NOT NULL REFERENCES rounds(id),
  entry_id     INTEGER NOT NULL REFERENCES entries(id),
  power_delta  REAL NOT NULL,                  -- -0.010 to -0.030
  diagnosed    INTEGER NOT NULL DEFAULT 0,     -- 1 only if engineering = specialist
  repair_cost  INTEGER,
  repaired     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (round_id, entry_id)
);

-- driver absences: illness or injury, never racing related
CREATE TABLE absences (
  id            INTEGER PRIMARY KEY,
  driver_id     INTEGER NOT NULL REFERENCES drivers(id),
  season        INTEGER NOT NULL,
  from_round    INTEGER NOT NULL,
  rounds_missed INTEGER NOT NULL,              -- 1 to 3
  reason        TEXT NOT NULL,
  cover_driver_id INTEGER REFERENCES drivers(id)
);


-- ============================================================================
--  6. EVENTS, OFFERS, NEWS
-- ============================================================================

CREATE TABLE offers (                          -- everything the Office shows
  id          INTEGER PRIMARY KEY,
  season      INTEGER NOT NULL,
  week        INTEGER NOT NULL,
  kind        TEXT NOT NULL,                   -- seat | renewal | guest_seat | invitational | partner_exit
  driver_id   INTEGER REFERENCES drivers(id),
  team_id     INTEGER REFERENCES teams(id),
  championship_id TEXT REFERENCES championships(id),
  cost        INTEGER NOT NULL DEFAULT 0,
  fee         INTEGER NOT NULL DEFAULT 0,      -- what the player is paid, if anything
  expires_week INTEGER NOT NULL,
  state       TEXT NOT NULL DEFAULT 'open'     -- open | accepted | declined | expired
);

CREATE TABLE news (
  id       INTEGER PRIMARY KEY,
  season   INTEGER NOT NULL,
  week     INTEGER NOT NULL,
  category TEXT NOT NULL,                      -- result | market | team | driver | manufacturer
  headline TEXT NOT NULL,
  body     TEXT,
  read     INTEGER NOT NULL DEFAULT 0
);


-- ============================================================================
--  7. INDEXES
-- ============================================================================

CREATE INDEX idx_results_leg      ON results(leg_id);
CREATE INDEX idx_results_driver   ON results(driver_id);
CREATE INDEX idx_entries_season   ON entries(season, championship_id);
CREATE INDEX idx_rounds_week      ON rounds(season, week);
CREATE INDEX idx_ledger_entity    ON ledger(entity_type, entity_id, season);
CREATE INDEX idx_news_week        ON news(season, week);
CREATE INDEX idx_chassis_owner    ON chassis(owner_team_id);
CREATE INDEX idx_drivers_status   ON drivers(status);
CREATE INDEX idx_liveries_model   ON liveries(model_id);
CREATE INDEX idx_absences_season  ON absences(season, driver_id);
CREATE INDEX idx_rounds_type      ON rounds(season, event_type);


-- ============================================================================
--  8. VIEWS  (standings are derived, never stored)
-- ============================================================================

CREATE VIEW v_driver_standings AS
SELECT r.season, ro.championship_id, res.driver_id,
       SUM(res.points) AS points,
       SUM(res.finish_pos = 1) AS wins
FROM results res
JOIN legs l   ON l.id = res.leg_id
JOIN rounds ro ON ro.id = l.round_id
JOIN rounds r  ON r.id = ro.id
WHERE ro.event_type = 'championship'
GROUP BY r.season, ro.championship_id, res.driver_id;

CREATE VIEW v_team_standings AS
SELECT ro.season, ro.championship_id, e.team_id,
       SUM(res.points) AS points
FROM results res
JOIN legs l    ON l.id = res.leg_id
JOIN rounds ro ON ro.id = l.round_id
JOIN entries e ON e.id = res.entry_id
WHERE ro.event_type = 'championship'
GROUP BY ro.season, ro.championship_id, e.team_id;

CREATE VIEW v_manufacturer_standings AS
SELECT ro.season, ro.championship_id, cm.manufacturer_id,
       SUM(res.points) AS points
FROM results res
JOIN legs l     ON l.id = res.leg_id
JOIN rounds ro  ON ro.id = l.round_id
JOIN entries e  ON e.id = res.entry_id
JOIN chassis ch ON ch.id = e.chassis_id
JOIN car_models cm ON cm.id = ch.model_id
WHERE ro.event_type = 'championship'
GROUP BY ro.season, ro.championship_id, cm.manufacturer_id;
