// src/server/library.js — server-side persistence for the practice
// opening picker:
//   * /api/favourites          — starred openings (key + side)
//   * /api/custom-openings     — user-saved opening definitions
//
// Both endpoints accept either a logged-in user (session cookie) OR
// a guest (X-Guest-Id header) via requireAuthOrGuest, mirroring the
// dual-ownership pattern used by /api/games. Each row is keyed by
// EXACTLY one of (user_id, guest_id) — DB-enforced via a CHECK
// constraint.
//
// Wired in server.js: wireLibrary(app).

import { query } from './db.js';
import { requireAuthOrGuest } from './auth.js';

// Returns { col, val } — which column/value identifies this caller.
function ownerOf(req) {
  if (req.user)  return { col: 'user_id',  val: req.user.id  };
  if (req.guest) return { col: 'guest_id', val: req.guest.id };
  throw new Error('ownerOf: requireAuthOrGuest must run first');
}

export function wireLibrary(app) {
  // ── Favourites ────────────────────────────────────────────────

  // GET /api/favourites — list everything the caller has starred.
  // Response: { favourites: [{ opening_key, side, created_at }, ...] }
  app.get('/api/favourites', requireAuthOrGuest, async (req, res) => {
    try {
      const { col, val } = ownerOf(req);
      const { rows } = await query(
        `SELECT opening_key, side, created_at
           FROM favourites
          WHERE ${col} = $1
          ORDER BY created_at DESC`,
        [val],
      );
      res.json({ favourites: rows });
    } catch (err) {
      console.error('[favourites] list failed', err);
      res.status(500).json({ error: 'list failed' });
    }
  });

  // PUT /api/favourites — add or update a starred opening.
  // Body: { opening_key, side }
  // Idempotent: subsequent PUTs update the side without dupe rows.
  app.put('/api/favourites', requireAuthOrGuest, async (req, res) => {
    try {
      const b = req.body || {};
      const key  = String(b.opening_key || '').trim();
      const side = String(b.side || 'white').trim();
      if (!key) return res.status(400).json({ error: 'opening_key required' });
      if (!['white', 'black', 'both'].includes(side)) {
        return res.status(400).json({ error: 'side must be white|black|both' });
      }
      const userId  = req.user  ? req.user.id  : null;
      const guestId = req.guest ? req.guest.id : null;
      // The unique index uniq_favourites_owner_key enforces one row
      // per owner+key. ON CONFLICT cleanly upserts the side.
      await query(
        `INSERT INTO favourites(user_id, guest_id, opening_key, side)
         VALUES($1,$2,$3,$4)
         ON CONFLICT (COALESCE(user_id::text, ''), COALESCE(guest_id, ''), opening_key)
         DO UPDATE SET side = EXCLUDED.side`,
        [userId, guestId, key, side],
      );
      res.json({ ok: true });
    } catch (err) {
      console.error('[favourites] put failed', err);
      res.status(500).json({ error: 'put failed' });
    }
  });

  // DELETE /api/favourites?key=<opening_key>  — remove a star.
  app.delete('/api/favourites', requireAuthOrGuest, async (req, res) => {
    try {
      const key = String(req.query.key || '').trim();
      if (!key) return res.status(400).json({ error: 'key query param required' });
      const { col, val } = ownerOf(req);
      const r = await query(
        `DELETE FROM favourites WHERE ${col} = $1 AND opening_key = $2`,
        [val, key],
      );
      res.json({ deleted: r.rowCount });
    } catch (err) {
      console.error('[favourites] delete failed', err);
      res.status(500).json({ error: 'delete failed' });
    }
  });

  // ── Custom openings ───────────────────────────────────────────

  // GET /api/custom-openings — list every custom opening the caller has saved.
  app.get('/api/custom-openings', requireAuthOrGuest, async (req, res) => {
    try {
      const { col, val } = ownerOf(req);
      const { rows } = await query(
        `SELECT id, group_name, opening_name, moves_san, starting_fen, side,
                created_at, updated_at
           FROM custom_openings
          WHERE ${col} = $1
          ORDER BY group_name, opening_name`,
        [val],
      );
      res.json({ openings: rows });
    } catch (err) {
      console.error('[custom-openings] list failed', err);
      res.status(500).json({ error: 'list failed' });
    }
  });

  // POST /api/custom-openings  — create or update.
  // Body: { group_name, opening_name, moves_san, starting_fen?, side? }
  // Idempotent on (owner, group_name, opening_name) — re-saving updates.
  app.post('/api/custom-openings', requireAuthOrGuest, async (req, res) => {
    try {
      const b = req.body || {};
      const groupName   = String(b.group_name || '').trim();
      const openingName = String(b.opening_name || '').trim();
      const movesSan    = String(b.moves_san || '').trim();
      const startingFen = b.starting_fen ? String(b.starting_fen).trim() : null;
      const side        = b.side ? String(b.side).trim() : null;
      if (!groupName || !openingName) {
        return res.status(400).json({ error: 'group_name and opening_name required' });
      }
      if (!movesSan && !startingFen) {
        return res.status(400).json({ error: 'either moves_san or starting_fen required' });
      }
      if (movesSan.length > 4000) {
        return res.status(413).json({ error: 'moves_san too long' });
      }
      const userId  = req.user  ? req.user.id  : null;
      const guestId = req.guest ? req.guest.id : null;
      const { rows } = await query(
        `INSERT INTO custom_openings(
            user_id, guest_id, group_name, opening_name,
            moves_san, starting_fen, side, updated_at
          )
          VALUES($1,$2,$3,$4,$5,$6,$7,NOW())
          ON CONFLICT (COALESCE(user_id::text, ''), COALESCE(guest_id, ''), group_name, opening_name)
          DO UPDATE SET
            moves_san    = EXCLUDED.moves_san,
            starting_fen = EXCLUDED.starting_fen,
            side         = EXCLUDED.side,
            updated_at   = NOW()
          RETURNING id, created_at, updated_at`,
        [userId, guestId, groupName, openingName, movesSan, startingFen, side],
      );
      res.json({ id: rows[0].id, created_at: rows[0].created_at, updated_at: rows[0].updated_at });
    } catch (err) {
      console.error('[custom-openings] save failed', err);
      res.status(500).json({ error: 'save failed' });
    }
  });

  // ── Engine crash telemetry (Phase-3-decision visibility) ──────
  //
  // POST /api/engine-crashes
  //   body: { crashes: [{ when, flavor, message, attempt }, ...] }
  // Idempotent batch insert. Client batches every 5 minutes from
  // localStorage; entries already inserted (matched by user/guest
  // owner + timestamp + flavor) are silently no-op'd.
  app.post('/api/engine-crashes', requireAuthOrGuest, async (req, res) => {
    try {
      const arr = Array.isArray(req.body?.crashes) ? req.body.crashes : [];
      if (!arr.length) return res.json({ inserted: 0 });
      const userId  = req.user  ? req.user.id  : null;
      const guestId = req.guest ? req.guest.id : null;
      const ua = String(req.get('User-Agent') || '').slice(0, 300);
      let inserted = 0;
      for (const c of arr) {
        if (!c || typeof c.when !== 'string') continue;
        // De-dupe on (owner, crashed_at, flavor) — same crash from
        // multiple flush passes shouldn't double-count.
        const dupCheck = await query(
          `SELECT 1 FROM engine_crashes
            WHERE ($1::int IS NOT NULL AND user_id = $1)
               OR ($2::text IS NOT NULL AND guest_id = $2)
            AND crashed_at = $3 AND flavor = $4
            LIMIT 1`,
          [userId, guestId, c.when, c.flavor || null],
        );
        if (dupCheck.rowCount > 0) continue;
        await query(
          `INSERT INTO engine_crashes(
              user_id, guest_id, flavor, message, user_agent, attempt, crashed_at
            ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            userId, guestId,
            String(c.flavor || '').slice(0, 50),
            String(c.message || '').slice(0, 500),
            ua,
            Number.isFinite(+c.attempt) ? +c.attempt : 1,
            c.when,
          ],
        );
        inserted++;
      }
      res.json({ inserted, received: arr.length });
    } catch (err) {
      console.error('[engine-crashes] insert failed', err);
      res.status(500).json({ error: 'insert failed' });
    }
  });

  // GET /api/engine-crashes/stats — owner-scoped summary for the
  // crash-stats console helper. Returns counts by flavor + by day +
  // last-7-days total.
  app.get('/api/engine-crashes/stats', requireAuthOrGuest, async (req, res) => {
    try {
      const { col, val } = ownerOf(req);
      const total  = await query(`SELECT COUNT(*)::int AS c FROM engine_crashes WHERE ${col} = $1`, [val]);
      const last7  = await query(
        `SELECT COUNT(*)::int AS c FROM engine_crashes
           WHERE ${col} = $1 AND crashed_at > NOW() - INTERVAL '7 days'`,
        [val],
      );
      const byFlavor = await query(
        `SELECT flavor, COUNT(*)::int AS c FROM engine_crashes
           WHERE ${col} = $1 GROUP BY flavor ORDER BY c DESC`,
        [val],
      );
      const byDay = await query(
        `SELECT DATE(crashed_at)::text AS day, COUNT(*)::int AS c
           FROM engine_crashes
          WHERE ${col} = $1 AND crashed_at > NOW() - INTERVAL '30 days'
          GROUP BY day ORDER BY day DESC`,
        [val],
      );
      const recent = await query(
        `SELECT crashed_at, flavor, message FROM engine_crashes
           WHERE ${col} = $1 ORDER BY crashed_at DESC LIMIT 10`,
        [val],
      );
      res.json({
        total: total.rows[0]?.c || 0,
        last7Days: last7.rows[0]?.c || 0,
        byFlavor: byFlavor.rows,
        byDay: byDay.rows,
        recent: recent.rows,
      });
    } catch (err) {
      console.error('[engine-crashes] stats failed', err);
      res.status(500).json({ error: 'stats failed' });
    }
  });

  // DELETE /api/custom-openings  — remove by (group, name) OR by id.
  // Query: ?group=<g>&name=<n>   — preferred for client compat
  //    or  ?id=<id>              — direct
  app.delete('/api/custom-openings', requireAuthOrGuest, async (req, res) => {
    try {
      const { col, val } = ownerOf(req);
      const id    = req.query.id ? +req.query.id : null;
      const group = String(req.query.group || '').trim();
      const name  = String(req.query.name  || '').trim();
      let r;
      if (id) {
        r = await query(
          `DELETE FROM custom_openings WHERE id = $1 AND ${col} = $2`,
          [id, val],
        );
      } else if (group && name) {
        r = await query(
          `DELETE FROM custom_openings
             WHERE ${col} = $1 AND group_name = $2 AND opening_name = $3`,
          [val, group, name],
        );
      } else {
        return res.status(400).json({ error: 'id, OR group + name required' });
      }
      res.json({ deleted: r.rowCount });
    } catch (err) {
      console.error('[custom-openings] delete failed', err);
      res.status(500).json({ error: 'delete failed' });
    }
  });
}
