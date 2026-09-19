'use strict';

// Deterministic PRNG so a career always regenerates identically from its seed.
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

// Pick one item with a weight on each. Used for the country a new driver comes
// from: an even roll across a block's countries makes Albania as productive as
// Italy, which is not a world anyone recognises.
const pickWeighted = (r, arr, weightOf) => {
  let total = 0;
  for (const x of arr) total += Math.max(0, weightOf(x)) || 0;
  if (total <= 0) return pick(r, arr);
  let roll = r() * total;
  for (const x of arr) {
    roll -= Math.max(0, weightOf(x)) || 0;
    if (roll <= 0) return x;
  }
  return arr[arr.length - 1];
};

// Icelandic patronymics need the father's given name in the genitive.
const GENITIVE = {
  Jon: 'Jons', Gunnar: 'Gunnars', Olafur: 'Olafs', Sigurdur: 'Sigurdar',
  Einar: 'Einars', Bjarni: 'Bjarna', Arnar: 'Arnars', Kristjan: 'Kristjans',
  Magnus: 'Magnusar', Halldor: 'Halldors', Petur: 'Peturs', Stefan: 'Stefans'
};
const TUSSEN = ['van', 'van der', 'de', 'van den', 'ter'];

class NameFactory {
  // db: the parsed names_db.json
  constructor(db, seed = 1) {
    this.db = db;
    this.r = rng(seed);
    this.used = new Set();
  }

  // Birth year decides how modern the given name sounds.
  given(code, birthYear) {
    const d = this.db[code];
    const era = Math.min(1, Math.max(0, (birthYear - 1985) / 20));
    return pick(this.r, this.r() < era ? d.modern : d.classic);
  }

  surname(code, first) {
    const d = this.db[code], r = this.r;
    switch (d.rule) {
      case 'double': {
        if (d.surnames.length >= 2 && r() < 0.55) {
          const a = pick(r, d.surnames);
          let b = pick(r, d.surnames);
          let guard = 0;
          while (b === a && guard++ < 8) b = pick(r, d.surnames);
          return `${a} ${b}`;
        }
        return pick(r, d.surnames);
      }
      case 'patronymic': {
        const father = pick(r, d.classic);
        const stem = GENITIVE[father] || father + 's';
        return stem + 'son';
      }
      case 'dutch':
        return r() < 0.35 ? `${pick(r, TUSSEN)} ${pick(r, d.surnames)}`
                          : pick(r, d.surnames);
      case 'slavic':
      case 'plain':
      default:
        return pick(r, d.surnames);
    }
  }

  // Unique full name; falls back to a middle initial when a pool runs dry.
  driver(code, birthYear) {
    for (let i = 0; i < 40; i++) {
      const g = this.given(code, birthYear);
      const s = this.surname(code, g);
      const full = `${g} ${s}`;
      if (!this.used.has(full)) { this.used.add(full); return full; }
    }
    const g = this.given(code, birthYear);
    const s = this.surname(code, g);
    const letters = 'ABCDEFGHIJKLMNOPRSTVW';
    for (const c of letters) {
      const full = `${g} ${c}. ${s}`;
      if (!this.used.has(full)) { this.used.add(full); return full; }
    }
    const full = `${g} ${s} ${this.used.size}`;
    this.used.add(full);
    return full;
  }
}

// ---------------------------------------------------------------- teams
const ABSTRACT = ['Apex','Vertex','Meridian','Zenith','Kestrel','Onyx','Quartz','Vantage',
  'Halcyon','Sable','Corvid','Ardent','Nimbus','Thorn','Ember','Lumen','Cobalt','Verge',
  'Solstice','Tempest','Cinder','Harrier','Vector','Pinnacle','Alloy','Drift','Slate','Falco'];
const PLACES = ['Northgate','Redhill','Ashford','Bramwell','Castleton','Highmoor','Kingsway',
  'Lakeview','Millbrook','Oakridge','Ravenscourt','Southwell','Thornbury','Westmere','Brackley',
  'Hallam','Fenwick','Larkhill','Norwood','Stonebridge'];
const SUFFIX = ['Racing','Motorsport','Autosport','Competition','Racing Team','Motorsports',
  'Engineering','Sport','Racing Engineering'];

class TeamFactory {
  constructor(seed = 2) { this.r = rng(seed); this.used = new Set(); }

  make(founderSurname) {
    const r = this.r;
    for (let i = 0; i < 40; i++) {
      const roll = r();
      let name;
      if (roll < 0.28 && founderSurname) {
        name = `${founderSurname.split(' ').pop()} ${pick(r, SUFFIX)}`;
      } else if (roll < 0.50) {
        name = `${pick(r, ABSTRACT)} ${pick(r, SUFFIX)}`;
      } else if (roll < 0.70) {
        name = `${pick(r, PLACES)} ${pick(r, SUFFIX)}`;
      } else if (roll < 0.85) {
        name = `${pick(r, ABSTRACT)} ${1 + Math.floor(r() * 98)}`;
      } else {
        let a = pick(r, ABSTRACT), b = pick(r, ABSTRACT);
        let guard = 0;
        while (b === a && guard++ < 8) b = pick(r, ABSTRACT);
        name = `${a} ${b}`;
      }
      if (!this.used.has(name)) { this.used.add(name); return name; }
    }
    const name = `${pick(r, ABSTRACT)} ${this.used.size}`;
    this.used.add(name);
    return name;
  }

  // "Ghost Racing by Lamborghini" for a works entry
  factory(team, manufacturer) { return `${team} by ${manufacturer}`; }
}

module.exports = { rng, pick, pickWeighted, NameFactory, TeamFactory };
