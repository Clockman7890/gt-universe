'use strict';

const $ = id => document.getElementById(id);
const show = id => {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
};
const view = id => {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(id).classList.add('active');
  if (id === 'hub') paint();
};
const eur = n => '€' + Number(n || 0).toLocaleString('en-GB');

const REP = ['Unproven', 'Known', 'Established', 'Respected', 'Legend'];
const repWord = r => REP[Math.min(4, Math.floor((r || 0) * 5))];

// ---------------------------------------------------------------- map art
// One generator, used dimmed behind the title and bright behind the hub.
function drawCity(canvas, dim) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  // everything below is authored for a 700 x 436 card and scaled up
  const k = Math.max(w / 700, h / 436);

  g.fillStyle = '#0B0C0F';
  g.fillRect(0, 0, w, h);

  // city blocks: density follows area, size follows scale
  const rnd = mulberry(20200614);
  for (const [angle, per1000, shade] of [[0.21, 1.9, 12], [-0.47, 1.1, 8]]) {
    const count = Math.round(per1000 * (w * h) / 1000);
    g.save();
    g.translate(w / 2, h / 2); g.rotate(angle); g.translate(-w / 2, -h / 2);
    for (let i = 0; i < count; i++) {
      const x  = rnd() * w * 1.7 - w * 0.35;
      const y  = rnd() * h * 1.7 - h * 0.35;
      const bw = (7 + rnd() * 19) * k;
      const bh = (6 + rnd() * 16) * k;
      const v  = 19 + Math.floor(rnd() * shade);
      g.fillStyle = `rgb(${v},${v + 2},${v + 8})`;
      g.fillRect(x, y, bw, bh);
    }
    g.restore();
  }

  // winding streets carved back out of the blocks
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
  // 1. gutter: a touch darker than the ground, so the cut reads as a trench
  g.strokeStyle = '#07080A'; g.lineWidth = 30 * k; trace();
  // 2. asphalt: lighter than the background, this is what makes it a road
  g.strokeStyle = '#22252C'; g.lineWidth = 24 * k; trace();
  // 3. centre line
  g.strokeStyle = '#3D424E'; g.lineWidth = Math.max(1.2, 1.6 * k); trace();

  // river across the bottom
  g.beginPath();
  g.moveTo(0, h * 0.90);
  g.quadraticCurveTo(w * .30, h * .845, w * .55, h * .90);
  g.quadraticCurveTo(w * .80, h * .955, w, h * .875);
  g.lineTo(w, h); g.lineTo(0, h); g.closePath();
  g.fillStyle = '#0E1218'; g.fill();
  g.beginPath();
  g.moveTo(0, h * 0.90);
  g.quadraticCurveTo(w * .30, h * .845, w * .55, h * .90);
  g.quadraticCurveTo(w * .80, h * .955, w, h * .875);
  g.strokeStyle = '#1B2735'; g.lineWidth = Math.max(1, 1.5 * k); g.stroke();

  if (dim) { g.fillStyle = 'rgba(11,12,15,0.74)'; g.fillRect(0, 0, w, h); }
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
  if ($('shell').classList.contains('active')) drawCity($('map-bg'), false);
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
  tutStep = (s.tutorial === undefined || s.tutorial === null) ? 4 : s.tutorial;
  $('n-market').textContent = s.career.week <= 4 ? 'open · new & used' : 'closed';
  const mkNode = document.querySelector('[data-go="market"]');
  mkNode.classList.toggle('locked', s.career.week > 4);

  const cars = await window.gt.garage();
  $('n-garage').textContent = cars.length
    ? `${cars.length} car${cars.length === 1 ? '' : 's'}` : 'no cars';
  const raceNode = document.querySelector('[data-go="race"]');
  raceNode.classList.toggle('locked', cars.length === 0);
  const rc = cars.length ? await window.gt.raceInfo() : null;
  raceNode.classList.toggle('live', !!(rc && rc.thisWeek));
  $('n-race').textContent = !cars.length ? 'no car'
    : rc ? (rc.thisWeek ? `${rc.track} · this weekend`
                        : `${rc.track} in ${rc.weeksAway} week${rc.weeksAway === 1 ? '' : 's'}`)
         : 'season over';
  const off = await window.gt.office();
  if (off) {
    mkNode.classList.toggle('due', off.open && !off.hasSeat);
    $('n-office').textContent = off.hasSeat
      ? (off.team ? off.team.name : 'contracted')
      : (off.seats.length ? `${off.seats.length} seats for sale` : 'no offers');
    document.querySelector('[data-go="office"]').classList.toggle('locked', !off.open && !off.team);
    const homeNode = document.querySelector('[data-go="home"]');
    homeNode.classList.toggle('hq', !!off.team);
    homeNode.classList.toggle('home', !off.team);
    $('n-home-label').textContent = off.team ? 'HQ' : 'Home';
    $('n-home').textContent = off.team ? `${off.team.name} · ${off.team.engineering}`
      : (cars.length ? `Privateer · ${cars[0].championship}` : 'No entry yet');
  }
  applyTutorial();
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
        for (const id of ['f-name','f-age','f-capital','f-passive','f-exp']) $(id).value = '';
        $('f-country').selectedIndex = 0;
        $('f-entry').selectedIndex = 0;
        show('create');
      } else if (!s.corrupt) {
        await window.gt.loadCareer(s.slot);
        show('shell'); view('hub'); refresh();
      }
    };
    box.appendChild(row);
  }
}

