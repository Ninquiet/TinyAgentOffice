'use strict';

// The agent runtime state machine.
//
// A pure reduction of OpenCode's own events into one explicit state per session,
// replacing the timestamp heuristics the scheduler used to infer from. The event
// names here were read from OpenCode 1.18.18's OpenAPI document and confirmed on
// the wire during development.
//
// Two rules shape everything below:
//
// 1. Fail safe. A session we have no evidence about is `unknown`, and only
//    `idle` is schedulable. Guessing is what exhausted a quota once already.
// 2. Never infer progress from unrelated activity. A file edit, an LSP update or
//    a todo change says nothing about whether the agent is busy.

// `completed` is deliberately absent. The obvious source for it,
// session.next.step.ended, is not terminal: a turn runs several steps, so
// entering a terminal-looking state there would flip a working agent into
// something unschedulable mid-turn. session.idle is the only end-of-turn signal
// OpenCode gives us, and that already means `idle`. A separate `completed` would
// be a flicker at best and a trap at worst.
const STATES = [
  'idle',
  'prompt_queued',
  'submitted',
  'thinking',
  'streaming',
  'waiting_permission',
  'waiting_user',
  'rate_limited',
  'failed',
  'unknown',
];

// The only state the daemon may assign new work to.
const SCHEDULABLE = new Set(['idle']);

// States a question or permission prompt can interrupt and safely return to.
// `idle` belongs here: a session that was doing nothing and answered a question
// is doing nothing again, not in an unknown state.
const RESUMABLE = new Set(['idle', 'thinking', 'streaming', 'submitted', 'prompt_queued']);

const WAITING = new Set(['waiting_user', 'waiting_permission']);

// A turn is under way in these; entering any of them means the dropped-turn
// evidence belongs to a turn that is over and done with.
const WORKING = new Set(['prompt_queued', 'submitted', 'thinking', 'streaming']);

// Tools that leave something behind. `read`, `glob` and `bash` do not count:
// the point is what the next attempt would find already written.
const WRITING_TOOLS = new Set(['write', 'edit', 'patch', 'multiedit']);

// A long session can touch a lot of files and this is carried in memory for
// every live session. The list is for a human reading a release note, so a cap
// costs nothing that matters.
const TOUCHED_FILE_LIMIT = 200;

function totalTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') return 0;
  const cache = tokens.cache || {};
  return [tokens.input, tokens.output, tokens.reasoning, cache.read, cache.write]
    .reduce((sum, value) => sum + (Number(value) || 0), 0);
}

// A turn the provider let go of, rather than one that ended.
//
// Observed on a live session: `finish: "unknown"`, zero cost, zero tokens, and
// a message whose last part is a step-finish with reason "unknown". OpenCode
// reports no error for this, so the session simply goes idle and every state
// watcher sees a perfectly ordinary idle session.
//
// `time.completed` is what makes this safe. A message still being written also
// has no finish reason, no cost and no tokens -- 47 of them in the recorded
// run -- and calling those dropped would flag every turn in flight.
function isDroppedTurn(info) {
  if (!info || info.role !== 'assistant') return false;
  if (!info.time || !info.time.completed) return false;
  if (info.finish && info.finish !== 'unknown') return false;
  if ((Number(info.cost) || 0) > 0) return false;
  return totalTokens(info.tokens) === 0;
}

function initialState(sessionId = null) {
  return {
    sessionId,
    state: 'unknown',
    // Diagnostic only: where we came from, whatever that was.
    previousState: null,
    // Load-bearing: the state a question or permission interrupted, so nested
    // interruptions resume the work rather than each other.
    interruptedState: null,
    pendingMessageId: null,
    pendingQuestionIds: [],
    pendingPermissionIds: [],
    // Evidence that the last turn ended without the provider finishing it. Not
    // a state: the turn is genuinely over and the session genuinely idle, which
    // is what makes this case invisible to everything that watches states.
    droppedTurnAt: null,
    droppedTurnMessageId: null,
    // What this session actually produced. Kept so that giving a task back does
    // not throw away the record of what already reached disk.
    touchedFiles: [],
    retry: null,
    // Stable for one continuous rate-limit episode. Retry events update their
    // countdown, but they must not look like new incidents to the secretary.
    rateLimitStartedAt: null,
    lastError: null,
    errorName: null,
    lastEventType: null,
    lastEventAt: null,
    updatedAt: null,
  };
}

function isSchedulable(state) {
  return Boolean(state) && SCHEDULABLE.has(state.state);
}

function nowIso() {
  return new Date().toISOString();
}

function isRateLimitError(error) {
  if (!error) return false;
  const data = error.data || {};
  if (Number(data.statusCode) === 429) return true;
  return /rate.?limit|too many requests|usage limit/i.test(String(data.message || error.message || ''));
}

function withoutId(ids, requestId) {
  return (ids || []).filter((id) => id !== requestId);
}

