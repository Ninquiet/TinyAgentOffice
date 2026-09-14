'use strict';

// Holds one state per session and is where the reducer's escape hatches are
// actually invoked.
//
// The reducer is pure and knows nothing about time or I/O. This is the thin
// layer that owns the map, feeds events in, and runs the sweep that rescues
// sessions stuck in a state nothing will move them out of. Without this, the
// deadlock is solved in the reducer's world and not in the running one.

const sessionState = require('./session-state');

function createSessionStateStore(options = {}) {
  const states = new Map();
  const onTransition = typeof options.onTransition === 'function' ? options.onTransition : null;
  // Injected so the sweep is testable without a live session. In production
  // this reads the session's message list: it sends nothing and costs no quota.
  const readSessionActivity = typeof options.readSessionActivity === 'function'
    ? options.readSessionActivity
    : null;

  function emit(transition) {
    if (onTransition) onTransition(transition);
  }

  function get(sessionId) {
    return states.get(sessionId) || sessionState.initialState(sessionId);
  }

  function set(sessionId, next) {
    states.set(sessionId, next);
    return next;
  }

  function applyEvent(event) {
    const sessionId = event && event.properties && event.properties.sessionID;
    if (!sessionId) return null;
    return set(sessionId, sessionState.reduce(get(sessionId), event, { onTransition: emit }));
  }

  function disconnect(sessionId) {
    if (!sessionId) return null;
    return set(sessionId, sessionState.markStreamDisconnected(get(sessionId), { onTransition: emit }));
  }

  function forget(sessionId) {
    states.delete(sessionId);
  }

  function size() {
    return states.size;
  }

  function silentForMs(state, now) {
    const reference = Date.parse(state.updatedAt || state.lastEventAt || '');
    if (!Number.isFinite(reference)) return Number.POSITIVE_INFINITY;
    return now - reference;
  }

  // The rescue pass, for sessions that are both unschedulable AND silent past
  // the window. Working sessions are none of its business.
  //
  // 1. Read its message list. Unambiguous evidence that the turn is over
  //    resolves it to idle.
  // 2. Otherwise degrade it to `unknown`, which is honest and still escapable.
  //
  // Nothing here sends a prompt, and a session that stays unschedulable is left
  // for a user decision rather than guessed at.
  async function sweep({ sessions = [], staleAfterMs = 5 * 60 * 1000, now = Date.now() } = {}) {
    const result = { inspected: 0, resolved: 0, staled: 0, failed: 0 };

    for (const session of sessions) {
      const sessionId = session && session.sessionId;
      if (!sessionId) continue;

      const current = get(sessionId);
      if (sessionState.isSchedulable(current)) continue;

      // The silence window governs the whole rescue, not just the degrade below.
      //
      // A session mid-turn sits in `thinking`, which is not schedulable, so
      // without this it was read on every pass -- and between one step ending
      // and the next starting, its last message genuinely is a completed
      // assistant message. The sweep would land in that gap, call a working
      // agent idle, and hand it to the daemon as available. That is the original
      // incident by another route.
      //
      // A session that emitted an event seconds ago does not need rescuing. This
      // also means only silent sessions are ever read, so an active office costs
      // no message-list reads at all.
      if (silentForMs(current, now) < staleAfterMs) continue;

      result.inspected += 1;
      let observation = null;

      if (readSessionActivity) {
        try {
          observation = await readSessionActivity(sessionId, session);
        } catch (_) {
          // An unreachable server tells us nothing, so we conclude nothing.
          result.failed += 1;
          continue;
        }
      }

      if (observation) {
        const observed = sessionState.applyIdleObservation(current, observation, { onTransition: emit });
        if (observed !== current) {
          set(sessionId, observed);
          result.resolved += 1;
          continue;
        }
      }

      const staled = sessionState.markStale(current, {
        reason: `no conclusive activity for ${Math.round(staleAfterMs / 1000)}s`,
        onTransition: emit,
      });
      if (staled !== current) {
        set(sessionId, staled);
        result.staled += 1;
      }
    }

    return result;
  }

  return {
    get,
    applyEvent,
    disconnect,
    forget,
    size,
    sweep,
  };
}

module.exports = {
  createSessionStateStore,
};