// ---------------------------------------------------------------- wiring
$('btn-create-back').onclick = () => { pendingSlot = null; show('title'); };
$('btn-settings').onclick = () => alert('Settings — not implemented yet.');
$('btn-exit-title').onclick = () => window.gt.quit();

// leaving the hub closes the career and returns to the title screen
$('to-menu').onclick = async () => {
  await window.gt.closeCareer();
  await refreshSaves();
  pendingSlot = null;
  show('title');
  paint();
};

function invalid() {
  const name = $('f-name').value.trim();
  const sel  = $('f-country').value;
  const age  = +$('f-age').value;
  const cap  = +$('f-capital').value;
  const pas  = +$('f-passive').value;
  const exp  = +$('f-exp').value;
  const gt5  = $('f-entry').value === 'gt5';
  if (!name)                        return 'Enter a driver name.';
  if (!sel)                         return 'Choose a nationality.';
  if (!(age >= 18 && age <= 50))    return 'Age must be between 18 and 50.';
  if (!(cap >= 150000 && cap <= 3000000)) return 'Starting capital must be between €150,000 and €3,000,000.';
  if (!(pas >= 10000 && pas <= 300000))   return 'Passive income must be between €10,000 and €300,000.';
  const lo = gt5 ? 0.60 : 0.50, hi = gt5 ? 0.70 : 0.60;
  if (!(exp >= lo && exp <= hi))    return `Driving experience must be between ${lo.toFixed(2)} and ${hi.toFixed(2)}.`;
  return null;
}

$('btn-create').onclick = async () => {
  if (!pendingSlot) return;
  const bad = invalid();
  if (bad) { alert(bad); return; }
  const [country, block] = $('f-country').value.split('|');
  try {
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
  show('shell'); view('hub');
  await refresh();
  tutStep = 0; applyTutorial();
  setTimeout(() => showTutorialPanel(0, async () => { await tutorialAdvance(1); }), 1000);
  } catch (err) {
    alert('Could not start the career:\n\n' + (err && err.message ? err.message : err));
  }
};

$('plaza').onclick = async () => { await window.gt.advance(); await refresh(); };
$('b-news').onclick = async () => { await openNews(); view('news'); };

document.querySelectorAll('.node').forEach(n => {
  n.onclick = async () => {
    if (n.classList.contains('locked')) return;
    if (tutStep < 4 && !n.classList.contains('focus')) return;
    const go = n.dataset.go;
    if (go === 'market')      { await openMarket(); view('market'); }
    else if (go === 'news')   { await openNews(); view('news'); }
    else if (go === 'garage') { await openGarage(); view('garage'); }
    else if (go === 'office') { await openOffice(); view('office'); }
    else if (go === 'home')   { await openHome(); view('home'); }
    else if (go === 'race')   { await openRace(); view('race'); }
    else {
      $('stub-title').textContent = n.querySelector('.label').textContent;
      $('stub-text').textContent  = 'Not built yet.';
      view('stub');
    }
  };
});
document.querySelectorAll('.back').forEach(b => b.onclick = () => leaveView(b.dataset.back));

async function leaveView(target) {
  view(target || 'hub');
  try {
    if (tutStep < 4) {
      let cars = 0;
      try { cars = (await window.gt.garage()).length; } catch (_) {}
      if (tutStep === 1) {
        if (entryDecided) await tutorialAdvance(2);
        else nudge('Choose how you will go racing first — privateer, or your own team.');
      } else if (tutStep === 2) {
        await tutorialAdvance(3, cars ? 3 : '3-nocar');
      } else if (tutStep === 3) {
        await tutorialAdvance(4);
      }
    }
  } catch (e) {
    console.error(e);
    // never leave the player staring at a step that will not move
    if (tutStep < 4) await tutorialAdvance(Math.min(4, tutStep + 1));
  }
  try { await refresh(); } catch (e) { console.error('refresh failed', e); }
}

