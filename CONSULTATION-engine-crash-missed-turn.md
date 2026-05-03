# Stockfish WASM crash + missed engine move after recovery - second opinion request

## TL;DR

Browser chess-practice app. On a fresh browser/login, the default
Stockfish 18 full multi-thread WASM engine boots, prewarms, starts
analysis, then hard-crashes inside the WASM worker:

```text
Uncaught RuntimeError: memory access out of bounds
@ stockfish-18.wasm,worker:8:28163
```

After that, the UI can reach a state where the engine side simply
does not move. This no longer looks like just a "slow/wedged search".
It looks like:

1. The WASM worker actually traps/crashes.
2. Our app logs `worker.onerror` but keeps treating the engine as usable.
3. Auto-recovery swaps through a temporary `lite-single` warmup engine.
4. While recovery is happening, user moves can call `fireAnalysis()`.
5. `fireAnalysis()` may start/queue work on the temporary warmup engine,
   which is then terminated as part of the ritual.
6. The intended engine move is lost, so the side to move waits forever
   unless another user action retriggers analysis.

We need advice on the right architecture: safer default engine, crash
handling, and how to preserve/replay engine-turn requests during recovery.

---

## Environment

From attached log:

```text
generated:  2026-05-03T21:57:30.831Z
userAgent:  Mozilla/5.0 (Windows NT 10.0; Win64; x64)
            AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36
hostname:   stockfish-explain-dev.onrender.com
deviceRAM:  32 GB (quantized)
cores:      64
coop/coep:  true
```

Engine:

- Stockfish 18 WASM, Chess.com / nmrugg stockfish.js distribution.
- Default flavor currently `full` = 108 MB NNUE, multi-threaded.
- Thread cap was reduced from 32 to 8 after prior consultation.
- Hash default is 256 MB.
- Page is cross-origin isolated.

Important correction from earlier debugging: this checkout is not
currently using lichess-org/stockfish-web for the default engine.
`assets/stockfish/stockfish-18.js` identifies as nmrugg/stockfish.js.

---

## New failure log

The engine boots and prewarm apparently succeeds:

```text
21:52:15.174 [engine] bestmove {"best":"d2d4","infoReceived":6,"infoDispatched":3}
21:52:15.507 [engine] prewarm complete
21:52:15.507 [engine] booted {"flavor":"full","threads":8,"threaded":true}
21:52:15.871 [engine] _doStart {"searchId":1,
  "fen":"startpos-ish", "opts":{"infinite":true},
  "uciokReceived":true,"workerAlive":true}
```

Then the worker hard-crashes:

```text
21:52:21.036 Stockfish worker error: {"isTrusted":true}
21:52:21.036 uncaught: Uncaught [object ErrorEvent]
              @ /assets/stockfish/stockfish-18.js:8:7756
21:52:21.036 Stockfish worker error: {"isTrusted":true}
21:52:21.036 uncaught: Uncaught RuntimeError: memory access out of bounds
              @ /assets/stockfish/stockfish-18.js#/assets/stockfish/stockfish-18.wasm,worker:8:28163
```

That `memory access out of bounds` pattern repeats dozens of times in
the same millisecond burst, presumably from multiple pthread workers.

Our health check still says the search looked okay right before it died:

```text
21:52:21.081 [engine] health check OK {
  "searchId":1,
  "elapsed_ms":2000,
  "infoReceived":30,
  "infoDropped":0,
  "infoDispatched":27,
  "stopRequested":false,
  "uciokReceived":true,
  "workerAlive":true,
  "lastInfoAgo_ms":9
}
```

Six seconds later, the stall detector fires:

```text
21:52:27.074 [engine] STALL: no info for 6s during search - declaring wedged
21:52:27.074 [engine] worker wedged (stalled - no info 6s) - emitting synthetic bestmove
```

So we are detecting the symptom late. The actual fatal signal was
`worker.onerror` at 21:52:21.

---

## Later same session: corrupted worker state

User clicks New Game. The app starts analysis again on what appears to
be a broken/corrupted engine:

