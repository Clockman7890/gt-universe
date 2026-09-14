'use strict';
// Automobilista 2 publishes its session over the Project CARS 2 shared memory
// block, "$pcars2$". Reading a Windows memory-mapped file from Node would need
// a native add-on, and every one of those has to be rebuilt against Electron.
// Windows already ships .NET, which opens the same block in four lines, so the
// read is handed to PowerShell and comes back as base64. No compiler, no
// rebuild, nothing extra in the installer.
//
//   0   unsigned int  mVersion
//   4   unsigned int  mBuildVersionNumber
//   8   unsigned int  mGameState
//  12   unsigned int  mSessionState
//  16   unsigned int  mRaceState
//  20   int           mViewedParticipantIndex
//  24   int           mNumParticipants
//  28   ParticipantInfo[64]        (100 bytes each)
//
// ParticipantInfo: mIsActive at 0 (1 byte + 3 padding), mName at 1 (64 bytes),
// mWorldPosition at 68, mCurrentLapDistance at 80, mRacePosition at 84,
// mLapsCompleted at 88, mCurrentLap at 92, mCurrentSector at 96.

const { execFileSync } = require('child_process');

const MAP_NAME = '$pcars2$';
const HEADER = 28;
const PART_SIZE = 100;
const MAX_PARTICIPANTS = 64;
const READ_BYTES = HEADER + PART_SIZE * MAX_PARTICIPANTS;   // 6428

const GAME_STATE = ['exited', 'front_end', 'ingame_playing', 'ingame_paused',
                    'ingame_inmenu_time_ticking', 'ingame_restarting',
                    'ingame_replay', 'front_end_replay'];
const SESSION_STATE = ['invalid', 'practice', 'test', 'qualify', 'formation_lap',
                       'race', 'time_attack'];
const RACE_STATE = ['invalid', 'not_started', 'racing', 'finished',
                    'disqualified', 'retired', 'dnf'];

// Single quotes around the map name so PowerShell leaves the dollar signs be.
const SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "try { $mmf=[System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting('" + MAP_NAME + "') }",
  "catch { Write-Output 'NOTRUNNING'; exit 0 }",
  "try {",
  "  $acc=$mmf.CreateViewAccessor(0," + READ_BYTES + ",[System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)",
  "  $b=New-Object byte[] " + READ_BYTES,
  "  [void]$acc.ReadArray(0,$b,0," + READ_BYTES + ")",
  "  [Convert]::ToBase64String($b)",
  "  $acc.Dispose()",
  "} catch { Write-Output ('ERROR:' + $_.Exception.Message) }",
  "finally { $mmf.Dispose() }"
].join('\n');

function grab() {
  if (process.platform !== 'win32') return { ok: false, reason: 'unsupported' };
  let out;
  try {
    out = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim();
  } catch (e) {
    return { ok: false, reason: 'error', message: String(e.message).split('\n')[0] };
  }
  if (out === 'NOTRUNNING') return { ok: false, reason: 'not_running' };
  if (out.startsWith('ERROR:')) return { ok: false, reason: 'error', message: out.slice(6) };

  const buf = Buffer.from(out.replace(/\s+/g, ''), 'base64');
  if (buf.length < READ_BYTES) return { ok: false, reason: 'short_read', got: buf.length };
  return { ok: true, buf };
}

// The course car occupies a participant slot but is not in the race.
const isCourseCar = n => /^(safety|pace|course)\b/i.test(String(n || '').trim());

const cstr = (buf, at, len) => {
  const end = buf.indexOf(0, at);
  const stop = end === -1 || end > at + len ? at + len : end;
  return buf.toString('latin1', at, stop).trim();
};