// a one-line reminder when the player leaves a step unfinished
function nudge(text) {
  $('tut-title').textContent = 'Not finished yet';
  $('tut-text').innerHTML = `<p>${text}</p>` +
    `<p style="color:var(--text-muted);font-size:12px">` +
    `You can also skip the rest of the introduction and find your own way around.</p>`;
  $('tut-ok').textContent = 'Got it';
  $('tut').hidden = false;
  $('tut-ok').onclick = () => { $('tut').hidden = true; };
  const skip = $('tut-skip');
  if (skip) skip.onclick = async () => { $('tut').hidden = true; await tutorialAdvance(4); };
}

// ---------------------------------------------------------------- market
let mk = null, mkModel = null, mkLivery = null, mkTab = 'new';

async function openMarket() {
  mk = await window.gt.market();
  mkModel = null; mkLivery = null;
  $('tab-new').className  = 'tab ' + (mkTab === 'new'  ? 'on' : 'off');
  $('tab-used').className = 'tab ' + (mkTab === 'used' ? 'on' : 'off');
  $('tab-used').textContent = mk.used ? `Used · ${mk.used} listed` : 'Used';
  if (mkTab === 'used') { renderUsed(); return; }
  $('mk-deadline').textContent = mk.open
    ? `entry list closes at the end of week 4`
    : `closed — reopens next winter`;
  renderMarketList();
  // during the introduction the only way out is the named button, so the bare
  // arrow does not read as "cancel"
  const intro = tutStep === 2;
  const skipRow = $('mk-skip');
  if (skipRow) skipRow.hidden = !intro;
  const arrow = document.querySelector('#market .back');
  if (arrow) arrow.hidden = intro;
  $('mk-detail').innerHTML = mk.note
    ? `<p class="note">${mk.note}</p>`
    : `<p class="note">${mk.team
        ? mk.team + ' can enter another car — buy one, then sign a driver in the Office.'
        : (mk.canBuy ? 'Pick a car to enter the ' + mk.championship + '.'
                     : 'You already have a seat this season.')}</p>`;
}

function renderMarketList() {
  const box = $('mk-list');
  box.innerHTML = '';
  const order = ['gt3_gen2','gt3_gen1','gto','gt4','gt5'];
  const label = { gt3_gen2:'GT3', gt3_gen1:'GT3', gto:'GT3', gt4:'GT4', gt5:'GT5' };
  let last = null;
  for (const cls of order) {
    for (const m of mk.models.filter(x => x.cls === cls)) {
      if (label[cls] !== last) {
        const g = document.createElement('div');
        g.className = 'group'; g.textContent = label[cls];
        box.appendChild(g); last = label[cls];
      }
      const row = document.createElement('div');
      row.className = 'car' + (m.affordable ? '' : ' no') + (mkModel === m.id ? ' sel' : '');
      row.innerHTML = `<span>${m.name}</span><span class="sp"></span>` +
                      `<span class="price">${eur(m.price)}</span>`;
      row.onclick = () => selectCar(m);
      box.appendChild(row);
    }
  }
}

