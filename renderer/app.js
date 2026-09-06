'use strict';

const $ = id => document.getElementById(id);
const show = id => {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
};
const eur = n => '€' + Number(n || 0).toLocaleString('en-GB');

const REP = ['Unproven', 'Known', 'Established', 'Respected', 'Legend'];
const repWord = r => REP[Math.min(4, Math.floor((r || 0) * 5))];

// ---------------------------------------------------------------- map art
// One generator, used dimmed behind the title and bright behind the hub.
function drawCity(canvas, dim) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  g.fillStyle = '#0B0C0F';
  g.fillRect(0, 0, w, h);

  // irregular blocks, two rotations so no grid reads through
  const rnd = mulberry(20200614);
  for (const [angle, count, shade] of [[0.21, 260, 12], [-0.47, 170, 8]]) {
    g.save();
    g.translate(w / 2, h / 2); g.rotate(angle); g.translate(-w / 2, -h / 2);
    for (let i = 0; i < count; i++) {
      const x = rnd() * w * 1.6 - w * 0.3;
      const y = rnd() * h * 1.6 - h * 0.3;
      const bw = 14 + rnd() * 34, bh = 12 + rnd() * 30;
      const v = 19 + Math.floor(rnd() * shade);
      g.fillStyle = `rgb(${v},${v + 2},${v + 8})`;
      g.fillRect(x, y, bw, bh);
    }
    g.restore();
  }

  // winding streets carved out of the blocks
  const roads = [
    [[0, .28], [.2, .2], [.45, .4], [.7, .34], [1, .18]],
    [[0, .70], [.18, .74], [.42, .58], [.7, .66], [1, .76]],
    [[.14, 0], [.17, .28], [.09, .46], [.16, .72], [.18, 1]],
    [[.67, 0], [.64, .22], [.73, .38], [.71, .58], [.76, 1]],
    [[0, .48], [.26, .52], [.5, .46], [.74, .54], [1, .48]],
    [[.36, 0], [.39, .18], [.31, .32], [.34, .52], [.30, 1]]
  ];
  const trace = () => {
    for (const pts of roads) {
      g.beginPath();
      g.moveTo(pts[0][0] * w, pts[0][1] * h);
      for (let i = 1; i < pts.length - 1; i++) {
        const cx = pts[i][0] * w, cy = pts[i][1] * h;
        const nx = (pts[i][0] + pts[i + 1][0]) / 2 * w;
        const ny = (pts[i][1] + pts[i + 1][1]) / 2 * h;
        g.quadraticCurveTo(cx, cy, nx, ny);
      }
      const l = pts[pts.length - 1];
      g.lineTo(l[0] * w, l[1] * h);
      g.stroke();
    }
  };
  g.lineCap = 'round';
  g.strokeStyle = '#0B0C0F'; g.lineWidth = 30; trace();
  g.strokeStyle = '#31353F'; g.lineWidth = 1.2; trace();

  // river along the bottom
  g.beginPath();
  g.moveTo(0, h * 0.90);
  g.quadraticCurveTo(w * .3, h * .84, w * .55, h * .90);
  g.quadraticCurveTo(w * .8, h * .96, w, h * .88);
  g.lineTo(w, h); g.lineTo(0, h); g.closePath();
  g.fillStyle = '#0E1218'; g.fill();

  if (dim) { g.fillStyle = 'rgba(11,12,15,0.72)'; g.fillRect(0, 0, w, h); }
}