// What the session goes back to once every question and permission is answered.
// Reads interruptedState, not previousState: with nested interruptions the
// previous state is the other waiting_* state, and resuming into that would
// strand the session.
function resumedState(next) {
  if (next.pendingQuestionIds.length > 0) return 'waiting_user';
  if (next.pendingPermissionIds.length > 0) return 'waiting_permission';
  return RESUMABLE.has(next.interruptedState) ? next.interruptedState : 'unknown';
}

function applyEvent(next, type, properties, at) {
  switch (type) {
    // Not a state transition. The turn really is over and the session really is
    // idle; what this records is that it ended without the provider finishing
    // it, which nothing else in the event stream says.
    case 'message.updated': {
      const info = properties.info || {};
      if (!info.time || !info.time.completed || info.role !== 'assistant') return null;
      if (!isDroppedTurn(info)) {
        return next.droppedTurnAt ? { droppedTurnAt: null, droppedTurnMessageId: null } : null;
      }
      if (next.droppedTurnMessageId === (info.id || null)) return null;
      return { droppedTurnAt: at, droppedTurnMessageId: info.id || null };
    }

    // What the session produced, for the release note. Only completed writes:
    // a tool call still running has not left anything behind yet.
    case 'message.part.updated': {
      const part = properties.part || {};
      if (part.type !== 'tool' || !WRITING_TOOLS.has(part.tool)) return null;
      const state = part.state || {};
      if (state.status !== 'completed') return null;
      const file = state.input && state.input.filePath;
      if (!file || next.touchedFiles.includes(file)) return null;
      if (next.touchedFiles.length >= TOUCHED_FILE_LIMIT) return null;
      return { touchedFiles: [...next.touchedFiles, file] };
    }

    case 'session.status': {
      const status = properties.status || {};
      if (status.type === 'idle') return { state: 'idle' };
      if (status.type === 'busy') return { state: 'thinking' };
      if (status.type === 'retry') {
        return {
          state: 'rate_limited',
          retry: {
            attempt: Number(status.attempt) || 0,
            nextAt: status.next ?? null,
            reason: (status.action && status.action.reason) || null,
            provider: (status.action && status.action.provider) || null,
          },
          lastError: status.message || (status.action && status.action.message) || 'retrying',
        };
      }
      return null;
    }

    case 'session.idle':
      return { state: 'idle', pendingMessageId: null, retry: null };

    case 'session.next.prompt.admitted':
      return {
        state: properties.delivery === 'queue' ? 'prompt_queued' : 'submitted',
        pendingMessageId: properties.messageID || null,
      };

    case 'session.next.prompted':
      return { state: 'submitted' };

    case 'session.next.step.started':
    case 'session.next.reasoning.started':
    case 'session.next.tool.called':
      return { state: 'thinking' };

    case 'session.next.text.started':
    case 'session.next.text.delta':
    case 'session.next.reasoning.delta':
    case 'message.part.delta':
      return { state: 'streaming' };

    // A step ending does not end the turn; the next one usually starts right
    // after. Staying busy is the fail-safe reading, and session.idle is what
    // actually says the turn is over.
    case 'session.next.step.ended':
      return { state: 'thinking' };

    case 'session.error': {
      const error = properties.error || {};
      return {
        state: isRateLimitError(error) ? 'rate_limited' : 'failed',
        errorName: error.name || null,
        lastError: (error.data && error.data.message) || error.message || 'session error',
      };
    }

    case 'session.next.step.failed':
      return {
        state: 'failed',
        errorName: (properties.error && properties.error.type) || null,
        lastError: (properties.error && properties.error.message) || 'step failed',
      };

    case 'question.asked':
    case 'question.v2.asked':
      return {
        state: 'waiting_user',
        pendingQuestionIds: [...next.pendingQuestionIds, properties.requestID].filter(Boolean),
      };

    case 'question.replied':
    case 'question.v2.replied':
    case 'question.rejected':
    case 'question.v2.rejected': {
      const pendingQuestionIds = withoutId(next.pendingQuestionIds, properties.requestID);
      return { state: resumedState({ ...next, pendingQuestionIds }), pendingQuestionIds };
    }

    // Modelled for completeness, but nothing may depend on it: OpenCode
    // currently writes outside the project without asking, so this gate is not
    // reliably reached. Verified in a live session.
    case 'permission.asked':
    case 'permission.v2.asked':
      return {
        state: 'waiting_permission',
        pendingPermissionIds: [...next.pendingPermissionIds, properties.requestID].filter(Boolean),
      };

    case 'permission.replied':
    case 'permission.v2.replied': {
      const pendingPermissionIds = withoutId(next.pendingPermissionIds, properties.requestID);
      return { state: resumedState({ ...next, pendingPermissionIds }), pendingPermissionIds };
    }

    // Everything else - todo.updated, file.edited, lsp.updated, server.connected
    // and the rest of the 93 event types - says nothing about agent state.
    default:
      return null;
  }
}