```text
21:54:15.153 [engine] _doStart {"searchId":2,"fen":"startpos-ish",
  "opts":{"infinite":true},"uciokReceived":true,"workerAlive":true}
21:54:15.190 Stockfish worker error: {"isTrusted":true}
21:54:15.190 uncaught: Uncaught RuntimeError: null function
              @ /assets/stockfish/stockfish-18.wasm:1:358402
21:54:15.190 uncaught: Uncaught RuntimeError: Aborted().
```

Then the zero-info detector starts recovery:

```text
21:54:17.154 [engine] MISMATCH: 2 s passed, _doStart fired, but worker emitted ZERO info lines
21:54:17.154 [engine] silent-engine detected - auto-recovering to full
21:54:18.656 [engine] ritual: lite-single -> full
```

---

## The missed-turn race during recovery

While the recovery ritual is running, the user makes a move:

```text
21:54:19.351 [move] chess.move OK {"san":"e4","from":"e2","to":"e4"}
21:54:19.361 [engine] dropped pre-uciok stop
21:54:19.361 [engine] start() ignored - engine not ready yet
21:54:19.471 [engine] prewarm complete
```

Interpretation:

- `switchEngineFlavor("full")` is in progress.
- It creates a new `Engine()` for a temporary `lite-single` warmup and
  assigns it to the global `engine`.
- It wires the explainer/listeners to that temporary warmup engine.
- But `engineReady` in `main.js` appears to remain true from the old
  full engine until `bootEngine()` is called for the final engine.
- Therefore `fireAnalysis()` can see `engineReady === true`, call
  `engine.start(...)`, and hit the temporary engine before it is ready.
- That start is ignored.
- If the side to move belongs to the engine, no durable request is saved.

Then the user manually continues moving both sides, and another engine
search is started on the warmup engine:

```text
21:54:20.052 [engine] _doStart {"searchId":1,"fen":"after 1.e4 c5", "opts":{"infinite":true}}
21:54:20.973 [engine] stop() called ... at switchEngineFlavor ... terminating warmup
```

So work can be sent to the warmup engine and then intentionally killed
by the ritual. That creates a very plausible "engine side never moves"
failure after recovery.

---

## Relevant code shape

### Worker error handling currently logs but does not invalidate engine

```js
this.worker.onmessage = (e) => this._handleLine(e.data);
this.worker.onerror   = (e) => {
  console.error('Stockfish worker error:', e);
  this.dispatchEvent(new CustomEvent('error', { detail: e }));
};
```

During boot, a temporary wrapper rejects on `worker.onerror`, but after
boot, normal runtime `worker.onerror` only logs. It does not set
`ready=false`, does not terminate the worker, and does not request
fallback.

### `switchEngineFlavor()` uses a temporary warmup engine as global

```js
async function switchEngineFlavor(targetFlavor) {
  const spec = ENGINE_FLAVORS[targetFlavor];
  const targetIsMT = !!(spec && spec.threaded);
  try { engine.terminate?.(); } catch {}
  await new Promise(r => setTimeout(r, 1500));

  if (targetIsMT) {
    console.log('[engine] ritual: lite-single -> ' + targetFlavor);
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
  wireEngineCaptureListeners(engine);
  await bootEngine(targetFlavor);
}
```

Concern: the warmup engine is assigned to global `engine`, so live board
events can route through it. Also `engineReady` may not be set false for
the whole recovery period. This creates an inconsistent state:

```text
main.js engineReady flag: true
current Engine.ready: false or temporary
recovery ritual: will terminate the current Engine soon
fireAnalysis: may call engine.start() anyway
```

### Practice start has a ready retry, but only in one path

At practice start:

```js
fireAnalysis();
if (!engineReady) {
  const readyRetry = () => {
    engine.removeEventListener('ready', readyRetry);
    console.log('[practice] engine became ready - retrying fireAnalysis');
    fireAnalysis();
  };
  engine.addEventListener('ready', readyRetry);
  setTimeout(() => fireAnalysis(), 1000);
  setTimeout(() => fireAnalysis(), 3000);
  setTimeout(() => fireAnalysis(), 6000);
}
```