async function selectCar(m) {
  mkModel = m.id; mkLivery = null;
  renderMarketList();
  const [img, spec] = await Promise.all([window.gt.carImage(m.name), window.gt.carSpecs(m.name)]);
  const d = $('mk-detail');
  const specRow = (k, v) => `<div><span>${k}</span><span>${v}</span></div>`;
  d.innerHTML =
    `<h3>${m.name}</h3><div class="maker">${m.manufacturer} · ${m.liveries.length} entry number${m.liveries.length === 1 ? '' : 's'} free</div>` +
    (img ? `<img src="${img}" alt="">` : '') +
    (spec ? `<div class="specs">
        ${specRow('Power', spec.power_hp + ' HP')}${specRow('Torque', spec.torque_nm + ' Nm')}
        ${specRow('Weight', spec.weight_kg.toLocaleString('en-GB') + ' kg')}${specRow('Engine', spec.engine)}
        ${specRow('Drive', spec.drive + ' · ' + spec.gears + ' ' + spec.shift.toLowerCase())}
        ${specRow('Balance', spec.weight_dist)}</div>` : '') +
    (m.liveries.length ? `<div class="numbers">ENTRY NUMBER</div><div class="nums" id="mk-nums"></div>` : '') +
    `<div class="buyrow"><span class="big">${eur(m.price)}</span><span class="sp"></span>` +
    (m.affordable && mk.open && mk.canBuy
      ? `<span class="why" id="mk-hint"></span><button class="primary" id="mk-buy">Buy</button>`
      : `<span class="why">${m.why || (!mk.canBuy ? 'You already have a seat' : 'Market closed')}</span>`) +
    `</div>`;

  if (m.liveries.length) {
    const nums = $('mk-nums');
    m.liveries.forEach((lv, i) => {
      const b = document.createElement('span');
      b.className = 'num' + (i === 0 ? ' sel' : '');
      b.textContent = lv.livery_name;
      b.onclick = () => {
        mkLivery = lv.id;
        [...nums.children].forEach(c => c.classList.remove('sel'));
        b.classList.add('sel');
        const hint = $('mk-hint'); if (hint) hint.textContent = '';
      };
      nums.appendChild(b);
    });
    mkLivery = m.liveries[0].id;      // the first number is taken unless changed
  }
  const buy = $('mk-buy');
  if (buy) buy.onclick = async () => {
    if (!mkLivery) {
      const hint = $('mk-hint');
      if (hint) hint.textContent = 'Choose an entry number first';
      return;
    }
    try {
      const res = await window.gt.buyCar(mkModel, mkLivery);
      alert(`${res.model}\n${res.livery}\n\n` +
            (res.needsDriver ? 'Second car entered. Sign a driver in the Office.\n'
                             : `Entered the ${res.championship}.\n`) +
            `Spent ${eur(res.spent)} — ${eur(res.capital)} left.`);
      await refresh();
      await openMarket();
    } catch (err) {
      alert(err && err.message ? err.message.replace(/^Error: /, '') : String(err));
    }
  };
}

// ---------------------------------------------------------------- race weekend
let rcLeg = 1, rcData = null;

async function openRace() {
  const info = await window.gt.raceInfo();
  const box = $('rc-body');
  box.innerHTML = '';
  if (!info) {
    $('rc-when').textContent = '';
    box.innerHTML = '<p class="note">You are not entered in anything yet.</p>';
    return;
  }
  $('rc-when').textContent = info.thisWeek ? 'this weekend'
    : `${info.weeksAway} week${info.weeksAway === 1 ? '' : 's'} away`;

  const head = document.createElement('div');
  head.innerHTML =
    `<div class="rc-head">${info.championship} · round ${info.round}</div>` +
    `<div class="rc-sub">${info.track} · ${info.lengthKm} km lap · ` +
    `${info.gridSize} cars · week ${info.week}</div>`;
  box.appendChild(head);

  if (!info.thisWeek) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = 'Advance the week until the round comes round, then the setup and the ' +
                    'AI files will be ready here.';
    box.appendChild(p);
    return;
  }

  // ---- where the files go ----
  const dir = await window.gt.ams2Path();
  const bar = document.createElement('div');
  bar.className = 'pathbar';
  bar.innerHTML = dir
    ? `Custom AI folder: <code>${dir}</code>`
    : `<span class="warn">No Automobilista 2 folder set yet.</span>`;
  const pick = document.createElement('button');
  pick.textContent = dir ? 'Change folder' : 'Choose folder';
  pick.onclick = async () => { await window.gt.pickAms2(); await openRace(); };
  bar.appendChild(pick);
  box.appendChild(bar);

  // ---- leg tabs ----
  if (info.legs > 1) {
    const tabs = document.createElement('div');
    tabs.className = 'legtabs';
    for (let i = 1; i <= info.legs; i++) {
      const t = document.createElement('span');
      t.className = i === rcLeg ? 'on' : '';
      t.textContent = `Race ${i}`;
      t.onclick = async () => { rcLeg = i; await openRace(); };
      tabs.appendChild(t);
    }
    box.appendChild(tabs);
  }

  rcData = await window.gt.racePrepare(rcLeg);
  const d = rcData;
  const line = (k, v, warn) =>
    `<div class="line"><span>${k}</span><b class="${warn ? 'warn' : ''}">${v}</b></div>`;

  const setup = document.createElement('div');
  setup.className = 'setup';
  setup.innerHTML = `<h5>SINGLE RACE — COPY THESE SETTINGS</h5>` +
    line('Track', info.track) +
    line('Date', d.date) +
    line('Time of day', d.startTime) +
    line('Time progression', '×' + d.timeMultiplier) +
    line('AI opponents', d.aiOpponents) +
    line('Practice', d.practice + ' min') +
    (d.qualifying ? line('Qualifying', d.qualifying + ' min' +
        (d.qualifyingPrivate ? ' · private' : ' · public')) 
      : line('Qualifying', 'SKIP — start from the grid below', true)) +
    line('Race', d.distance + ' km · ' + d.laps + ' laps') +
    line('Mandatory pit stops', d.stops === 0 ? 'none'
        : d.stops + (d.window ? ` · window ${d.window[0] * 100}–${d.window[1] * 100}%` : '')) +
    line('Damage', d.damage) +
    line('Tyre wear', '×' + d.tyreWear) +
    line('Fuel usage', '×' + d.fuelUsage) +
    line('Your car', d.playerLivery || '—') +
    (d.playerGrid ? line('Your starting position', d.playerGrid, true) : '');
  box.appendChild(setup);

  const files = document.createElement('div');
  files.className = 'setup';
  files.innerHTML = `<h5>FILES TO WRITE</h5>` +
    d.files.map(f => `<div class="filelist"><code>${f.name}</code> — ` +
      `${(f.xml.match(/<driver /g) || []).length} entries</div>`).join('');
  box.appendChild(files);

  const actions = document.createElement('div');
  actions.className = 'rc-actions';

  const write = document.createElement('button');
  write.className = 'primary';
  write.textContent = 'Write AI files';
  write.disabled = !dir;
  write.onclick = async () => {
    try {
      const r = await window.gt.writeFiles(d.files);
      alert('Written to\n' + r.dir + '\n\n' +
            r.written.map(w => w.name + '  (' + w.bytes + ' bytes)').join('\n'));
    } catch (e) { alert(String(e.message || e).replace(/^Error: /, '')); }
  };
  actions.appendChild(write);

  const copy = document.createElement('button');
  copy.textContent = 'Copy settings';
  copy.onclick = () => {
    const txt = setup.innerText.replace(/\n{2,}/g, '\n');
    navigator.clipboard.writeText(txt).then(
      () => { copy.textContent = 'Copied'; setTimeout(() => copy.textContent = 'Copy settings', 1400); },
      () => alert('Could not reach the clipboard.'));
  };
  actions.appendChild(copy);
  box.appendChild(actions);
}

