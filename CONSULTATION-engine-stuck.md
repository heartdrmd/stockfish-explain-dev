# Stockfish WASM "engine wedges mid-search" — second opinion request

## TL;DR

Browser-based chess app using Stockfish WASM (the official lichess
`stockfish-web` builds) keeps getting wedged mid-search. The engine
emits a few `info` lines, then goes silent — never produces `bestmove`,
ignores `stop`. UI hangs waiting. We've put watchdogs in place to
unfreeze the UI, but the wedge keeps happening on every other game
or so. Looking for a real fix or a different architectural approach.

---

## Stack

- **Engine**: Stockfish 18 WASM, lichess `stockfish-web` distribution.
  Default flavor = `full` (108 MB NNUE, multi-threaded). User has 32 GB
  RAM, 64 cores, Edge on Windows. Threads=32. Page is COOP/COEP isolated
  (verified `coop/coep: true` in the log).
- **Worker model**: One Web Worker per engine instance. Single search
  per worker at a time. UCI protocol over postMessage.
- **Frontend**: Vanilla JS, chessground for the board, chess.js for
  game state.
- **Use case**: Practice mode — user plays against the engine. Each
  engine turn is a `go movetime 3000` (3-second search).

---

## The bug, in one log slice

```
11:27:12.836  [engine] _doStart {searchId:40, opts:{movetime:3000}}
11:27:14.836  [engine] health check OK {searchId:40, elapsed_ms:2000,
                infoReceived:3, infoDropped:0, infoDispatched:3,
                lastInfoAgo_ms:499}
                ↑ engine emitted 3 info lines in 2 s, then SLOWED.
11:27:27.837  [engine] bestmove watchdog fired — forcing stop
                {responsive:true, infoReceived:9}
                ↑ 15 s in (5× movetime), only 9 info lines total.
                  We call this.stop() to force a bestmove.
11:27:29.344  [engine] watchdog: responsive engine still owes bestmove
                after stop — waiting up to 5 s more
                ↑ 1.5 s post-stop check: still no bestmove.
                  We're now waiting for the 5-s hard backstop.
... NOTHING for ~20 s ...
11:27:48.638  [click] #btn-toggle-toolbar  (user gives up)
11:28:00.227  [click] #btn-download-log
```

The 5-second hard backstop (intended to fire synthetic `bestmove`
with `stuck:true` so the UI unfreezes) is set as a `setTimeout(...,
5000)` from the watchdog firing point. It should have fired at
`11:27:32.837`. There is no log line for it. Either:

- It didn't fire (timer leaked / overridden / cleared), OR
- It fired but its synthetic event went to a listener that then
  silently bailed (looks unlikely but possible).

The user might also have a stale cached `engine.js` (we serve via
Express static; deploys go through Render). That's hypothesis #1.

But even if the backstop fires correctly, that's a band-aid. The
real problem is the engine wedging in the first place. **Why is
Stockfish wedging mid-search every other game?**

---

## Pattern across multiple captured logs

It's not a one-off. We have logs over multiple sessions showing:

- Practice game starts, engine plays its first move fine.
- A few moves in (3rd, 5th, 8th — varies), the engine starts a
  search, emits some info, then stops responding entirely.
- Sometimes the silent-engine detector at 2 s catches it
  (`infoReceived === 0` at 2 s mark) and triggers a
  flavor-switch ritual that successfully reboots the engine.
