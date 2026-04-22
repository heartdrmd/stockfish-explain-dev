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
  maxForks:        5,           // 1..15
  thinkMs:         30_000,      // 15s..120s
  earlyTolerance:  50,          // 10..100 cp
  tighten:         true,
  lateTolerance:   10,          // 5..50 cp (only used if tighten)
  devWeight:       'strong',    // 'mild' | 'medium' | 'strong'
  rememberMemory:  true,
});

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
    active:      !!s.enabled,
    forkIndex:   0,       // how many forks already consumed
    maxForks:    Math.min(Math.max(1, +s.maxForks || 1), 15),
    thinkMs:     Math.min(Math.max(5_000, +s.thinkMs || 30_000), 120_000),
    earlyTol:    Math.min(Math.max(5, +s.earlyTolerance || 50), 200),
    lateTol:     s.tighten ? Math.min(Math.max(3, +s.lateTolerance || 10), 100) : null,
    devCurve:    DEV_WEIGHT_CURVE[s.devWeight] || DEV_WEIGHT_CURVE.strong,
    remember:    !!s.rememberMemory,
    openingName: openingName || null,
    openingEco:  openingEco  || null,
  };
  return _session;
}

export function endSession() { _session = null; }

export function isActive() {
  return !!(_session && _session.active && _session.forkIndex < _session.maxForks);
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
  return {
    forkIndex:    i + 1,              // 1-indexed for display
    forksPlanned: n,
    tolerance,
    devProb,
    thinkMs: _session.thinkMs,
  };
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

export async function recordPlay(fen, uci) {
  if (!_session || !_session.remember) return;
  const opName = _session.openingName;
  const opEco  = _session.openingEco;
  if (isLoggedIn()) {
    try {
      await fetch('/api/variations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fen, uci, opening_name: opName, opening_eco: opEco }),
      });
    } catch (err) { console.warn('[variations] recordPlay POST failed', err); }
  } else {
    const mem = loadGuestMemory();
    if (!mem[fen]) mem[fen] = {};
    const cur = mem[fen][uci] || { times: 0, opName, opEco };
    cur.times = (cur.times || 0) + 1;
    cur.at = new Date().toISOString();
    cur.opName = opName || cur.opName;
    cur.opEco  = opEco  || cur.opEco;
    mem[fen][uci] = cur;
    saveGuestMemory(mem);
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
        out.push({ fen, uci, times_played: e.times || 1, last_played: e.at, opening_eco: e.opEco });
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
  if (cands.length === 0) return best.pv[0];
  if (cands.length === 1) return cands[0].uci;

  // Decide: deviate or not?
  const rollDeviate = Math.random() < forkParams.devProb;
  if (!rollDeviate) {
    return cands[0].uci;   // always pick #1 when not deviating
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
  const weights = tail.map(c => {
    const gapScore   = 1 / (1 + c.gap / 50);       // gap=0 → 1.0, gap=50 → 0.5
    const timesSeen  = timesPlayed.get(c.uci) || 0;
    const repeatDecay = Math.pow(0.3, timesSeen);  // 0→1, 1→0.3, 2→0.09
    return Math.max(0.001, gapScore * repeatDecay);
  });

  const sum = weights.reduce((a, b) => a + b, 0);
  let roll = Math.random() * sum;
  for (let i = 0; i < tail.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return tail[i].uci;
  }
  return tail[tail.length - 1].uci;
}
