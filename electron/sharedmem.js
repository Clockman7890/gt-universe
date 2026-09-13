'use strict';
// Automobilista 2 publishes its session over the Project CARS 2 shared memory
// block, named "$pcars2$". Only the head of that block is read here: the
// version, the session and race state, and the participant table. Those offsets
// have been stable since pCars2 and are the only ones this needs.
//
//   0   unsigned int  mVersion
//   4   unsigned int  mBuildVersionNumber
//   8   unsigned int  mGameState
//  12   unsigned int  mSessionState
//  16   unsigned int  mRaceState
//  20   int           mViewedParticipantIndex
//  24   int           mNumParticipants
//  28   ParticipantInfo[64]
//
// ParticipantInfo is 100 bytes:
//   0   bool          mIsActive          (1 byte, then 3 of padding)
//   1   char[64]      mName
//  68   float[3]      mWorldPosition
//  80   float         mCurrentLapDistance
//  84   unsigned int  mRacePosition
//  88   unsigned int  mLapsCompleted
//  92   unsigned int  mCurrentLap
//  96   int           mCurrentSector

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

let koffi = null, kernel32 = null, fns = null;

function load() {
  if (fns) return fns;
  if (process.platform !== 'win32')
    throw new Error('The shared memory block only exists on Windows.');
  koffi = require('koffi');
  kernel32 = koffi.load('kernel32.dll');
  fns = {
    OpenFileMappingA: kernel32.func('__stdcall', 'OpenFileMappingA',
      'void *', ['uint32', 'bool', 'str']),
    MapViewOfFile: kernel32.func('__stdcall', 'MapViewOfFile',
      'void *', ['void *', 'uint32', 'uint32', 'uint32', 'size_t']),
    UnmapViewOfFile: kernel32.func('__stdcall', 'UnmapViewOfFile',
      'bool', ['void *']),
    CloseHandle: kernel32.func('__stdcall', 'CloseHandle', 'bool', ['void *'])
  };
  return fns;
}

// Pull the head of the block into an ordinary Buffer, then let Node decode it.
function grab() {
  const f = load();
  const FILE_MAP_READ = 0x0004;
  const handle = f.OpenFileMappingA(FILE_MAP_READ, false, MAP_NAME);
  if (!handle)
    return { ok: false, reason: 'not_running' };

  let view = null;
  try {
    view = f.MapViewOfFile(handle, FILE_MAP_READ, 0, 0, READ_BYTES);
    if (!view) return { ok: false, reason: 'no_view' };
    const buf = Buffer.from(koffi.decode(view, koffi.array('uint8', READ_BYTES, 'Array')));
    return { ok: true, buf };
  } finally {
    if (view) f.UnmapViewOfFile(view);
    f.CloseHandle(handle);
  }
}

const cstr = (buf, at, len) => {
  const end = buf.indexOf(0, at);
  const stop = end === -1 || end > at + len ? at + len : end;
  return buf.toString('latin1', at, stop).trim();
};

function read() {
  let got;
  try { got = grab(); }
  catch (e) { return { ok: false, reason: 'error', message: e.message }; }
  if (!got.ok) return got;

  const b = got.buf;
  const version = b.readUInt32LE(0);
  const numParticipants = b.readInt32LE(24);

  // If the layout ever moves, this is where it shows: the numbers stop making
  // sense long before anything is written to the career.
  if (numParticipants < 0 || numParticipants > MAX_PARTICIPANTS)
    return { ok: false, reason: 'bad_layout', version, numParticipants };

  const participants = [];
  for (let i = 0; i < Math.min(numParticipants, MAX_PARTICIPANTS); i++) {
    const at = HEADER + i * PART_SIZE;
    const name = cstr(b, at + 1, 64);
    participants.push({
      index: i,
      active: b.readUInt8(at) !== 0,
      name,
      position: b.readUInt32LE(at + 84),
      lapsCompleted: b.readUInt32LE(at + 88),
      currentLap: b.readUInt32LE(at + 92)
    });
  }

  const printable = participants.filter(p => p.name && /^[\x20-\x7E]+$/.test(p.name));
  if (participants.length && printable.length < participants.length / 2)
    return { ok: false, reason: 'bad_layout', version, numParticipants,
             sample: participants.slice(0, 3).map(p => p.name) };

  return {
    ok: true,
    version,
    build: b.readUInt32LE(4),
    gameState: GAME_STATE[b.readUInt32LE(8)] || b.readUInt32LE(8),
    sessionState: SESSION_STATE[b.readUInt32LE(12)] || b.readUInt32LE(12),
    raceState: RACE_STATE[b.readUInt32LE(16)] || b.readUInt32LE(16),
    viewed: b.readInt32LE(20),
    numParticipants,
    participants
  };
}

// The finishing order, once the session has actually finished.
function classification() {
  const s = read();
  if (!s.ok) return s;

  // Laps down says nothing: in an endurance race, or on a mixed grid, a car two
  // laps behind the leader is simply a slower class doing its job. The only
  // honest signals are the slot going inactive and the position being unset.
  const order = s.participants
    .filter(p => p.name)
    .map(p => ({
      name: p.name,
      position: p.position,
      laps: p.lapsCompleted,
      retired: !p.active || !p.position
    }))
    .sort((a, b) => (a.position || 999) - (b.position || 999));

  return Object.assign(s, { finished: s.raceState === 'finished', order });
}

// A cheap check the interface can poll: is the library there, is the game
// running, and is there anything worth reading yet.
function status() {
  const out = { platform: process.platform, koffi: false, state: 'unavailable' };
  if (process.platform !== 'win32') {
    out.detail = 'Shared memory is a Windows feature.';
    return out;
  }
  try {
    require.resolve('koffi');
    out.koffi = true;
  } catch (_) {
    out.detail = 'The koffi library is missing from this build.';
    return out;
  }
  let s;
  try { s = read(); }
  catch (e) { out.state = 'error'; out.detail = e.message; return out; }

  if (!s.ok) {
    out.state = s.reason === 'not_running' ? 'closed' : 'error';
    out.detail = s.reason === 'not_running'
      ? 'Automobilista 2 is not running, or Shared Memory is not set to Project CARS 2.'
      : (s.message || s.reason);
    if (s.sample) out.sample = s.sample;
    return out;
  }

  out.version = s.version;
  out.sessionState = s.sessionState;
  out.raceState = s.raceState;
  out.participants = s.numParticipants;
  out.state = s.raceState === 'finished' ? 'ready' : 'live';
  out.detail = s.raceState === 'finished'
    ? `Session finished — ${s.numParticipants} cars, ready to read.`
    : `${s.sessionState}, ${s.raceState} — ${s.numParticipants} cars.`;
  return out;
}

module.exports = { read, classification, status, MAP_NAME };