// ---------------------------------------------------------------- introduction
let tutStep = 4;                       // 4 means finished

const TUT = {
  0: { focus: null, title: 'Welcome to this journey, driver',
       html: `<p>You start with nothing but a name, a licence and whatever money you brought
                with you. Everything after that is yours to arrange.</p>
              <p>First, go to <b>Home</b>. There you decide how you will go racing: as a
                <b>privateer</b>, running one car on your own and hiring a crew race by race,
                or by founding your own <b>team</b>, which costs more up front but can enter
                several cars and take on drivers who pay for their seat.</p>
              <p>What you can afford depends on the money you have. Neither road is wrong.</p>` },
  1: { focus: 'home', title: 'Home', html: '' },
  2: { focus: 'market', title: 'Market',
       html: `<p>Now buy a car. Pick the model, then pick the entry number it will carry
                for the season.</p>
              <p>If you founded a team you may buy more than one, so long as the money lasts.</p>` },
  3: { focus: 'office', title: 'Office',
       html: `<p>The Office is where contracts live. If you did not buy a car, you can buy a
                <b>seat</b> from a team here instead — cheaper than running your own, but
                nothing belongs to you at the end of the season.</p>
              <p>If you run a team, this is also where you scout free drivers and offer them a
                seat. A driver from your own country brings local backing with him.</p>` },
  '3-nocar': { focus: 'office', title: 'Office',
       html: `<p>No car, then — and that is a perfectly good way to start. Here you can buy a
                <b>seat</b> from a team instead. It costs less than running your own car and
                the team carries the repair bills, but nothing belongs to you at the end of
                the season.</p>
              <p>The cheapest seats are listed first. A team from your own country brings
                local backing with it.</p>` },
  4: { focus: null, title: 'Good luck out there',
       html: `<p>Everything is open now. Advance the week when you are ready, and the season
                will come to you.</p>
              <p>Watch the money. The entry list closes at the end of week four, and nothing
                you own is worth anything if you cannot afford to run it.</p>` },
  '4-noseat': { focus: null, title: 'You still have no entry',
       html: `<p>Everything is open now, but you are not on any grid yet. The entry list
                closes at the end of <b>week four</b> — buy a car in the Market, or a seat
                in the Office, before then.</p>
              <p>Miss it and you sit out the season.</p>` }
};

function applyTutorial() {
  const hub = $('hub'), bar = $('bar');
  const done = tutStep >= 4;
  hub.classList.toggle('tut', !done);
  bar.classList.toggle('tut', !done);
  document.querySelectorAll('.node').forEach(n => n.classList.remove('focus', 'due'));
  if (done) return;
  const t = TUT[tutStep];
  if (t && t.focus) {
    const n = document.querySelector(`[data-go="${t.focus}"]`);
    if (n) { n.classList.add('focus', 'due'); n.classList.remove('locked'); }
  }
}

