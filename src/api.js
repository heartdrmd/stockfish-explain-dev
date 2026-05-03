// src/api.js — thin fetch wrapper for the /api/* JSON endpoints.
//
// All helpers include credentials so the session cookie rides along.
// Errors throw with { status, message } so callers can pattern-match
// on HTTP 401 to prompt for login, 413 for too-big payloads, etc.
//
// Guest support: endpoints that accept anonymous callers (like the
// game archive under /api/games) receive an X-Guest-Id header when
// the user isn't logged in. The ID is a random 22-char URL-safe
// token persisted in localStorage — stable across refreshes so the
// server can scope the guest's games consistently.

const GUEST_ID_KEY = 'stockfish-explain.guest-id';

// Generate a 22-char URL-safe random ID (128 bits of entropy). Used
// instead of UUIDv4 because the dashes in UUIDs waste header bytes
// and our regex on the server accepts [A-Za-z0-9_-].
function newGuestId() {
  const bytes = new Uint8Array(16);
  (crypto || window.crypto).getRandomValues(bytes);
  // base64url without padding: A-Z a-z 0-9 - _
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function getGuestId() {
  try {
    let id = localStorage.getItem(GUEST_ID_KEY);
    if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
      id = newGuestId();
      localStorage.setItem(GUEST_ID_KEY, id);
    }
    return id;
  } catch {
    // Private-mode / quota-exceeded: return a transient one — cloud save
    // still works for this session, just won't persist across reloads.
    return newGuestId();
  }
}

async function req(method, url, body) {
  const opts = {
    method,
    credentials: 'include',
    headers: { 'Accept': 'application/json' },
  };
  // Always send a guest ID — the server ignores it when a session
  // cookie is also present. This lets guests and logged-in users share
  // the exact same API surface without branching the call sites.
  try { opts.headers['X-Guest-Id'] = getGuestId(); } catch {}
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  const ct = r.headers.get('content-type') || '';
  const isJson = ct.includes('application/json');
  let data = null;
  try { data = isJson ? await r.json() : await r.text(); } catch {}
  if (!r.ok) {
    const err = new Error((data && data.error) || `HTTP ${r.status}`);
    err.status = r.status;
    err.body = data;
    throw err;
  }
  return data;
}

export const api = {
  // auth
  me:     ()    => req('GET',  '/api/auth/me'),
  signup: (u,p) => req('POST', '/api/auth/signup', { username: u, password: p }),
  login:  (u,p) => req('POST', '/api/auth/login',  { username: u, password: p }),
  logout: ()    => req('POST', '/api/auth/logout'),

  // games
  saveGame:   (g)       => req('POST',   '/api/games', g),
  // Full filter surface: from, to, result, color, mode, opening,
  // cleanliness (clean|mistakes|blunders), sort (newest|oldest|
  // most_mistakes|fewest_mistakes|most_moves), limit, offset.
  listGames:  (q = {})  => {
    const qs = new URLSearchParams(Object.entries(q).filter(([,v]) => v != null && v !== ''));
    return req('GET',    '/api/games' + (qs.toString() ? '?' + qs : ''));
  },
  // Aggregate counts honouring the same filters. Used for the My Games
  // header strip (total, W/L/D, avg mistakes, etc.).
  statsGames: (q = {})  => {
    const qs = new URLSearchParams(Object.entries(q).filter(([,v]) => v != null && v !== ''));
    return req('GET',    '/api/games/stats' + (qs.toString() ? '?' + qs : ''));
  },
  getGame:    (id)      => req('GET',    `/api/games/${+id}`),
  deleteGame: (id)      => req('DELETE', `/api/games/${+id}`),
  // Returns the export URL so the caller can set window.location or
  // create an <a download> — lets the browser stream the file directly.
  // Guest ID goes via the guest_id query param here because the
  // download flow can't attach custom headers the way fetch() does.
  exportUrl:  (q = {})  => {
    const merged = { ...q };
    try { merged.guest_id = getGuestId(); } catch {}
    const qs = new URLSearchParams(Object.entries(merged).filter(([,v]) => v != null && v !== ''));
    return '/api/games/export.pgn' + (qs.toString() ? '?' + qs : '');
  },

  // ── Library: favourites + custom openings (cross-device persist) ──
  listFavourites:    ()                => req('GET',    '/api/favourites'),
  putFavourite:      (opening_key, side) => req('PUT', '/api/favourites', { opening_key, side }),
  deleteFavourite:   (opening_key)     => req('DELETE', '/api/favourites?key=' + encodeURIComponent(opening_key)),

  // Engine crash telemetry (Phase-3-decision visibility)
  reportEngineCrashes: (crashes)        => req('POST',   '/api/engine-crashes', { crashes }),
  engineCrashStats:    ()               => req('GET',    '/api/engine-crashes/stats'),

  listCustomOpenings: ()                => req('GET',    '/api/custom-openings'),
  saveCustomOpening:  (op)              => req('POST',   '/api/custom-openings', op),
  deleteCustomOpening: ({ id, group_name, opening_name }) => {
    if (id) return req('DELETE', '/api/custom-openings?id=' + id);
    const qs = new URLSearchParams({ group: group_name, name: opening_name });
    return req('DELETE', '/api/custom-openings?' + qs.toString());
  },
};

// Convenience: return current user or null (catches 401).
export async function currentUser() {
  try { const r = await api.me(); return r.user; } catch { return null; }
}
