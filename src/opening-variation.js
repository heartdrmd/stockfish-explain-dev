// opening-variation.js — engine move variation for the first N forks
// of a practice game. All logic is self-contained; main.js just asks
// "should I vary here? if yes, pick a candidate" and wires the answer
// into the existing practice engine-turn block.
//
// Core mechanic:
//   - User sets N (max forks), think-time, tolerance curve, dev-weight
//     strength in the Deviation settings panel.
//   - During practice, each engine turn INSIDE the window (forkIndex < N)
//     runs a Skill-20, MultiPV-5, long-movetime search.
//   - Candidates within tolerance of best are collected. Anti-repetition
//     weights (from Postgres or localStorage) bias AWAY from recent plays.
//   - Deviation-probability decides if #1 is picked (no deviation) or
//     the tail of the distribution (real deviation). Probability tapers
//     across the N-fork window (strong early → near-best late).
//   - Pick recorded to Postgres (logged-in) or localStorage (guest).
//   - After N forks: engine reverts to user's skill/time/style.
//
// Public surface used by main.js:
//   getSettings()                   → resolved settings object
//   saveSettings(obj)               → persist
//   resetSettings()                 → restore defaults
//   startSession(openingName, eco)  → call before first engine turn
//   isActive()                      → in-window?
//   consumeFork()                   → increments the counter; returns
//                                     { forkIndex, tolerance, devProb, thinkMs }
//   pickCandidate(topMoves, fen)    → async, returns uci (or null to fall
//                                     back to default behaviour)
//   recordPlay(fen, uci)            → async, persists the choice
//   fetchHistoryForFen(fen)         → async → [{uci, times_played, ...}]
//   resetOpeningMemory(name)        → async, wipes one opening's memory
//   openingReport(name)             → async → [{fen, uci, times_played, ...}]

const LS_SETTINGS_KEY = 'stockfish-explain.variation-settings';
const LS_MEMORY_KEY   = 'stockfish-explain.variation-memory'; // guest fallback

const DEFAULTS = Object.freeze({
  enabled:         false,
  maxForks:        5,           // 1..15 — opportunity window (engine moves considered)
  maxDeviations:   3,           // 1..15 — hard cap on actual non-#1 picks
  thinkMs:         30_000,      // 15s..120s
  earlyTolerance:  50,          // 10..100 cp
  tighten:         true,
  lateTolerance:   10,          // 5..50 cp (only used if tighten)
  devWeight:       'strong',    // 'mild' | 'medium' | 'strong'
  varietyBias:     'moderate',  // 'even' | 'mild' | 'moderate' | 'strong'
  rememberMemory:  true,
});

// varietyBias → k value in gapScore formula: weight = 1 / (1 + gap/k).
// Smaller k = steeper penalty on further-from-best candidates.
//  even = 300  → gap-50 gets 86% weight  (candidates near-equal)
//  mild = 100  → gap-50 gets 67% weight
//  moderate =50 → gap-50 gets 50% weight (current default)
//  strong = 25 → gap-50 gets 33% weight  (heavy bias to close-to-best)
const VARIETY_BIAS_K = { even: 300, mild: 100, moderate: 50, strong: 25 };

// devWeight → (earlyDeviationProb, lateDeviationProb). "Deviation
// probability" = how likely the picker is to choose a NON-#1 candidate
// at a given fork (after tolerance filtering). Tapers linearly across
// the N-fork window.
const DEV_WEIGHT_CURVE = {
  mild:   [0.50, 0.15],
  medium: [0.65, 0.18],
  strong: [0.80, 0.20],
};

// ─── Settings persistence ──────────────────────────────────────────