function read() {
  const got = grab();
  if (!got.ok) return got;

  const b = got.buf;
  const version = b.readUInt32LE(0);
  const numParticipants = b.readInt32LE(24);

  // If the layout ever moved, the numbers stop making sense here, long before
  // anything reaches the career.
  if (numParticipants < 0 || numParticipants > MAX_PARTICIPANTS)
    return { ok: false, reason: 'bad_layout', version, numParticipants };

  const participants = [];
  for (let i = 0; i < Math.min(numParticipants, MAX_PARTICIPANTS); i++) {
    const at = HEADER + i * PART_SIZE;
    const name = cstr(b, at + 1, 64);
    if (isCourseCar(name)) continue;
    participants.push({
      index: i,
      active: b.readUInt8(at) !== 0,
      name,
      position: b.readUInt32LE(at + 84),
      lapsCompleted: b.readUInt32LE(at + 88),
      currentLap: b.readUInt32LE(at + 92)
    });
  }

  const named = participants.filter(p => p.name);
  const printable = named.filter(p => /^[\x20-\x7E]+$/.test(p.name));
  if (named.length && printable.length < named.length / 2)
    return { ok: false, reason: 'bad_layout', version, numParticipants,
             sample: named.slice(0, 3).map(p => p.name) };

  return {
    ok: true, version,
    build: b.readUInt32LE(4),
    gameState: GAME_STATE[b.readUInt32LE(8)] || b.readUInt32LE(8),
    sessionState: SESSION_STATE[b.readUInt32LE(12)] || b.readUInt32LE(12),
    raceState: RACE_STATE[b.readUInt32LE(16)] || b.readUInt32LE(16),
    viewed: b.readInt32LE(20),
    numParticipants: participants.length,
    slots: numParticipants,
    participants
  };
}

let snapshot = null;      // the last reading that looked like a finished race

function remember(s) {
  if (!s.ok || !s.participants.length) return;
  // Keep the last table from a race session. Once the flag falls the block is
  // cleared within moments, so the reading taken just before is what survives.
  if (s.sessionState === 'race')
    snapshot = { at: Date.now(), sessionState: s.sessionState,
                 raceState: s.raceState, participants: s.participants };
}

function classification() {
  let s = read();
  remember(s);

  // The game clears the block as soon as it leaves the session, so a player who
  // skipped to the end and walked away would find nothing. Fall back to the
  // last table that still had a classification in it.
  if ((!s.ok || !s.participants.length) && snapshot) {
    s = { ok: true, fromSnapshot: true, ageSeconds: Math.round((Date.now() - snapshot.at) / 1000),
          sessionState: snapshot.sessionState, raceState: snapshot.raceState,
          numParticipants: snapshot.participants.length, participants: snapshot.participants };
  }
  if (!s.ok) return s;

  // Laps down says nothing: in an endurance race, or on a mixed grid, a car two
  // laps behind the leader is simply a slower class doing its job. The only
  // honest signals are the slot going inactive and the position being unset.
  const order = s.participants
    .filter(p => p.name)
    .map(p => ({ name: p.name, position: p.position, laps: p.lapsCompleted,
                 retired: !p.active || !p.position }))
    .sort((a, b) => (a.position || 999) - (b.position || 999));

  // Mid-race every car has a position, so only the session flag, or the block
  // having gone away after a good reading, says the race is actually over.
  return Object.assign(s, {
    finished: s.raceState === 'finished' || !!s.fromSnapshot,
    order
  });
}

// A cheap check the interface can poll.
function status() {
  const out = { platform: process.platform, state: 'unavailable' };
  if (process.platform !== 'win32') {
    out.detail = 'Shared memory is a Windows feature.';
    return out;
  }
  let s;
  try { s = read(); remember(s); }
  catch (e) { out.state = 'error'; out.detail = e.message; return out; }

  if (!s.ok && snapshot) {
    out.state = 'ready';
    out.participants = snapshot.participants.length;
    out.detail = `Holding the last classification — ${snapshot.participants.length} cars, ` +
                 `read ${Math.round((Date.now() - snapshot.at) / 1000)}s ago. Ready to use.`;
    return out;
  }
  if (!s.ok) {
    out.state = s.reason === 'not_running' ? 'closed' : 'error';
    out.detail = s.reason === 'not_running'
      ? 'Automobilista 2 is not running, or Shared Memory is not set to Project CARS 2.'
      : s.reason === 'bad_layout'
        ? `Found the block but it does not read as expected (version ${s.version}, ` +
          `${s.numParticipants} participants).`
        : (s.message || s.reason);
    if (s.sample) out.sample = s.sample;
    return out;
  }

  out.version = s.version;
  out.sessionState = s.sessionState;
  out.raceState = s.raceState;
  out.participants = s.numParticipants;
  const done = s.raceState === 'finished';
  out.state = done ? 'ready' : 'live';
  out.detail = done
    ? `Classification complete — ${s.numParticipants} cars, ready to read.`
    : `${s.sessionState}, ${s.raceState} — ${s.numParticipants} cars` +
      (s.slots > s.numParticipants ? ' (course car ignored)' : '') + '.';
  return out;
}

module.exports = { read, classification, status, MAP_NAME, READ_BYTES };
