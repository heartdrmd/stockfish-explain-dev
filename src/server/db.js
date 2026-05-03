// src/server/db.js — Postgres connection pool + schema migrations.
//
// Migrations are idempotent and run once at server startup. Each new
// schema change is a `migrations.push(...)` call at the bottom of the
// file — we track which ones have run via a `_migrations` table.
//
// Reading this file tells you the entire schema. No separate SQL files.

import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
export const db = connectionString
  ? new Pool({
      connectionString,
      // Render's managed Postgres requires SSL; the default self-signed
      // cert isn't in Node's root bundle so we relax rejectUnauthorized.
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30_000,
    })
  : null;

export const dbEnabled = () => !!db;

export async function query(sql, params = []) {
  if (!db) throw new Error('DATABASE_URL not configured — DB queries are disabled');
  return db.query(sql, params);
}

// ─── Migrations ────────────────────────────────────────────────────
// Each migration is { name, sql }. Names must be unique + stable —
// they're stored in the _migrations table to prevent re-runs.

const migrations = [
  {
    name: '001_users',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id           SERIAL PRIMARY KEY,
        username     TEXT UNIQUE NOT NULL,
        pw_hash      TEXT NOT NULL,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ DEFAULT NOW()
      );
    `,
  },
  {
    name: '002_sessions',
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        token       TEXT PRIMARY KEY,
        user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        expires_at  TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);
    `,
  },
  {
    name: '003_games',
    sql: `
      CREATE TABLE IF NOT EXISTS games (
        id              SERIAL PRIMARY KEY,
        user_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        pgn             TEXT NOT NULL,
        result          TEXT,
        opening_name    TEXT,
        opening_eco     TEXT,
        white_name      TEXT,
        black_name      TEXT,
        user_color      TEXT,                -- 'white' | 'black' | null
        mode            TEXT,                -- 'practice' | 'analysis'
        plies           JSONB,               -- per-ply eval data
        mistakes_count  INT DEFAULT 0,
        blunders_count  INT DEFAULT 0,
        played_at       TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_games_user_played
        ON games(user_id, played_at DESC);
    `,
  },
  {
    name: '004_mistakes',
    sql: `
      CREATE TABLE IF NOT EXISTS mistakes (
        id               SERIAL PRIMARY KEY,
        user_id          INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        game_id          INT REFERENCES games(id) ON DELETE CASCADE,
        fen              TEXT NOT NULL,
        played_san       TEXT NOT NULL,
        best_uci         TEXT,
        eval_before_cp   INT,
        eval_after_cp    INT,
        severity         TEXT NOT NULL,       -- 'inaccuracy' | 'mistake' | 'blunder'
        win_chance_drop  REAL,
        ply              INT,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_mistakes_user ON mistakes(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mistakes_game ON mistakes(game_id);
    `,
  },
  {
    name: '005_srs_cards',
    sql: `
      CREATE TABLE IF NOT EXISTS srs_cards (
        id             SERIAL PRIMARY KEY,
        user_id        INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        mistake_id     INT NOT NULL REFERENCES mistakes(id) ON DELETE CASCADE,
        ease           REAL DEFAULT 2.5,
        interval_days  REAL DEFAULT 1,
        due_at         TIMESTAMPTZ DEFAULT NOW(),
        review_count   INT  DEFAULT 0,
        last_graded_at TIMESTAMPTZ,
        UNIQUE(user_id, mistake_id)
      );
      CREATE INDEX IF NOT EXISTS idx_srs_user_due ON srs_cards(user_id, due_at);
    `,
  },
  {
    name: '006_favourites',
    sql: `
      CREATE TABLE IF NOT EXISTS favourites (
        user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        opening_key TEXT NOT NULL,
        side        TEXT NOT NULL,            -- 'white' | 'black' | 'both'
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, opening_key)
      );
    `,
  },
  {
    name: '007_user_prefs',
    sql: `
      CREATE TABLE IF NOT EXISTS user_prefs (
        user_id     INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        prefs_json  JSONB NOT NULL DEFAULT '{}',
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `,
  },
  {
    // Anti-repetition memory for the opening-variation practice mode.
    // When the engine picks a non-#1 candidate at an opening fork, we
    // record (user_id, fen, uci) → times_played so repeat drills at
    // the same FEN favour less-explored moves. opening_name lets us
    // scope "reset memory for THIS opening" without deleting the
    // whole user's history.
    name: '008_variation_memory',
    sql: `
      CREATE TABLE IF NOT EXISTS variation_memory (
        user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        fen           TEXT NOT NULL,
        uci           TEXT NOT NULL,
        opening_name  TEXT,              -- nullable; labels for scoped reset + report
        opening_eco   TEXT,
        times_played  INT NOT NULL DEFAULT 1,
        last_played   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, fen, uci)
      );
      CREATE INDEX IF NOT EXISTS idx_variation_memory_user_opening
        ON variation_memory(user_id, opening_name);
      CREATE INDEX IF NOT EXISTS idx_variation_memory_user_fen
        ON variation_memory(user_id, fen);
    `,
  },
  {
    // Add prefix_moves: the UCI chain from the game's STARTING position
    // up to (but not including) the deviation's FEN. Space-separated
    // (e.g. "e2e4 c7c5 c2c3 d7d5"). Needed so the variation-report can
    // rebuild a real ECO-style tree — grouping deviations by their
    // shared game-path prefix. Without it, every deviation looks like a
    // disconnected root (different FENs, no chain). Legacy rows keep
    // NULL; the client falls back to flat-list for those.
    name: '009_variation_prefix_moves',
    sql: `
      ALTER TABLE variation_memory
        ADD COLUMN IF NOT EXISTS prefix_moves TEXT;
    `,
  },
  {
    // Guest-player game archive: users without an account can now save
    // games to the server too, keyed by a browser-generated UUID
    // ("guest_id") stored in localStorage. This makes first-time usage
    // feel exactly like the logged-in path (cloud save, filters, export)
    // without forcing signup. A row in `games` is keyed by EXACTLY one
    // of (user_id, guest_id) — enforced by a CHECK constraint.
    //
    //   - user_id becomes nullable (was NOT NULL before)
    //   - new nullable guest_id column
    //   - check: exactly one of them set
    //   - index for guest lookups
    //
    // If a guest later creates an account, a future migration can
    // claim their guest games by setting user_id = me WHERE guest_id = X.
    name: '010_guest_games',
    sql: `
      ALTER TABLE games
        ALTER COLUMN user_id DROP NOT NULL,
        ADD COLUMN IF NOT EXISTS guest_id TEXT;

      -- Drop & recreate the check if it exists (idempotent upgrades).
      ALTER TABLE games DROP CONSTRAINT IF EXISTS games_owner_xor;
      ALTER TABLE games ADD CONSTRAINT games_owner_xor
        CHECK ((user_id IS NOT NULL) <> (guest_id IS NOT NULL));

      CREATE INDEX IF NOT EXISTS idx_games_guest_played
        ON games(guest_id, played_at DESC)
        WHERE guest_id IS NOT NULL;
    `,
  },
  {
    // Cross-device persistence for the practice opening picker:
    //   - favourites:       which openings the user has starred + side
    //   - custom_openings:  user-saved opening definitions (name, group,
    //                       SAN moves, optional starting FEN)
    //
    // Both tables use the same (user_id XOR guest_id) ownership pattern
    // we introduced for games — works for logged-in users AND guests
    // (scoped by the X-Guest-Id header / token). Existing rows in
    // `favourites` (006 migration) had user_id NOT NULL — we relax that
    // here so guests can use the table too.
    name: '011_favourites_and_custom_openings_dual_owner',
    sql: `
      -- Favourites: relax user_id, add guest_id, switch primary key.
      -- ORDER MATTERS: drop PK FIRST. Postgres requires all primary-
      -- key columns to be NOT NULL, so attempting DROP NOT NULL on
      -- user_id while it's still part of favourites_pkey fails with
      -- "column user_id is in a primary key".
      ALTER TABLE favourites DROP CONSTRAINT IF EXISTS favourites_pkey;
      ALTER TABLE favourites ALTER COLUMN user_id DROP NOT NULL;
      ALTER TABLE favourites ADD COLUMN IF NOT EXISTS guest_id TEXT;
      ALTER TABLE favourites DROP CONSTRAINT IF EXISTS favourites_owner_xor;
      ALTER TABLE favourites ADD CONSTRAINT favourites_owner_xor
        CHECK ((user_id IS NOT NULL) <> (guest_id IS NOT NULL));
      -- Composite PK over BOTH possible owner columns + opening_key.
      -- COALESCE-based unique index so (user_id IS NULL, guest_id) and
      -- (user_id, guest_id IS NULL) both behave as expected.
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_favourites_owner_key
        ON favourites(COALESCE(user_id::text, ''), COALESCE(guest_id, ''), opening_key);
      CREATE INDEX IF NOT EXISTS idx_favourites_guest
        ON favourites(guest_id) WHERE guest_id IS NOT NULL;

      -- New table for custom openings.
      CREATE TABLE IF NOT EXISTS custom_openings (
        id            SERIAL PRIMARY KEY,
        user_id       INT REFERENCES users(id) ON DELETE CASCADE,
        guest_id      TEXT,
        group_name    TEXT NOT NULL,         -- "My openings", "Sicilian variations", etc.
        opening_name  TEXT NOT NULL,         -- user-given label
        moves_san     TEXT NOT NULL,         -- space-separated SAN moves
        starting_fen  TEXT,                  -- optional non-standard start
        side          TEXT,                  -- preferred side: white | black | both | null
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT custom_openings_owner_xor
          CHECK ((user_id IS NOT NULL) <> (guest_id IS NOT NULL))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_custom_openings_owner_path
        ON custom_openings(COALESCE(user_id::text, ''), COALESCE(guest_id, ''), group_name, opening_name);
      CREATE INDEX IF NOT EXISTS idx_custom_openings_guest
        ON custom_openings(guest_id) WHERE guest_id IS NOT NULL;
    `,
  },
  {
    // Server-side telemetry for engine WASM crashes. Each time the
    // worker.onerror fires (memory access OOB, null function, Aborted,
    // etc.) we POST one row here. Lets us count crashes across all of
    // the user's devices + sessions without asking them to send a log
    // every time. Used to decide if Phase 3 (lichess-stockfish-web
    // migration) is worth shipping.
    //
    // Same dual-ownership pattern as games: user_id OR guest_id.
    name: '012_engine_crashes',
    sql: `
      CREATE TABLE IF NOT EXISTS engine_crashes (
        id           SERIAL PRIMARY KEY,
        user_id      INT REFERENCES users(id) ON DELETE CASCADE,
        guest_id     TEXT,
        flavor       TEXT,
        message      TEXT,
        user_agent   TEXT,
        attempt      INT DEFAULT 1,            -- 1st, 2nd, 3rd retry of this session
        crashed_at   TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_engine_crashes_user_when
        ON engine_crashes(user_id, crashed_at DESC) WHERE user_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_engine_crashes_guest_when
        ON engine_crashes(guest_id, crashed_at DESC) WHERE guest_id IS NOT NULL;
    `,
  },
];

export async function runMigrations() {
  if (!db) {
    console.log('[db] DATABASE_URL not set — skipping migrations (DB features disabled)');
    return;
  }
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name      TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  const { rows } = await db.query('SELECT name FROM _migrations');
  const applied = new Set(rows.map(r => r.name));
  for (const m of migrations) {
    if (applied.has(m.name)) continue;
    console.log(`[db] applying migration ${m.name}`);
    await db.query('BEGIN');
    try {
      await db.query(m.sql);
      await db.query('INSERT INTO _migrations(name) VALUES ($1)', [m.name]);
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw new Error(`Migration ${m.name} failed: ${err.message}`);
    }
  }
  console.log(`[db] schema ready — ${migrations.length} migrations tracked`);
}