export function getSettings() {
  try {
    const raw = localStorage.getItem(LS_SETTINGS_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch { return { ...DEFAULTS }; }
}

export function saveSettings(partial) {
  const cur = getSettings();
  const merged = { ...cur, ...partial };
  try { localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(merged)); } catch {}
  return merged;
}

export function resetSettings() {
  try { localStorage.removeItem(LS_SETTINGS_KEY); } catch {}
  return { ...DEFAULTS };
}

// ─── Session state (per practice game) ─────────────────────────────

let _session = null;

export function startSession(openingName, openingEco) {
  const s = getSettings();
  _session = {
    active:          !!s.enabled,
    forkIndex:       0,   // how many engine-move opportunities consumed
    deviationsUsed:  0,   // how many of those ended in actual non-#1 pick
    recordedOk:      0,   // successful POST/localStorage recordings
    recordedFailed:  0,   // failed recordings (network/auth error etc.)
    maxForks:        Math.min(Math.max(1, +s.maxForks || 1), 15),
    maxDeviations:   Math.min(Math.max(1, +s.maxDeviations || 3), 15),
    thinkMs:         Math.min(Math.max(5_000, +s.thinkMs || 30_000), 120_000),
    earlyTol:    Math.min(Math.max(5, +s.earlyTolerance || 50), 200),
    lateTol:     s.tighten ? Math.min(Math.max(3, +s.lateTolerance || 10), 100) : null,
    devCurve:    DEV_WEIGHT_CURVE[s.devWeight] || DEV_WEIGHT_CURVE.strong,
    varietyK:    VARIETY_BIAS_K[s.varietyBias] || VARIETY_BIAS_K.moderate,
    remember:    !!s.rememberMemory,
    openingName: openingName || null,
    openingEco:  openingEco  || null,
  };
  console.log('[variation] session start', {
    enabled: _session.active,
    opening: openingName,
    maxForks: _session.maxForks,
    maxDeviations: _session.maxDeviations,
    thinkMs: _session.thinkMs,
    devCurve: _session.devCurve,
    tolerance: { early: _session.earlyTol, late: _session.lateTol },
    varietyK: _session.varietyK,
    remember: _session.remember,
  });
  return _session;
}

export function endSession() {
  if (_session) {
    console.log('[variation] session end', {
      opening: _session.openingName,
      forksConsumed: _session.forkIndex,
      deviationsUsed: _session.deviationsUsed,
      recordedOk: _session.recordedOk,
      recordedFailed: _session.recordedFailed,
    });
  }
  _session = null;
}

export function isActive() {
  if (!_session || !_session.active) return false;
  if (_session.forkIndex >= _session.maxForks) return false;
  if (_session.deviationsUsed >= _session.maxDeviations) return false;
  return true;
}

// Called by main.js after pickCandidate returns an actual deviation
// (picked a non-#1 candidate). Bumps the deviation counter; when it
// reaches maxDeviations, isActive() returns false on subsequent forks.
export function noteDeviation() {
  if (_session) _session.deviationsUsed++;
}

// Consume one fork and return the per-fork parameters. Call this
// BEFORE asking the engine to analyse. Do not call pickCandidate
// without first calling consumeFork — the picker relies on the
// per-fork taper it computes here.
export function consumeFork() {
  if (!_session || !_session.active) return null;
  if (_session.forkIndex >= _session.maxForks) return null;
  const i = _session.forkIndex;
  const n = _session.maxForks;
  // taper factor: 0 at fork 1, 1 at fork N. With n=1 we guard → always 0 (full early).
  const t = n > 1 ? i / (n - 1) : 0;
  const tolerance = _session.lateTol != null
    ? Math.round(_session.earlyTol + t * (_session.lateTol - _session.earlyTol))
    : _session.earlyTol;
  const devProb = _session.devCurve[0] + t * (_session.devCurve[1] - _session.devCurve[0]);
  _session.forkIndex++;
  const params = {
    forkIndex:    i + 1,              // 1-indexed for display
    forksPlanned: n,
    tolerance,
    devProb,
    varietyK: _session.varietyK,
    thinkMs: _session.thinkMs,
  };
  console.log('[variation] consumeFork', {
    ...params,
    deviationsUsed: _session.deviationsUsed,
    maxDeviations: _session.maxDeviations,
  });
  return params;
}

// ─── Memory (Postgres for logged-in, localStorage for guests) ──────

function loadGuestMemory() {
  try { return JSON.parse(localStorage.getItem(LS_MEMORY_KEY) || '{}'); }
  catch { return {}; }
}
function saveGuestMemory(obj) {
  try { localStorage.setItem(LS_MEMORY_KEY, JSON.stringify(obj)); } catch {}
}

function isLoggedIn() { return !!window.__currentUser; }

export async function fetchHistoryForFen(fen) {
  if (!_session || !_session.remember) return [];
  if (isLoggedIn()) {
    try {
      const r = await fetch('/api/variations/fen/' + encodeURIComponent(fen),
        { credentials: 'include' });
      if (!r.ok) return [];
      const j = await r.json();
      return j.entries || [];
    } catch { return []; }
  }
  const mem = loadGuestMemory();
  const byFen = mem[fen] || {};
  return Object.entries(byFen).map(([uci, v]) => ({
    uci,
    times_played: v.times || 1,
    last_played: v.at || null,
  }));
}

// prefixMoves: space-separated UCI chain from the game's starting
// position to (but not including) `fen`. Stored alongside the record
// so the report can rebuild an ECO tree with shared-prefix grouping.
export async function recordPlay(fen, uci, prefixMoves = null) {
  if (!_session) { console.warn('[variation] recordPlay ignored — no session'); return; }
  if (!_session.remember) {
    console.log('[variation] recordPlay skipped — remember=false', { fen: fen.slice(0, 30) + '…', uci });
    return;
  }
  const opName = _session.openingName;
  const opEco  = _session.openingEco;
  if (isLoggedIn()) {
    try {
      const r = await fetch('/api/variations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fen, uci, opening_name: opName, opening_eco: opEco, prefix_moves: prefixMoves }),
      });
      if (r.ok) {
        _session.recordedOk++;
        console.log('[variation] recordPlay cloud OK', { uci, prefixLen: prefixMoves ? prefixMoves.split(/\s+/).length : 0 });
      } else {
        _session.recordedFailed++;
        console.warn('[variation] recordPlay cloud NON-OK', { status: r.status, uci });
      }
    } catch (err) {
      _session.recordedFailed++;
      console.warn('[variation] recordPlay POST failed', err);
    }
  } else {
    try {
      const mem = loadGuestMemory();
      if (!mem[fen]) mem[fen] = {};
      const cur = mem[fen][uci] || { times: 0, opName, opEco };
      cur.times = (cur.times || 0) + 1;
      cur.at = new Date().toISOString();
      cur.opName = opName || cur.opName;
      cur.opEco  = opEco  || cur.opEco;
      if (prefixMoves) cur.prefix = prefixMoves;
      mem[fen][uci] = cur;
      saveGuestMemory(mem);
      _session.recordedOk++;
      console.log('[variation] recordPlay guest OK', { uci, timesNow: cur.times });
    } catch (err) {
      _session.recordedFailed++;
      console.warn('[variation] recordPlay guest save failed', err);
    }
  }
}

