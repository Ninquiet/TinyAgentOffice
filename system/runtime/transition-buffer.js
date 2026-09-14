'use strict';

// Collects state-machine transitions during a world-tick pass and writes them
// out in one batch at the end of it.
//
// Attribution is resolved at flush time, not at write time by the reducer. The
// reducer only knows a session id; which task that session was working on lives
// in the registry and changes as work moves. Resolving it here is the last
// moment the answer still exists -- afterwards it is gone from every source, and
// no later migration can recover it.
//
// Accepted tradeoff: transitions are held in memory until the end of the pass,
// so a process that dies mid-pass loses up to one tick of them. That is a
// deliberate choice for a diagnostic and visualisation log, taken to keep the
// database lock off the hot path. If this log ever becomes load-bearing for a
// decision the system makes, revisit it.

function createTransitionBuffer(options = {}) {
  const resolveContext = typeof options.resolveContext === 'function' ? options.resolveContext : () => null;
  const write = typeof options.write === 'function' ? options.write : null;

  let pending = [];

  function record(transition) {
    if (!transition || !transition.to) return;
    pending.push(transition);
  }

  function enrich(transition) {
    const context = resolveContext(transition.sessionId) || {};
    return {
      at: transition.at,
      sessionId: transition.sessionId || null,
      // Recorded even when unattributable. A transition with null attribution is
      // still evidence; a dropped one is nothing.
      agentSessionId: context.agentSessionId || null,
      agentName: context.agentName || null,
      role: context.role || null,
      taskId: context.taskId || null,
      from: transition.from || null,
      to: transition.to,
      eventType: transition.eventType || null,
      reason: transition.reason || null,
    };
  }

  function flush() {
    if (pending.length === 0) return { written: 0 };
    if (!write) {
      pending = [];
      return { written: 0 };
    }

    const batch = pending.map(enrich);
    try {
      write(batch);
    } catch (error) {
      // A failed write is not the accepted crash case, so the rows stay for the
      // next flush rather than being dropped.
      return { written: 0, error };
    }

    pending = [];
    return { written: batch.length };
  }

  function size() {
    return pending.length;
  }

  return {
    record,
    flush,
    size,
  };
}

module.exports = {
  createTransitionBuffer,
};
