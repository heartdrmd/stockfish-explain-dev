// eco-lookup.js — lazy-loads the @hayatbiralem/eco.json dataset and
// exposes FEN-indexed name / ECO-code lookup. Data files live under
// /assets/eco/ecoA.json … ecoE.json (5 files, ~4.4 MB raw, ~600 KB
// gzipped) and are fetched on first use, then kept in memory for the
// rest of the session. The browser's HTTP cache handles reuse across
// page reloads.
//
// All entries are keyed by FEN, but we strip the halfmove + fullmove
// counters from the key for forgiving lookup (transpositions with the
// same placement + side-to-move + castling + ep square still match).
//
// Public surface:
//   ensureLoaded()                     → Promise<void>  — call before lookups
//   isLoaded()                         → bool
//   getEntry(fen)                      → {eco, name, moves, scid?, aliases?} | null
//   deepestNamedInFens(fens)           → {entry, plyIndex} | null
//   firstNamedAfter(fens, startIdx)    → {entry, plyIndex} | null  — walks forward
//
// The "walk forward / walk backward" helpers are what the report uses:
//   - firstNamedAfter(tailFens, 0)      → tells us the FAMILY a line belongs
//     to (first named position past the common prefix).
//   - deepestNamedInFens(allFens)       → tells us the LEAF name (most-specific
//     named opening the line ever reached).

const VOLUMES = ['ecoA', 'ecoB', 'ecoC', 'ecoD', 'ecoE'];
const BASE    = '/assets/eco';

let _map         = null;   // Map<fenKey, entry>
let _loadPromise = null;
let _loadError   = null;

function _fenKey(fen) {
  if (!fen) return '';
  // Keep placement + side-to-move + castling + ep square; drop halfmove + fullmove.
  const parts = fen.split(' ');
  return parts.slice(0, 4).join(' ');
}

async function _fetchVolume(vol) {
  const res = await fetch(`${BASE}/${vol}.json`, { credentials: 'omit' });
  if (!res.ok) throw new Error(`eco-lookup: ${vol}.json → HTTP ${res.status}`);
  return res.json();
}

async function _loadAll() {
  const vols = await Promise.all(VOLUMES.map(_fetchVolume));
  const map = new Map();
  for (const vol of vols) {
    for (const fen in vol) {
      map.set(_fenKey(fen), vol[fen]);
    }
  }
  return map;
}

export async function ensureLoaded() {
  if (_map) return _map;
  if (_loadError) throw _loadError;
  if (_loadPromise) return _loadPromise;
  _loadPromise = _loadAll()
    .then(m => { _map = m; return m; })
    .catch(err => { _loadError = err; throw err; });
  return _loadPromise;
}

export function isLoaded() {
  return _map != null;
}

export function entryCount() {
  return _map ? _map.size : 0;
}

export function getEntry(fen) {
  if (!_map) return null;
  return _map.get(_fenKey(fen)) || null;
}

// Walk fens[0..N-1] from END back to START; first hit is the most-specific
// named opening this line passed through. Returns {entry, plyIndex} or null.
// plyIndex is the index into the `fens` array (NOT a chess ply number).
export function deepestNamedInFens(fens) {
  if (!_map || !Array.isArray(fens)) return null;
  for (let i = fens.length - 1; i >= 0; i--) {
    const e = _map.get(_fenKey(fens[i]));
    if (e) return { entry: e, plyIndex: i };
  }
  return null;
}

// Walk fens[startIdx..N-1] from START forward; first hit is what this
// line "is" (its family, if startIdx = 0 of the tail after common prefix).
export function firstNamedAfter(fens, startIdx = 0) {
  if (!_map || !Array.isArray(fens)) return null;
  for (let i = startIdx; i < fens.length; i++) {
    const e = _map.get(_fenKey(fens[i]));
    if (e) return { entry: e, plyIndex: i };
  }
  return null;
}

// Convenience: given a line's FENs and a common-prefix length (in plies),
// return both the family (first name past the prefix) and the leaf (deepest
// name anywhere). If no family found past the prefix, fall back to the
// deepest name up to and INCLUDING the last prefix ply.
export function classifyLine(fensAfterEachMove, commonPrefixLen = 0) {
  if (!_map) return { family: null, leaf: null };
  // Tail = fens AFTER the shared prefix.
  const tailStart = commonPrefixLen;
  const family = firstNamedAfter(fensAfterEachMove, tailStart);
  const leaf   = deepestNamedInFens(fensAfterEachMove);
  // If no named entry in the tail, the whole line is still "in the prefix" —
  // use the deepest prefix name as its family so it doesn't float unlabeled.
  const familyOut = family || deepestNamedInFens(fensAfterEachMove.slice(0, tailStart)) || null;
  return { family: familyOut, leaf };
}