export async function resetOpeningMemory(openingName) {
  if (isLoggedIn()) {
    try {
      const r = await fetch('/api/variations/opening/' + encodeURIComponent(openingName),
        { method: 'DELETE', credentials: 'include' });
      return r.ok;
    } catch { return false; }
  }
  const mem = loadGuestMemory();
  let changed = false;
  for (const fen of Object.keys(mem)) {
    for (const uci of Object.keys(mem[fen])) {
      if (mem[fen][uci]?.opName === openingName) {
        delete mem[fen][uci];
        changed = true;
      }
    }
    if (Object.keys(mem[fen]).length === 0) delete mem[fen];
  }
  if (changed) saveGuestMemory(mem);
  return true;
}

// List every opening the current user has variation memory for.
// Returns [{ opening_name, opening_eco, total_plays, distinct_lines, last_played }]
// sorted by last_played desc. For guests, derives the same shape
// from localStorage.
export async function listOpenings() {
  if (isLoggedIn()) {
    try {
      const r = await fetch('/api/variations/openings', { credentials: 'include' });
      if (!r.ok) return [];
      const j = await r.json();
      return j.openings || [];
    } catch { return []; }
  }
  const mem = loadGuestMemory();
  const bucket = new Map();
  for (const fen of Object.keys(mem)) {
    for (const uci of Object.keys(mem[fen])) {
      const e = mem[fen][uci];
      const name = e?.opName || '(unknown)';
      if (!bucket.has(name)) bucket.set(name, {
        opening_name: name,
        opening_eco:  e?.opEco || null,
        total_plays:  0,
        distinct_lines: 0,
        last_played: null,
      });
      const b = bucket.get(name);
      b.total_plays += e.times || 1;
      b.distinct_lines += 1;
      if (!b.last_played || (e.at && e.at > b.last_played)) b.last_played = e.at;
    }
  }
  return [...bucket.values()].sort((a, b) => (b.last_played || '').localeCompare(a.last_played || ''));
}

export async function openingReport(openingName) {
  if (isLoggedIn()) {
    try {
      const r = await fetch('/api/variations/opening/' + encodeURIComponent(openingName),
        { credentials: 'include' });
      if (!r.ok) return [];
      const j = await r.json();
      return j.entries || [];
    } catch { return []; }
  }
  const mem = loadGuestMemory();
  const out = [];
  for (const fen of Object.keys(mem)) {
    for (const uci of Object.keys(mem[fen])) {
      const e = mem[fen][uci];
      if (e?.opName === openingName) {
        out.push({
          fen, uci,
          times_played: e.times || 1,
          last_played: e.at,
          opening_eco: e.opEco,
          prefix_moves: e.prefix || null,
        });
      }
    }
  }
  out.sort((a, b) => (b.last_played || '').localeCompare(a.last_played || ''));
  return out;
}

