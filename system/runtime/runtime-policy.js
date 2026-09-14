'use strict';

// Runtime policy: the numbers that decide how the office behaves.
//
// These were three constants in three files, and each one turned out to be
// policy wearing the costume of a constant:
//
// - The prompt caps existed but nobody passed them, so they never fired.
// - STALLED_ACTIVITY_WINDOW_MS lived in coordination-core, chosen for a
//   timestamp heuristic that no longer exists, and now governs how long a
//   session may be silent before the sweep stops believing its state.
// - PING_GRACE_MS lived in the watchdog, chosen as "time since we pinged an
//   agent" back when the watchdog sent pings. It has measured "time since the
//   state became unusable" ever since pings were removed, and was never
//   recalibrated for that meaning.
//
// Keeping them together is not tidiness. A test that needs a five second stall
// window instead of five minutes changes policy rather than reaching for a
// test-only knob, which is the same distinction that made the prompt caps
// reachable in the first place. And it is the shape user-configurable workflow
// needs: this is where "how patient is this office" will be edited.
//
// The policy is process-wide and read at the point of use, so setPolicy applies
// to work that has already been constructed.

const DEFAULT_POLICY = {
  // A runaway stop, not a budget. The incident that started all of this put
  // fourteen prompts on one task; a long task with reviews can need a dozen.
  maxPromptsPerTask: 20,

  // Deliberately off. A cost cap firing halts the agent that hits it, and
  // choosing a number before ever measuring a real turn would stop the office at
  // an arbitrary point. `cost` comes from OpenCode's own per-message reporting
  // and the closing run is the first time it is collected. Set this once there
  // are real numbers; the game's spending mechanic reads the same measurement.
  maxSessionCost: null,

  // How long a session may be silent before the sweep stops believing its state
  // and degrades it to `unknown`. Previously STALLED_ACTIVITY_WINDOW_MS.
  staleAfterMs: 5 * 60 * 1000,

  // How long a session may sit in an unusable state before the watchdog hands
  // its task back. Previously PING_GRACE_MS. Inherited, and never recalibrated
  // for what it measures today -- a candidate to revisit once the closing run
  // shows how long real recoveries take.
  releaseGraceMs: 2 * 60 * 1000,
};

let current = { ...DEFAULT_POLICY };

function getPolicy() {
  return { ...current };
}

function setPolicy(overrides = {}) {
  current = { ...current, ...overrides };
  return getPolicy();
}

function resetPolicy() {
  current = { ...DEFAULT_POLICY };
  return getPolicy();
}

// Only what the ledger can act on, so an ill-typed override is ignored rather
// than silently disabling a cap.
function resolveLimits(overrides = {}) {
  const policy = { ...current, ...overrides };
  const limits = {};
  if (Number.isInteger(policy.maxPromptsPerTask) && policy.maxPromptsPerTask > 0) {
    limits.maxPromptsPerTask = policy.maxPromptsPerTask;
  }
  if (Number.isFinite(policy.maxSessionCost) && policy.maxSessionCost > 0) {
    limits.maxSessionCost = policy.maxSessionCost;
  }
  return limits;
}

module.exports = {
  DEFAULT_POLICY,
  getPolicy,
  setPolicy,
  resetPolicy,
  resolveLimits,
};