function showTutorialPanel(step, after) {
  const t = TUT[step];
  $('tut-title').textContent = t.title;
  $('tut-text').innerHTML = t.html;
  $('tut-ok').textContent = 'Got it';
  $('tut').hidden = false;
  $('tut-ok').onclick = async () => {
    $('tut').hidden = true;
    if (after) { try { await after(); } catch (e) { console.error(e); } }
  };
  const skip = $('tut-skip');
  if (skip) {
    skip.style.display = step === 4 || step === '4-noseat' ? 'none' : '';
    skip.onclick = async () => {
      $('tut').hidden = true;
      await tutorialAdvance(4);
      try { await refresh(); } catch (_) {}
    };
  }
}

async function tutorialAdvance(to, variant) {
  tutStep = to;                       // move on first; saving is best effort
  try { await window.gt.setTutorial(to); }
  catch (e) { console.error('tutorial save failed', e); }
  applyTutorial();
  if (to === 4) {
    const seated = (await window.gt.garage()).length || (await window.gt.office() || {}).hasSeat;
    setTimeout(() => showTutorialPanel(seated ? 4 : '4-noseat',
      async () => { applyTutorial(); }), 400);
  }
  else {
    const key = variant !== undefined ? variant : to;
    setTimeout(() => { const t = TUT[key]; if (t && t.html) showTutorialPanel(key); }, 900);
  }
}

// ---------------------------------------------------------------- home
const ENG_LABEL = { amateurs: 'Amateurs', experienced: 'Experienced', specialist: 'Specialist' };
let entryDecided = null;          // 'privateer' or 'team' once the player has chosen

async function openHome() {
  const h = await window.gt.home();
  const o = await window.gt.office();
  if (h.team) entryDecided = 'team';
  const box = $('hm-body');
  $('home-title').textContent = h.team ? 'Headquarters' : 'Home';
  $('hm-week').textContent = `Season ${h.season} · week ${h.week}`;
  box.innerHTML = '';

  const card = (title, rows) => {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `<h4>${title}</h4>` + rows.map(([k, v, cls]) =>
      `<div class="kv"><span>${k}</span><span class="${cls || ''}">${v}</span></div>`).join('');
    return el;
  };

  const cards = document.createElement('div');
  cards.className = 'cards';
  const d = h.driver;
  cards.appendChild(card('DRIVER', [
    ['Name', d.name], ['Nationality', d.country], ['Age', d.age],
    ['FIA rating', d.rating || 'Unrated'],
    ['Reputation', REP[Math.min(4, Math.floor((d.reputation || 0) * 5))]]
  ]));
  cards.appendChild(card('FINANCES', [
    ['Capital', eur(d.capital), d.capital < 0 ? 'warn' : ''],
    ['Passive income', eur(d.passive) + ' / year'],
    ['Net this season', (h.netThisSeason >= 0 ? '+' : '') + eur(h.netThisSeason),
      h.netThisSeason >= 0 ? 'good' : 'warn']
  ]));
  cards.appendChild(card('THIS SEASON', h.entry ? [
    ['Championship', h.entry.championship],
    ['Car', h.entry.car],
    ['Entry', h.entry.livery],
    ['Run by', h.entry.team],
    ['Status', h.entry.is_privateer ? 'Privateer' : 'Contracted driver']
  ] : [['Championship', o ? o.championship : '—'], ['Entry', 'none yet'],
       ['Status', 'no seat', 'warn']]));
  if (h.team) cards.appendChild(card('TEAM', [
    ['Name', h.team.name], ['Engineering', ENG_LABEL[h.team.engineering]],
    ['Cars owned', h.cars]
  ]));
  box.appendChild(cards);

  // ---- how you go racing ----
  if (!h.team && o) {
    const up = document.createElement('div');
    up.className = 'upgrade';
    up.innerHTML = `<h4>How will you go racing?</h4>` +
      `<p class="note">A <b>privateer</b> owns one car and hires a crew for each round — ` +
      `cheaper to start, every repair out of your own pocket. A <b>team</b> keeps its own ` +
      `engineering staff, can enter several cars and can take on drivers who pay for a seat.</p>`;

    const row = document.createElement('div');
    row.className = 'choice';

    const privOpt = document.createElement('div');
    privOpt.className = 'opt' + (entryDecided === 'privateer' ? ' sel' : '');
    privOpt.innerHTML = `<b>Privateer</b><span>No extra cost · one car · amateur crew</span>`;

    const teamOpt = document.createElement('div');
    const canTeam = o.canFormTeam && o.open;
    teamOpt.className = 'opt' + (canTeam ? '' : ' no') + (entryDecided === 'team' ? ' sel' : '');
    teamOpt.innerHTML = `<b>Create a team</b><span>` +
      (canTeam ? `From ${eur(Math.min(...Object.values(o.coreCost)))} · several cars`
               : `Needs ${eur(o.minCapital)} in capital`) + `</span>`;

    row.appendChild(privOpt); row.appendChild(teamOpt);
    up.appendChild(row);

    const detail = document.createElement('div');
    up.appendChild(detail);
    box.appendChild(up);

    privOpt.onclick = async () => {
      entryDecided = 'privateer';
      privOpt.classList.add('sel'); teamOpt.classList.remove('sel');
      detail.innerHTML = `<p class="note">You will run your own car. ` +
        `Buy one in the Market when you are ready.</p>`;
    };

    if (canTeam) teamOpt.onclick = () => {
      entryDecided = 'team';
      teamOpt.classList.add('sel'); privOpt.classList.remove('sel');
      detail.innerHTML =
        `<div class="namefield"><label>TEAM NAME</label>` +
        `<input id="hm-teamname" maxlength="34" placeholder="${d.name.split(' ').pop()} Racing"></div>` +
        `<p class="note">Now choose the engineering staff. Better people cost more every ` +
        `season but break down less and read the car better.</p>`;
      const eng = document.createElement('div');
      eng.className = 'eng';
      for (const [lvl, cost] of Object.entries(o.coreCost)) {
        const ok = cost <= d.capital;
        const el = document.createElement('div');
        el.className = 'opt' + (ok ? '' : ' no');
        el.innerHTML = `<b>${ENG_LABEL[lvl]}</b><span>${eur(cost)} one-off core</span>`;
        if (ok) el.onclick = async () => {
          const nm = ($('hm-teamname') && $('hm-teamname').value.trim()) || '';
          try {
            const r = await window.gt.formTeam(lvl, nm);
            alert(`${r.team} founded.\nEngineering: ${ENG_LABEL[r.engineering]}\n` +
                  `Cost ${eur(r.cost)} — ${eur(r.capital)} left.`);
            await refresh(); await openHome();
          } catch (e) { alert(String(e.message || e).replace(/^Error: /, '')); }
        };
        eng.appendChild(el);
      }
      detail.appendChild(eng);
    };
  }
}

