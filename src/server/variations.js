// src/server/variations.js — anti-repetition memory for opening variations.
//
// When the opening-variation practice mode picks a non-#1 candidate at
// a fork, the client POSTs (fen, uci, opening_name) here; the row is
// upserted with a times_played counter + last_played timestamp. On the
// next engine fork at the same fen, the client fetches the user's
// history for that fen and down-weights moves it has played recently.
//
// All endpoints require auth. Guests fall back to localStorage on the
// client — see opening-variation.js.
//
// Endpoints:
//   POST   /api/variations                 body: { fen, uci, opening_name?, opening_eco? }
//   GET    /api/variations/fen/:fen        → [{ uci, times_played, last_played }, ...]
//   GET    /api/variations/opening/:name   → [{ fen, uci, times_played, last_played, opening_eco }, ...]
//   DELETE /api/variations/opening/:name   → resets memory for one opening
//   DELETE /api/variations                 → wipes all of user's memory

import { query } from './db.js';
import { requireAuth } from './auth.js';

export function wireVariations(app) {
  // ── record a play (upsert, increment counter on conflict) ────────
  app.post('/api/variations', requireAuth, async (req, res) => {
    try {
      const { fen, uci, opening_name, opening_eco } = req.body || {};
      if (!fen || typeof fen !== 'string' || fen.length > 200) {
        return res.status(400).json({ error: 'fen required (≤ 200 chars)' });
      }
      if (!uci || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) {
        return res.status(400).json({ error: 'uci must match standard move pattern' });
      }
      const op    = opening_name ? String(opening_name).slice(0, 120) : null;
      const eco   = opening_eco  ? String(opening_eco).slice(0, 10)   : null;
      await query(
        `INSERT INTO variation_memory (user_id, fen, uci, opening_name, opening_eco)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, fen, uci) DO UPDATE
           SET times_played  = variation_memory.times_played + 1,
               last_played   = NOW(),
               opening_name  = COALESCE(EXCLUDED.opening_name, variation_memory.opening_name),
               opening_eco   = COALESCE(EXCLUDED.opening_eco,  variation_memory.opening_eco)`,
        [req.user.id, fen, uci, op, eco]
      );
      res.json({ ok: true });
    } catch (err) {
      console.error('[variations] POST failed', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── fetch history for one FEN (used by the picker before each fork) ──
  app.get('/api/variations/fen/:fen', requireAuth, async (req, res) => {
    try {
      const fen = String(req.params.fen || '');
      if (!fen) return res.json({ entries: [] });
      const { rows } = await query(
        `SELECT uci, times_played, last_played
           FROM variation_memory
          WHERE user_id = $1 AND fen = $2`,
        [req.user.id, fen]
      );
      res.json({ entries: rows });
    } catch (err) {
      console.error('[variations] GET fen failed', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── fetch all plays for one opening (used by the report modal) ───
  app.get('/api/variations/opening/:name', requireAuth, async (req, res) => {
    try {
      const name = String(req.params.name || '');
      const { rows } = await query(
        `SELECT fen, uci, opening_eco, times_played, last_played
           FROM variation_memory
          WHERE user_id = $1 AND opening_name = $2
          ORDER BY last_played DESC`,
        [req.user.id, name]
      );
      res.json({ entries: rows });
    } catch (err) {
      console.error('[variations] GET opening failed', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── list all openings the user has variation memory for ────────
  //    Used by the report modal's opening dropdown.
  app.get('/api/variations/openings', requireAuth, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT opening_name,
                MAX(opening_eco)            AS opening_eco,
                SUM(times_played)::int      AS total_plays,
                COUNT(*)::int               AS distinct_lines,
                MAX(last_played)            AS last_played
           FROM variation_memory
          WHERE user_id = $1 AND opening_name IS NOT NULL
          GROUP BY opening_name
          ORDER BY MAX(last_played) DESC`,
        [req.user.id]
      );
      res.json({ openings: rows });
    } catch (err) {
      console.error('[variations] GET openings failed', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── scoped reset: wipe memory for one opening ───────────────────
  app.delete('/api/variations/opening/:name', requireAuth, async (req, res) => {
    try {
      const name = String(req.params.name || '');
      const result = await query(
        `DELETE FROM variation_memory WHERE user_id = $1 AND opening_name = $2`,
        [req.user.id, name]
      );
      res.json({ deleted: result.rowCount });
    } catch (err) {
      console.error('[variations] DELETE opening failed', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── full wipe: all variation memory for this user ───────────────
  app.delete('/api/variations', requireAuth, async (req, res) => {
    try {
      const result = await query(
        `DELETE FROM variation_memory WHERE user_id = $1`,
        [req.user.id]
      );
      res.json({ deleted: result.rowCount });
    } catch (err) {
      console.error('[variations] DELETE all failed', err);
      res.status(500).json({ error: err.message });
    }
  });
}