// ─── The picker itself ─────────────────────────────────────────────
//
// topMoves: array of { multipv, score, scoreKind, pv: [uci...] }, as
// delivered by engine's 'bestmove' event detail. Assumes MultiPV search
// already completed — caller is responsible for running it before
// calling pickCandidate.
//
// Returns a UCI string (or null to signal "fall back to best move").
//
// Score convention: lila/stockfish `score` is from side-to-move's POV
// in centipawns. Higher = better for STM. We compare best - other as
// "how much worse is `other` than best (in cp)".

// Returns { uci, deviated } — deviated=true when the pick is a non-#1
// candidate. Caller uses `deviated` to increment the session's
// deviation counter (noteDeviation()). On any early-exit (no tail,
// singleton, don't-deviate roll) returns { uci, deviated: false }.
export async function pickCandidate(topMoves, fen, forkParams) {
  if (!Array.isArray(topMoves) || topMoves.length === 0) return null;
  const best = topMoves[0];
  if (!best?.pv?.[0]) return null;

  // Collect candidates within tolerance (cp-based; mate-scored lines
  // always accept the top).
  const cands = [];
  for (const t of topMoves) {
    if (!t?.pv?.[0]) continue;
    if (t.scoreKind !== 'cp' || best.scoreKind !== 'cp') {
      if (t === best) cands.push({ uci: t.pv[0], gap: 0 });
      continue;
    }
    const gap = best.score - t.score;
    if (gap <= forkParams.tolerance) cands.push({ uci: t.pv[0], gap });
  }
  if (cands.length === 0) {
    console.log('[variation] pickCandidate: no candidates within tolerance; playing #1', { best: best.pv[0] });
    return { uci: best.pv[0], deviated: false };
  }
  if (cands.length === 1) {
    console.log('[variation] pickCandidate: only 1 candidate within tolerance; no deviation possible', { uci: cands[0].uci });
    return { uci: cands[0].uci, deviated: false };
  }

  // Decide: deviate or not?
  const roll = Math.random();
  const rollDeviate = roll < forkParams.devProb;
  if (!rollDeviate) {
    console.log('[variation] pickCandidate: dice rolled NO-deviate', {
      roll: roll.toFixed(3), devProb: forkParams.devProb.toFixed(3),
      candidatesInTol: cands.length, best: cands[0].uci,
    });
    return { uci: cands[0].uci, deviated: false };
  }

  // Deviating: weighted pick from the NON-#1 pool (fall back to #1 if
  // anti-repetition or weights zero out).
  const tail = cands.slice(1);

  // Anti-repetition: look up history, down-weight repeats.
  let history = [];
  try { history = await fetchHistoryForFen(fen); } catch {}
  const timesPlayed = new Map(history.map(h => [h.uci, h.times_played || 0]));

  // Weighting: inverse of cp-gap (closer to best = higher weight) *
  //            anti-repetition decay (0.3^times).
  // `k` (from varietyBias setting) controls the steepness: smaller k
  // biases more strongly toward close-to-best candidates.
  const k = forkParams.varietyK || 50;
  const weights = tail.map(c => {
    const gapScore   = 1 / (1 + c.gap / k);
    const timesSeen  = timesPlayed.get(c.uci) || 0;
    const repeatDecay = Math.pow(0.3, timesSeen);  // 0→1, 1→0.3, 2→0.09
    return Math.max(0.001, gapScore * repeatDecay);
  });

  const sum = weights.reduce((a, b) => a + b, 0);
  let rollW = Math.random() * sum;
  let pickedIdx = tail.length - 1;
  for (let i = 0; i < tail.length; i++) {
    rollW -= weights[i];
    if (rollW <= 0) { pickedIdx = i; break; }
  }
  const picked = tail[pickedIdx];
  console.log('[variation] pickCandidate: DEVIATED', {
    picked: picked.uci,
    gap: picked.gap,
    pickedIdx: pickedIdx + 1,   // 1-indexed (0 would be best, excluded from tail)
    candidatesInTol: cands.length,
    tailSize: tail.length,
    weights: weights.map(w => +w.toFixed(3)),
    history: [...timesPlayed.entries()],
  });
  return { uci: picked.uci, deviated: true };
}
