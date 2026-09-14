'use strict';

// Step 4, second slice: the escapes get real callers.
//
// The reducer's two escape hatches were tested and unreachable -- nothing
// outside the module called them, so a session stuck in `failed` stayed stuck
// in the running system. This covers the store that holds a state per session
// and the sweep that actually invokes the escapes.
//
// The message reader is injected, so none of this needs a live session.

const assert = require('assert');
const { createSessionStateStore } = require('../opencode/session-state-store');

function evt(type, properties = {}) {
  return { id: 'evt_test', type, properties: { sessionID: 'ses_1', ...properties } };
}

function storeWith(options = {}) {
  const transitions = [];
  const store = createSessionStateStore({
    onTransition: (t) => transitions.push(t),
    ...options,
  });
  return { store, transitions };
}

function assertStoreTracksStatePerSession() {
  const { store } = storeWith();
  store.applyEvent(evt('session.status', { status: { type: 'busy' } }));
  store.applyEvent({ ...evt('session.idle'), properties: { sessionID: 'ses_2' } });

  assert.equal(store.get('ses_1').state, 'thinking');
  assert.equal(store.get('ses_2').state, 'idle');
  // A session we have never heard of is unknown, not missing and not idle.
  assert.equal(store.get('ses_never').state, 'unknown');
}

// The log the brief calls the one irreversible decision. It must carry these
// fields from the first day, whether or not anything consumes it yet.
function assertEveryTransitionReachesTheSink() {
  const { store, transitions } = storeWith();
  store.applyEvent(evt('session.next.prompt.admitted', { delivery: 'steer', messageID: 'msg_1' }));
  store.applyEvent(evt('session.status', { status: { type: 'busy' } }));

  assert.deepEqual(transitions.map((t) => `${t.from}->${t.to}`), ['unknown->submitted', 'submitted->thinking']);
  for (const transition of transitions) {
    assert.equal(transition.sessionId, 'ses_1');
    assert.ok(transition.eventType);
    assert.ok(transition.at);
  }
}

// The sweep is what makes the escapes reachable. A session stuck in a
// non-schedulable state gets a read-only look at its message list; nothing is
// sent, so nothing costs quota.
async function assertSweepResolvesAStuckSessionFromEvidence() {
  const reads = [];
  const { store } = storeWith({
    readSessionActivity: async (sessionId) => {
      reads.push(sessionId);
      return { lastMessageRole: 'assistant', completed: true };
    },
  });

  const start = Date.now();
  store.applyEvent(evt('session.error', {
    error: { name: 'ContextOverflowError', data: { message: 'context too long' } },
  }));
  assert.equal(store.get('ses_1').state, 'failed');

  // Stuck means stuck: silent past the window, not merely non-schedulable.
  const result = await store.sweep({ sessions: [{ sessionId: 'ses_1' }], staleAfterMs: 60000, now: start + 60001 });

  assert.deepEqual(reads, ['ses_1'], 'the sweep must actually read the session');
  assert.equal(store.get('ses_1').state, 'idle');
  assert.equal(result.resolved, 1);
}

// Inconclusive evidence plus enough silence degrades to unknown rather than
// leaving the session in a state we no longer believe.
async function assertSweepDegradesWhenEvidenceIsInconclusive() {
  const { store } = storeWith({
    readSessionActivity: async () => ({ lastMessageRole: 'user', completed: false }),
  });

  const start = Date.now();
  store.applyEvent(evt('session.error', { error: { name: 'APIError', data: { message: 'boom', statusCode: 500 } } }));
  assert.equal(store.get('ses_1').state, 'failed');

  // Not silent long enough yet: nothing happens.
  await store.sweep({ sessions: [{ sessionId: 'ses_1' }], staleAfterMs: 300000, now: start + 1000 });
  assert.equal(store.get('ses_1').state, 'failed');

  // Past the window: degrade.
  const result = await store.sweep({ sessions: [{ sessionId: 'ses_1' }], staleAfterMs: 300000, now: start + 300001 });
  assert.equal(store.get('ses_1').state, 'unknown');
  assert.equal(store.get('ses_1').lastError, 'boom', 'degrading must keep why it failed');
  assert.equal(result.staled, 1);
}

