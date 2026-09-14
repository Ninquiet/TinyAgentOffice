'use strict';

// Domain-free runner for the world tick.
//
// It owns exactly one thing: making sure a single `advance` function runs
// repeatedly and never overlaps with itself. It knows nothing about the
// dashboard, the coordination store, or the agent runtime, so the same runner
// can later be constructed inside the daemon process instead of the dashboard
// server without touching this file.
//
// The next pass is scheduled when the previous one finishes, rather than on a
// fixed interval. `intervalMs` is therefore the gap between passes, not the
// period: the cadence self-regulates when a pass runs long, instead of firing
// into a pass that is still running and dropping the wake-up.

const DEFAULT_INTERVAL_MS = 1000;

function createWorldTick(options = {}) {
  const advance = options.advance;
  if (typeof advance !== 'function') {
    throw new Error('createWorldTick requires an advance function.');
  }

  const intervalMs = Number.isInteger(options.intervalMs) && options.intervalMs > 0
    ? options.intervalMs
    : DEFAULT_INTERVAL_MS;
  const onError = typeof options.onError === 'function' ? options.onError : null;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const label = options.label || 'world-tick';

  const state = {
    timer: null,
    started: false,
    inFlight: null,
    runs: 0,
    coalesced: 0,
    errors: 0,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastDurationMs: null,
    lastError: null,
  };

  // Returns the in-flight run when one is already active, so callers that need
  // a fresh world state can await the current pass instead of starting a second
  // one. This is the mutual exclusion the render path used to lack.
  function runOnce() {
    if (state.inFlight) {
      state.coalesced += 1;
      return state.inFlight;
    }

    const startedAtMs = now();
    state.lastStartedAt = new Date(startedAtMs).toISOString();

    const run = Promise.resolve()
      .then(() => advance())
      .then((result) => {
        state.lastError = null;
        return result;
      })
      .catch((error) => {
        state.errors += 1;
        state.lastError = error && error.message ? error.message : String(error);
        if (onError) onError(error);
        return null;
      })
      .then((result) => {
        const finishedAtMs = now();
        state.runs += 1;
        state.lastFinishedAt = new Date(finishedAtMs).toISOString();
        state.lastDurationMs = finishedAtMs - startedAtMs;
        state.inFlight = null;
        return result;
      });

    state.inFlight = run;
    return run;
  }

  function scheduleNext(delayMs) {
    if (!state.started || state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      if (!state.started) return;
      // runOnce never rejects; it folds failures into lastError.
      runOnce().then(() => scheduleNext(intervalMs));
    }, delayMs);
    if (options.unref && typeof state.timer.unref === 'function') {
      state.timer.unref();
    }
  }

  // A tick that has been started ticks: the first pass runs right away, and each
  // subsequent pass is scheduled `intervalMs` after the previous one finished.
  function start() {
    if (state.started) return;
    state.started = true;
    scheduleNext(0);
  }

  function stop() {
    state.started = false;
    if (!state.timer) return;
    clearTimeout(state.timer);
    state.timer = null;
  }

  function isRunning() {
    return Boolean(state.inFlight);
  }

  function getStatus() {
    return {
      label,
      intervalMs,
      started: state.started,
      running: Boolean(state.inFlight),
      runs: state.runs,
      // External callers that joined a pass already in flight. Timer wake-ups
      // cannot land here: the next one is only scheduled once a pass finishes.
      coalesced: state.coalesced,
      errors: state.errors,
      lastStartedAt: state.lastStartedAt,
      lastFinishedAt: state.lastFinishedAt,
      lastDurationMs: state.lastDurationMs,
      lastError: state.lastError,
    };
  }

  return {
    runOnce,
    start,
    stop,
    isRunning,
    getStatus,
  };
}

module.exports = {
  createWorldTick,
  DEFAULT_INTERVAL_MS,
};