This helps if `engineReady` is false. But the log suggests a state where
`engineReady` is true even though the current `engine.ready` is false or
temporary. In that state, the retry is not armed.

---

## Questions for reviewer

1. Given the repeated `RuntimeError: memory access out of bounds` inside
   `stockfish-18.wasm,worker`, should we treat any `worker.onerror`
   after boot as fatal and immediately:
   - mark engine not ready,
   - terminate the worker,
   - emit a stuck/crashed bestmove if a practice engine turn is waiting,
   - and reboot/fallback?

2. Is `full` 108 MB NNUE + 8 threads + 256 MB hash too aggressive as a
   browser default for nmrugg/stockfish.js on Windows/Edge, even on a
   32 GB / 64-core machine? Should stable defaults be:
   - `lite` instead of `full`,
   - 4 threads instead of 8,
   - smaller hash,
   - or single-thread for practice mode?

3. Would you stop using the `lite-single -> full` warmup ritual entirely?
   It was an empirical workaround for MT->MT silent wedges, but now it
   creates a race where live analysis can be sent to the temporary warmup
   engine. Is prewarm inside the final engine enough?

4. If the warmup ritual remains, should the temporary warmup engine be
   private/local instead of assigned to global `engine` and wired into
   the UI? For example:

   ```js
   const warmup = new Engine();
   await warmup.boot({ flavor: 'lite-single' });
   warmup.terminate();
   // only now replace global engine with final Engine()
   ```

5. Should `main.js` use both `engineReady` and `engine.ready`, or replace
   the separate `engineReady` boolean with a single source of truth?
   The log suggests the boolean can drift from the actual current Engine.

6. For practice mode, should an engine-turn request be durable? That is:
   if `fireAnalysis()` determines it is the engine's turn but the engine
   is booting/recovering, set `pendingEngineTurnFen = fen`, then replay
   it when the final engine emits `ready`. This would prevent "white/black
   won't make a move" after crashes.

7. Should recovery fallback be one-way after a crash? Example:

   ```text
   full crashes at runtime -> switch to lite or lite-single, not full again
   ```

   Current recovery often tries to restore the same crashing flavor.
   That can recreate the exact same failure.

8. Is switching from nmrugg/stockfish.js to lichess-org/stockfish-web
   likely to reduce these `memory access out of bounds` failures? Or are
   these mostly generic WASM pthread/browser issues where safer defaults
   matter more than distribution?

---

## Current proposed plan

No code has been changed for this consult. Proposed next implementation:

1. Runtime `worker.onerror` is fatal:
   - mark `ready=false`;
   - clear timers;
   - terminate current worker;
   - emit a stuck/crashed bestmove if one is awaited;
   - dispatch an `engine-crashed` event to main.js.

2. Make recovery state explicit:
   - `engineReady = false` at the start of `switchEngineFlavor()`;
   - maybe `engineRecovering = true`;
   - `fireAnalysis()` should not call `engine.start()` unless both
     `engineReady` and `engine.ready` are true.

3. Do not expose warmup engines to live UI:
   - use a private `const warmup = new Engine()`;
   - do not assign it to global `engine`;
   - do not wire explainer/listeners to it;
   - terminate it before creating final global engine.

4. Durable engine-turn queue:
   - if practice says it is engine's turn but engine is not ready,
     save the FEN/limits and attach a ready retry;
   - after final engine is ready, replay latest pending engine turn.

5. Stable defaults:
   - default `full` -> `lite` for browser practice;
   - cap practice threads at 4;
   - maybe keep `full` as opt-in for analysis mode only.

6. Runtime crash fallback:
   - if `full` crashes once in a session, automatically switch to
     `lite`;
   - if `lite` crashes, switch to `lite-single`;
   - do not keep rebooting the same crashing flavor.

Goal: make "engine side will not move" impossible from the user's
perspective. If the engine crashes, the app should visibly recover or
fallback and then play the pending move, not leave the turn hanging.