// The rescue is for stuck sessions, not for working ones.
//
// A session mid-turn sits in `thinking`, which is not schedulable, so it was
// swept every pass. And between one step ending and the next tool call starting,
// the last message genuinely is a completed assistant message -- so the sweep
// would land in that gap, call it idle, and hand a working agent to the daemon
// as available. That is the Pixel Circuit incident by another route: a prompt to
// a busy agent.
//
// The silence window has to govern the whole rescue, not just the degrade.
async function assertWorkingSessionIsNeverRescuedInsideTheWindow() {
  const reads = [];
  const { store, transitions } = storeWith({
    readSessionActivity: async (sessionId) => {
      reads.push(sessionId);
      // The gap between step.ended and the next step: last message is a
      // completed assistant message even though the turn is still running.
      return { lastMessageRole: 'assistant', completed: true };
    },
  });

  const start = Date.now();
  store.applyEvent(evt('session.status', { status: { type: 'busy' } }));
  assert.equal(store.get('ses_1').state, 'thinking');
  transitions.length = 0;

  // Three seconds of silence, well inside the window.
  const result = await store.sweep({ sessions: [{ sessionId: 'ses_1' }], staleAfterMs: 300000, now: start + 3000 });

  assert.deepEqual(reads, [], 'a session that emitted an event seconds ago must not be read at all');
  assert.equal(store.get('ses_1').state, 'thinking', 'a working session was rescued into idle');
  assert.deepEqual(transitions, []);
  assert.equal(result.inspected, 0, 'a session inside the window is not the sweep\'s business');

  // Past the window, the same evidence does resolve it.
  const rescued = await store.sweep({ sessions: [{ sessionId: 'ses_1' }], staleAfterMs: 300000, now: start + 300001 });
  assert.deepEqual(reads, ['ses_1']);
  assert.equal(store.get('ses_1').state, 'idle');
  assert.equal(rescued.resolved, 1);
}

// A schedulable session is left alone entirely: no read, no transition.
async function assertSweepIgnoresHealthySessions() {
  const reads = [];
  const { store, transitions } = storeWith({
    readSessionActivity: async (sessionId) => {
      reads.push(sessionId);
      return { lastMessageRole: 'assistant', completed: true };
    },
  });

  store.applyEvent(evt('session.idle'));
  transitions.length = 0;

  await store.sweep({ sessions: [{ sessionId: 'ses_1' }], staleAfterMs: 1, now: Date.now() + 10000 });
  assert.deepEqual(reads, [], 'an idle session must not be read');
  assert.deepEqual(transitions, []);
}

// A failing read must not take the sweep down, and must not invent a state.
async function assertSweepSurvivesAFailingRead() {
  const { store } = storeWith({
    readSessionActivity: async () => { throw new Error('opencode unreachable'); },
  });

  const start = Date.now();
  store.applyEvent(evt('session.error', { error: { name: 'APIError', data: { message: 'boom' } } }));
  const result = await store.sweep({ sessions: [{ sessionId: 'ses_1' }], staleAfterMs: 300000, now: start + 300001 });

  assert.equal(store.get('ses_1').state, 'failed', 'a failed read must not change the state');
  assert.equal(result.failed, 1);
}

// Dropping the stream is what makes a state untrustworthy in the first place.
function assertDisconnectMarksUnknownAndKeepsWhatItWasDoing() {
  const { store } = storeWith();
  store.applyEvent(evt('session.status', { status: { type: 'busy' } }));
  store.disconnect('ses_1');

  assert.equal(store.get('ses_1').state, 'unknown');
  assert.equal(store.get('ses_1').previousState, 'thinking');
}

// Sessions that no longer exist must not accumulate forever.
function assertForgetDropsASession() {
  const { store } = storeWith();
  store.applyEvent(evt('session.idle'));
  assert.equal(store.size(), 1);
  store.forget('ses_1');
  assert.equal(store.size(), 0);
  assert.equal(store.get('ses_1').state, 'unknown');
}

async function main() {
  assertStoreTracksStatePerSession();
  assertEveryTransitionReachesTheSink();
  await assertSweepResolvesAStuckSessionFromEvidence();
  await assertSweepDegradesWhenEvidenceIsInconclusive();
  await assertWorkingSessionIsNeverRescuedInsideTheWindow();
  await assertSweepIgnoresHealthySessions();
  await assertSweepSurvivesAFailingRead();
  assertDisconnectMarksUnknownAndKeepsWhatItWasDoing();
  assertForgetDropsASession();

  console.log('Session state store validation passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