- Sometimes the engine emits a few info lines (so it's NOT zero) and
  then dies — the silent detector misses it because the threshold is
  "zero info." The watchdog at 5× movetime is the only safety net.

Recovery strategies tried:
- `engine.stop()` — sometimes works, sometimes the worker doesn't
  honor it.
- Synthetic `bestmove` event with `stuck:true` — UI unfreezes, but
  the next search wedges the same way.
- `switchEngineFlavor` — terminate the worker, do a `lite-single`
  warmup, recreate as `full`. Works ~50% of the time, fails
  deterministically the other 50%.

---

## The relevant code

### `src/engine.js` (engine wrapper, ~790 lines, key sections only)

#### `start(fen, opts)` and `_doStart(fen, opts)`

```js
start(fen, opts = {}) {
  if (!this.ready) {
    console.log('[engine] start() ignored — engine not ready yet');
    return;
  }
  // No barrier — stop() + doStart same tick. The readyok-barrier
  // approach stalled the engine when readyok was swallowed by a
  // background bignet-swap _waitFor.
  const wasSearching = this.searching;
  this.stop();
  // Each `go` → exactly one bestmove. When rapid starts stack up,
  // we DROP all but the last bestmove via _pendingGos counting.
  this._pendingGos = (this._pendingGos || 0) + 1;
  this._doStart(fen, opts);
}

_doStart(fen, opts = {}) {
  this.history  = [];
  this.topMoves = new Map();
  this.searching = true;
  this.stopRequested = false;
  this.currentFen = fen;
  // Separate from `searching` because stop() sets searching=false
  // immediately on the JS side while the worker may still owe us
  // a bestmove. The synthetic-bestmove watchdog checks this flag.
  this._bestmoveAwaited = true;

  this._searchId = (this._searchId || 0) + 1;
  const myId = this._searchId;
  this._infoReceived = 0;
  this._infoDropped = 0;
  this._infoDispatched = 0;
  this._lastInfoAt = 0;

  // ── Health check at 2 s ──
  if (this._healthCheckId) clearTimeout(this._healthCheckId);
  this._healthCheckId = setTimeout(() => {
    this._healthCheckId = 0;
    if (this._searchId !== myId) return;
    if (!this.searching) return;
    const state = {
      searchId: myId, elapsed_ms: 2000,
      infoReceived: this._infoReceived,
      infoDropped: this._infoDropped,
      infoDispatched: this._infoDispatched,
      stopRequested: this.stopRequested,
      uciokReceived: this.uciokReceived,
      workerAlive: !!this.worker,
      lastInfoAgo_ms: this._lastInfoAt ? Date.now() - this._lastInfoAt : null,
    };
    if (this._infoReceived === 0) {
      console.error('[engine] ⚠ MISMATCH: 2 s passed, _doStart fired, but worker emitted ZERO info lines.', state);
      try { window.dispatchEvent(new CustomEvent('engine-silent-detected', { detail: state })); } catch {}
    } else if (this._infoDispatched === 0 && this._infoDropped > 0) {
      console.error('[engine] ⚠ MISMATCH: info lines arriving BUT all dropped by stopRequested guard.', state);
    } else {
      console.log('[engine] health check OK', state);
    }
  }, 2000);

  // ── Bestmove watchdog at 5× movetime ──
  if (this._watchdogId) clearTimeout(this._watchdogId);
  const budget = opts.movetime
    ? Math.max(5000, opts.movetime * 5)
    : (opts.depth ? 60_000 : 60_000);
  this._watchdogId = setTimeout(() => {
    if (!this._bestmoveAwaited) return;
    const responsive = (this._infoReceived || 0) > 0;
    console.warn('[engine] bestmove watchdog fired — forcing stop', {
      responsive, infoReceived: this._infoReceived || 0,
    });
    this.stop();
    const fireSynthetic = (reason) => {
      if (!this._bestmoveAwaited) return false;
      console.error(`[engine] worker wedged (${reason}) — emitting synthetic bestmove`);
      this._bestmoveAwaited = false;
      this.searching = false;
      this.dispatchEvent(new CustomEvent('bestmove', {
        detail: { best: null, ponder: null, topMoves: [], history: this.history, stuck: true }
      }));
      return true;
    };
    setTimeout(() => {
      if (!this._bestmoveAwaited) return;
      if (responsive) {
        console.warn('[engine] watchdog: responsive engine still owes bestmove after stop — waiting up to 5 s more');
        return;
      }
      fireSynthetic('silent');
    }, 1500);
    // Hard backstop: 5 s after the watchdog fired, if STILL no
    // bestmove regardless of earlier responsiveness, give up.
    setTimeout(() => {
      fireSynthetic('responsive but stop ignored');
    }, 5000);
  }, budget);

  this._send(`position fen ${fen}`);

  const bits = ['go'];
  if (opts.infinite) {
    bits.push('infinite');
  } else {
    if (opts.depth)    bits.push('depth', String(opts.depth));
    if (opts.movetime) bits.push('movetime', String(opts.movetime));
    if (!opts.depth && !opts.movetime) bits.push('depth', '18');
  }
  if (opts.searchmoves && opts.searchmoves.length)
    bits.push('searchmoves', ...opts.searchmoves);
  this._send(bits.join(' '));
}
```

#### `stop()` and `terminate()`

```js
stop() {
  if (!this.worker) return;
  if (this.searching) {
    const caller = (new Error().stack || '').split('\n').slice(2, 4).map(s => s.trim()).join(' ← ');
    console.log('[engine] stop() called', {
      wasSearching: true, caller,
      searchId: this._searchId,
      infoReceivedSoFar: this._infoReceived,
      infoDispatchedSoFar: this._infoDispatched,
    });
    this.stopRequested = true;
  }
  this._send('stop');
  this.searching = false;
}

terminate() {
  this.stop();
  if (this._watchdogId)    { clearTimeout(this._watchdogId);    this._watchdogId = 0; }
  if (this._healthCheckId) { clearTimeout(this._healthCheckId); this._healthCheckId = 0; }
  this._bestmoveAwaited = false;
  if (this.worker) { this.worker.terminate(); this.worker = null; }
  this.ready = false;
}
```

#### `_handleLine(line)` — UCI message dispatcher

```js
_handleLine(line) {
  if (typeof line !== 'string') return;
  if (line.startsWith('uciok')) this.uciokReceived = true;

  if (line.startsWith('info')) {
    this._infoReceived = (this._infoReceived || 0) + 1;
    this._lastInfoAt = Date.now();
    if (this.stopRequested) {
      this._infoDropped = (this._infoDropped || 0) + 1;
      return;
    }
    const info = parseInfo(line);
    if (!info || info.pv == null) return;
    this._infoDispatched = (this._infoDispatched || 0) + 1;
    this.topMoves.set(info.multipv, info);
    if (info.multipv === 1) this.history.push({ /* ... */ });
    this.dispatchEvent(new CustomEvent('thinking', { detail: { /* ... */ }}));
  }
  else if (line.startsWith('bestmove')) {
    this._pendingGos = Math.max(0, (this._pendingGos || 1) - 1);
    if (this._pendingGos > 0) {
      console.log('[engine] suppressed stale bestmove (still expecting ' + this._pendingGos + ' more)', line);
      return;
    }
    this.searching = false;
    this._bestmoveAwaited = false;
    this.stopRequested = false;
    if (this._healthCheckId) { clearTimeout(this._healthCheckId); this._healthCheckId = 0; }
    if (this._watchdogId) { clearTimeout(this._watchdogId); this._watchdogId = 0; }
    this._applyPending();
    const m = line.match(/^bestmove\s+(\S+)(?:\s+ponder\s+(\S+))?/);
    const detail = { best: m ? m[1] : null, ponder: m ? m[2] : null, /* ... */ };
    this.dispatchEvent(new CustomEvent('bestmove', { detail }));
  }
}
```

#### Boot-time silent-engine detector + auto-recovery (in `main.js`)

```js
window.addEventListener('engine-silent-detected', (ev) => {
  // Don't recover during practice replay (false positives).
  if (window.__practiceReplayInProgress) return;
  console.error('[engine] silent-engine detected — auto-recovering to ' + currentFlavor);
  switchEngineFlavor(currentFlavor)
    .then(() => console.log('[engine] auto-recovery completed'))
    .catch(err => console.error('[engine] auto-recovery FAILED', err));
});

async function switchEngineFlavor(targetFlavor) {
  const spec = ENGINE_FLAVORS[targetFlavor];
  const targetIsMT = !!(spec && spec.threaded);
  try { engine.terminate?.(); } catch {}
  await new Promise(r => setTimeout(r, 1500));
  // For MT targets, do a lite-single warmup first — empirically
  // prevents MT→MT silent wedging on a fresh boot.
  if (targetIsMT) {
    engine = new Engine();
    explainer.engine = engine;
    explainer.wire();
    wireEngineCaptureListeners(engine);
    try { await engine.boot({ flavor: 'lite-single' }); } catch (e) {
      console.warn('[engine] ritual warmup failed (continuing):', e.message || e);
    }
    await new Promise(r => setTimeout(r, 1500));
    try { engine.terminate?.(); } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  engine = new Engine();
  explainer.engine = engine;
  explainer.wire();
  if (typeof wireEngineCaptureListeners === 'function') wireEngineCaptureListeners(engine);
  await bootEngine(targetFlavor);
}
```

---

## Specific questions for you

1. **Why does Stockfish (lichess `stockfish-web`, full multi-threaded
   build, 32 threads) silently die mid-search on a Windows machine
   after producing only a few info lines?** It's not boot — boot
   succeeds. It's not a bad position — same position works fine on
   other tries. Memory is plentiful (32 GB).

2. **Is `engine.stop()` (UCI `stop` command) reliably honored by
   Stockfish WASM?** Our experience is it's NOT — sometimes the
   worker just ignores it. What's the right way to force a search
   to terminate? Is there a workaround like sending `quit` or doing
   `worker.postMessage('stop')` directly?

3. **Is there a known issue with Stockfish WASM running 32 threads
   on Windows / Edge?** Browser thread pool issues, memory ordering
   bugs, anything? Should we cap threads (e.g. `Threads = 8`)
   regardless of `navigator.hardwareConcurrency`?

4. **Our auto-recovery does a `lite-single` warmup before booting
   the MT flavor again.** This came from anecdotal experience — MT→MT
   reboot would silent-wedge, but inserting a single-thread warmup
   in between fixed it. Is there a cleaner / more principled approach?

5. **Watchdog architecture review:** is the 5×movetime watchdog with
   2-stage post-stop synthetic-bestmove emit the right design? Or
   should we just `worker.terminate()` and reboot on any wedge,
   since we already do that for silent-at-boot wedges? The risk:
   user has to wait for the boot sequence again.

6. **Better detection signal**: right now we use `infoReceived === 0`
   at 2 s as the "engine is wedged at boot" signal. We need a similar
   reliable signal for "engine wedged mid-search after producing
   some info." `lastInfoAt` is tracked but we don't act on it. Should
   we? E.g. "if `now - lastInfoAt > 4000` AND `searching`, force
   reboot"?

7. **Architecture question**: should we keep two persistent worker
   instances — a "fresh always-ready spare" — and swap to the spare
   the instant the primary wedges? Eliminates the boot delay during
   recovery. Cost: 2x memory (~216 MB for full NNUE). Worth it?

8. **Has anyone reported similar wedge symptoms with `lichess-org/
   stockfish-web` recently?** Any known fix in a newer version?

9. **First-move latency**: even when the engine is fully booted and
   was running idle infinite analysis, its FIRST search after the
   user moves is noticeably slower than subsequent searches at the
   same `movetime`. Visually: after the user moves, a few seconds
   pass before any `info` lines appear, then it bursts to life.
   Subsequent moves return info almost immediately.

   Is this expected behaviour? What I suspect:
   - NNUE network not warm in cache yet (bignet swap from smallnet?)
   - Hash table initialization on first real search
   - Thread pool wakeup from idle infinite analysis
   - `position fen` + `go` UCI handshake getting batched somehow

   Is there a way to **pre-warm** the engine so the first move feels
   as snappy as the second? E.g. run a tiny `go depth 1` immediately
   after boot to force NNUE / hash / thread-pool hot? Or some other
   priming trick lichess uses?

---

## What's working well

- Boot itself is reliable. `uciok` always arrives.
- The single-thread `lite-single` flavor never wedges in our
  testing. It's our recovery anchor.
- `info` line parsing is fine; depth, score, pv all parse correctly.
- The `_pendingGos` queue keeps stale bestmoves from bleeding into
  later searches when start/stop overlaps.

## What's NOT working

- The full multi-threaded build (`full`, `avrukh`, etc.) wedges
  mid-search ~50% of the time on this user's machine.
- Auto-recovery sometimes itself fails silently — the new flavor
  also wedges.
- Even with our hardening, there's clearly a race or a missed signal
  somewhere — the user just had a 20-second hang.

Goal: ship a fix that makes the wedge effectively never user-visible.
Either the wedge stops happening, or recovery is invisible (sub-second
reboot, no UI hang).

Thanks for taking a look.