function mulberry(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function paint() {
  drawCity($('title-bg'), true);
  if ($('hub').classList.contains('active')) drawCity($('map-bg'), false);
}
window.addEventListener('resize', paint);

// ---------------------------------------------------------------- state
async function refresh() {
  const s = await window.gt.state();
  if (!s) return;
  const d = s.driver || {};
  $('b-money').textContent  = eur(d.capital);
  $('b-season').textContent = `Season ${s.career.season} · week ${s.career.week}`;
  $('b-rating').textContent = d.fia_rating || 'Unrated';
  $('b-rep').textContent    = repWord(d.reputation);
  $('b-count').textContent  = s.unread || 0;
  $('b-count').style.display = s.unread ? '' : 'none';
  $('p-next').textContent   = `→ week ${s.career.week + 1 > 52 ? 1 : s.career.week + 1}`;
  $('region').textContent   = (d.country || '').toUpperCase();
  $('n-market').textContent = s.career.week <= 4 ? 'open · new & used' : 'closed';
}

let pendingSlot = null;   // which slot a new career is being created into

async function refreshSaves() {
  const slots = await window.gt.listSaves();
  const newest = slots
    .filter(s => !s.empty)
    .sort((a, b) => b.mtime - a.mtime)[0];

  const box = $('slots');
  box.innerHTML = '';

  for (const s of slots) {
    const row = document.createElement('div');
    row.className = 'slot' + (s.empty ? ' empty' : '')
                  + (newest && newest.slot === s.slot ? ' newest' : '');

    const n = document.createElement('span');
    n.className = 'n'; n.textContent = 'SLOT ' + s.slot;
    row.appendChild(n);

    const who = document.createElement('span');
    who.className = 'who';
    const where = document.createElement('span');
    where.className = 'where';

    if (s.empty) {
      who.textContent = 'Empty — start a new career';
    } else if (s.corrupt) {
      who.textContent = 'Damaged save';
      where.textContent = 'cannot be opened';
    } else {
      who.textContent = s.meta.driver || 'Unnamed driver';
      where.textContent = `${s.meta.country || ''} · Season ${s.meta.season} · wk ${s.meta.week}`;
    }
    row.appendChild(who); row.appendChild(where);

    const sp = document.createElement('span'); sp.className = 'sp'; row.appendChild(sp);

    if (!s.empty) {
      const del = document.createElement('span');
      del.className = 'del'; del.textContent = 'Delete';
      del.onclick = async ev => {
        ev.stopPropagation();
        if (await window.gt.deleteSlot(s.slot)) refreshSaves();
      };
      row.appendChild(del);
    }

    row.onclick = async () => {
      if (s.empty) {
        pendingSlot = s.slot;
        $('slot-tag').textContent = '— slot ' + s.slot;
        show('create');
      } else if (!s.corrupt) {
        await window.gt.loadCareer(s.slot);
        show('hub'); paint(); refresh();
      }
    };
    box.appendChild(row);
  }
}

// ---------------------------------------------------------------- wiring
$('btn-create-back').onclick = () => { pendingSlot = null; show('title'); };
$('btn-settings').onclick = () => alert('Settings — not implemented yet.');
$('btn-exit-title').onclick = () => window.gt.quit();
$('exit').onclick = () => window.gt.quit();

$('btn-create').onclick = async () => {
  if (!pendingSlot) return;
  const [country, block] = $('f-country').value.split('|');
  await window.gt.newCareer(pendingSlot, {
    name: $('f-name').value.trim() || 'Driver',
    country, block,
    age: +$('f-age').value,
    capital: +$('f-capital').value,
    passiveIncome: +$('f-passive').value,
    entry: $('f-entry').value,
    experience: +$('f-exp').value
  });
  pendingSlot = null;
  show('hub'); paint(); refresh();
};

$('plaza').onclick = async () => { await window.gt.advance(); refresh(); };
$('b-save').onclick = async () => { await window.gt.saveNow(); };

document.querySelectorAll('.node').forEach(n => {
  n.onclick = () => {
    if (n.classList.contains('locked')) return;
    const label = n.querySelector('.label').textContent;
    console.log('open screen:', label);       // screens land here next
  };
});

// entry level switches the allowed experience range
$('f-entry').onchange = e => {
  const gt5 = e.target.value === 'gt5';
  const f = $('f-exp');
  f.min = gt5 ? 0.60 : 0.50;
  f.max = gt5 ? 0.70 : 0.60;
  f.value = gt5 ? 0.65 : 0.55;
};

(async () => {
  const p = await window.gt.paths();
  $('version').textContent = 'v' + p.version;
  await refreshSaves();
  paint();
})();