// Pure. Returns a new state; never mutates the one it was given.
function reduce(state, event, options = {}) {
  const current = state || initialState();
  const type = event && typeof event.type === 'string' ? event.type : null;
  if (!type) return current;

  const properties = (event && event.properties) || {};
  const at = options.now || nowIso();
  const patch = applyEvent(current, type, properties, at);
  if (!patch) return current;

  const next = {
    ...current,
    ...patch,
    sessionId: current.sessionId || properties.sessionID || null,
    lastEventType: type,
    lastEventAt: at,
    updatedAt: at,
  };

  if (patch.state === 'rate_limited') {
    next.rateLimitStartedAt = current.state === 'rate_limited'
      ? current.rateLimitStartedAt || at
      : at;
  } else if (patch.state) {
    next.rateLimitStartedAt = null;
  }

  if (patch.state && patch.state !== current.state) {
    next.previousState = current.state;

    // A new turn is under way, so whatever the last one did or failed to do is
    // history. Cleared here rather than on one specific event because a turn
    // can start from a dispatch or from the user typing in the terminal.
    if (WORKING.has(patch.state)) {
      next.droppedTurnAt = null;
      next.droppedTurnMessageId = null;
    }

    // Record what got interrupted only on the way in, and only from real work.
    // A second interruption on top of the first must not overwrite it.
    if (WAITING.has(patch.state) && !WAITING.has(current.state)) {
      next.interruptedState = current.state;
    } else if (!WAITING.has(patch.state)) {
      next.interruptedState = null;
    }

    if (patch.state !== 'rate_limited' && !Object.prototype.hasOwnProperty.call(patch, 'retry')) {
      next.retry = null;
    }
    if (typeof options.onTransition === 'function') {
      options.onTransition({
        sessionId: next.sessionId,
        from: current.state,
        to: patch.state,
        eventType: type,
        at,
      });
    }
  }

  return next;
}

// The stream is our only source of truth, so losing it means we no longer know.
// What the session was doing is kept, because it is the most useful thing to
// show a user deciding how to recover.
function markStreamDisconnected(state, options = {}) {
  const current = state || initialState();
  if (current.state === 'unknown') return current;
  const at = options.now || nowIso();

  if (typeof options.onTransition === 'function') {
    options.onTransition({
      sessionId: current.sessionId,
      from: current.state,
      to: 'unknown',
      eventType: 'stream.disconnected',
      at,
    });
  }

  return {
    ...current,
    state: 'unknown',
    previousState: current.state,
    rateLimitStartedAt: null,
    updatedAt: at,
  };
}

// Escape hatch 1, from any state that cannot schedule.
//
// Every non-schedulable state needs a way out that does not depend on an event
// arriving, or the office simply stalls there. `unknown` is the obvious one, but
// `failed` and `rate_limited` are only left by session.idle or session.status,
// and `thinking` has the same problem if a turn's last events are missed.
//
// GET /session/status cannot serve this: it returns {} even against a server
// with 72 live sessions. So the evidence is a read of the session's message
// list, which sends nothing and costs no quota. It resolves the state only when
// the evidence is unambiguous - a completed assistant message means the turn is
// over. Anything else leaves the state alone, because a session that stays
// unschedulable is a user decision, and guessing is what caused the incident.
//
// A session with an unanswered question or permission is excluded, and by the
// pending ids rather than by the state name: markStale can move a waiting
// session to `unknown`, and without this an idle-looking message list would
// launder the open question away and make the agent schedulable again.
function applyIdleObservation(state, observation = {}, options = {}) {
  const current = state || initialState();
  if (isSchedulable(current)) return current;
  if (current.pendingQuestionIds.length > 0 || current.pendingPermissionIds.length > 0) return current;

  const conclusive = observation.lastMessageRole === 'assistant' && observation.completed === true;
  if (!conclusive) return current;

  const at = options.now || nowIso();
  if (typeof options.onTransition === 'function') {
    options.onTransition({
      sessionId: current.sessionId,
      from: current.state,
      to: 'idle',
      eventType: 'observation.idle',
      at,
    });
  }

  return {
    ...current,
    state: 'idle',
    previousState: current.state,
    interruptedState: null,
    pendingMessageId: null,
    retry: null,
    rateLimitStartedAt: null,
    updatedAt: at,
  };
}

// Escape hatch 2: admitting we no longer know.
//
// For a session that has sat in a non-schedulable state with no events for long
// enough that the state is not trustworthy. Degrading to `unknown` is honest and
// leaves escape hatch 1 available; staying put would be a dead end. The error
// that got it there is preserved, because it is what a user needs to decide.
//
// This never schedules anything and never sends a prompt. The caller owns the
// policy for how long is too long.
function markStale(state, options = {}) {
  const current = state || initialState();
  if (current.state === 'unknown' || isSchedulable(current)) return current;

  const at = options.now || nowIso();
  if (typeof options.onTransition === 'function') {
    options.onTransition({
      sessionId: current.sessionId,
      from: current.state,
      to: 'unknown',
      eventType: 'state.stale',
      reason: options.reason || null,
      at,
    });
  }

  return {
    ...current,
    state: 'unknown',
    previousState: current.state,
    rateLimitStartedAt: null,
    staleReason: options.reason || null,
    updatedAt: at,
  };
}

module.exports = {
  STATES,
  initialState,
  isSchedulable,
  reduce,
  markStreamDisconnected,
  applyIdleObservation,
  markStale,
};