// ---------------------------------------------------------------- news
const CAT = { market: 'Market', team: 'Team', driver: 'Driver',
              result: 'Result', manufacturer: 'Manufacturer' };

async function openNews() {
  const items = await window.gt.news();
  const box = $('nw-list');
  $('nw-count').textContent = items.length ? `${items.length} stories` : '';
  box.innerHTML = items.length ? '' : '<p class="note">Nothing has happened yet.</p>';
  for (const n of items) {
    const el = document.createElement('div');
    el.className = 'item' + (n.read ? '' : ' unread');
    el.innerHTML = `<div class="when">Season ${n.season} · week ${n.week} · ${CAT[n.category] || n.category}</div>` +
                   `<div class="title">${n.headline}</div>` +
                   (n.body ? `<div class="body">${n.body}</div>` : '');
    box.appendChild(el);
  }
  await window.gt.markRead();
  await refresh();
}

// ---------------------------------------------------------------- office
async function openOffice() {
  const o = await window.gt.office();
  const box = $('of-body');
  $('of-deadline').textContent = o.open
    ? 'contracts close at the end of week 4' : 'closed until the winter';
  box.innerHTML = '';
  if (!o) { box.innerHTML = '<p class="note">Nothing here yet.</p>'; return; }

  const h = (t) => { const d = document.createElement('div'); d.className = 'sect'; d.textContent = t; box.appendChild(d); };
  const p = (t) => { const d = document.createElement('p'); d.className = 'note'; d.innerHTML = t; box.appendChild(d); };

  // ---- paid drives -----------------------------------------------------
  if (!o.hasSeat) {
    h('PAID DRIVES — ' + o.championship.toUpperCase());
    const pc = o.privateerCost;
    if (pc && pc.car) p(
      `Running your own car costs ${eur(pc.car)} to buy plus ${eur(pc.crewLow)}–${eur(pc.crewHigh)} ` +
      `in crew hire over the season, and every repair is yours. ` +
      `A bought seat costs less and carries no risk, but you own nothing at the end of it.`);
    if (!o.seats.length) p('No team in this championship has a seat to sell.');
    for (const s of o.seats) {
      const el = document.createElement('div');
      el.className = 'offer' + (s.affordable && o.open ? '' : ' no');
      el.innerHTML = `<span class="who">${s.team}</span>` +
        `<span class="sub2">${s.car} · ${s.livery} · ${s.engineering}</span>` +
        (s.home ? '<span class="homeflag">home</span>' : '') +
        `<span class="sp"></span><span class="fee">${eur(s.fee)}</span>`;
      const b = document.createElement('button');
      b.textContent = 'Sign'; b.disabled = !(s.affordable && o.open);
      b.onclick = async () => {
        try {
          const r = await window.gt.takeSeat(s.entry_id);
          alert(`Signed with ${r.team}\n${r.car}\n\nSeat fee ${eur(r.fee)} — ${eur(r.capital)} left.`);
          await refresh(); await openOffice();
        } catch (e) { alert(String(e.message || e).replace(/^Error: /, '')); }
      };
      el.appendChild(b);
      box.appendChild(el);
    }
  }

  // ---- team ------------------------------------------------------------
  if (o.team) {
    h('YOUR TEAM');
    p(`<b>${o.team.name}</b> — engineering: ${o.team.engineering}`);
  }

  // ---- scouting --------------------------------------------------------
  if (o.team) {
    const mine = await window.gt.myEntries();
    const openSeats = mine.filter(e => e.filled < e.need);
    h('SCOUTING' + (openSeats.length ? '' : ' — no free seat in your cars'));
    if (!o.scouting.length) p('No free drivers in this region.');
    for (const d of o.scouting) {
      const el = document.createElement('div');
      el.className = 'offer' + (openSeats.length && o.open ? '' : ' no');
      el.innerHTML = `<span class="who">${d.name}</span>` +
        `<span class="sub2">${d.country} · ${d.age}` +
        (d.rating ? ` · ${d.rating}` : '') + `</span>` +
        (d.home ? '<span class="homeflag">home</span>' : '') +
        `<span class="sp"></span><span class="fee">pays ${eur(d.pays)}</span>`;
      const b = document.createElement('button');
      b.textContent = 'Offer seat'; b.disabled = !(openSeats.length && o.open);
      b.onclick = async () => {
        try {
          const r = await window.gt.signDriver(d.id, openSeats[0].id);
          alert(`${r.driver} signed.\nBrings ${eur(r.fee)} — you now have ${eur(r.capital)}.`);
          await refresh(); await openOffice();
        } catch (e) { alert(String(e.message || e).replace(/^Error: /, '')); }
      };
      el.appendChild(b);
      box.appendChild(el);
    }
  }
}

function renderUsed() {
  $('mk-list').innerHTML = '';
  $('mk-detail').innerHTML =
    `<div class="bubble"><b>No used cars yet</b><p>${mk.usedNote || ''}</p></div>`;
}

$('mk-skip').onclick = () => leaveView('hub');
$('tab-new').onclick  = async () => { mkTab = 'new';  await openMarket(); };
$('tab-used').onclick = async () => { mkTab = 'used'; await openMarket(); };

// ---------------------------------------------------------------- garage
async function openGarage() {
  const cars = await window.gt.garage();
  $('gr-count').textContent = cars.length
    ? `${cars.length} car${cars.length === 1 ? '' : 's'}` : '';
  const box = $('gr-list');
  box.innerHTML = '';
  if (!cars.length) {
    box.innerHTML = '<p class="note">No cars. Buy one in the Market, ' +
                    'or take a paid drive from the Office.</p>';
    return;
  }
  for (const c of cars) {
    const img = await window.gt.carImage(c.model);
    const eng = Math.min(1, c.engine_hours / 30);
    const cls = eng > .85 ? 'bad' : eng > .6 ? 'warn' : '';
    const el = document.createElement('div');
    el.className = 'gcar' + (c.mine ? '' : ' theirs');
    el.innerHTML =
      (img ? `<img src="${img}" alt="">` : '') +
      `<div class="info">
         <h3>${c.model}</h3>
         <div class="meta">${c.livery} · ${c.championship} · ${c.team}` +
         (c.mine ? ` · value ${eur(c.value)}` : '') +
         ` · ${c.driver ? c.driver : 'no driver yet'}</div>
         <div class="bar-wrap">Engine hours
           <div class="bar-out"><div class="bar-in ${cls}" style="width:${(eng*100).toFixed(0)}%"></div></div>
           ${c.engine_hours.toFixed(1)} / 30</div>
         <div class="tagline">` +
         (c.mine ? (c.driver ? 'Servicing and sale are handled here.'
                             : 'Needs a driver — sign one in the Office.')
                 : 'Team property — you can see its condition but cannot work on it.') +
         `</div></div>`;
    box.appendChild(el);
  }
}

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
