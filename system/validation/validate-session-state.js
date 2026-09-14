'use strict';

// Step 4, first slice: the agent runtime state machine.
//
// Written before the module exists. Everything here is a pure reduction over the
// events OpenCode actually emits (verified against 1.18.18), so none of it
// needs a live session or costs quota.

const assert = require('assert');
const sessionState = require('../opencode/session-state');

function evt(type, properties = {}) {
  return { id: 'evt_test', type, properties: { sessionID: 'ses_1', ...properties } };
}

function reduceAll(events, initial) {
  return events.reduce((state, event) => sessionState.reduce(state, event), initial || sessionState.initialState());
}

// Fail safe. An agent we know nothing about must not look schedulable.
function assertFreshSessionIsUnknownAndNotSchedulable() {
  const state = sessionState.initialState();
  assert.equal(state.state, 'unknown');
  assert.equal(sessionState.isSchedulable(state), false);
}

// Only idle schedules. This is the rule the whole incident came down to.
function assertOnlyIdleIsSchedulable() {
  const schedulable = [];
  for (const name of sessionState.STATES) {
    if (sessionState.isSchedulable({ ...sessionState.initialState(), state: name })) {
      schedulable.push(name);
    }
  }
  assert.deepEqual(schedulable, ['idle']);
}

// session.status is the authoritative signal. It carries the whole tri-state.
function assertSessionStatusDrivesTheState() {
  assert.equal(reduceAll([evt('session.status', { status: { type: 'idle' } })]).state, 'idle');
  assert.equal(reduceAll([evt('session.status', { status: { type: 'busy' } })]).state, 'thinking');
  assert.equal(reduceAll([evt('session.idle')]).state, 'idle');
}

function assertStreamingAndThinkingComeFromTheStream() {
  assert.equal(reduceAll([evt('session.next.step.started')]).state, 'thinking');
  assert.equal(reduceAll([evt('session.next.reasoning.started')]).state, 'thinking');
  assert.equal(reduceAll([evt('session.next.text.delta')]).state, 'streaming');
  assert.equal(reduceAll([evt('message.part.delta')]).state, 'streaming');
}

// The runtime tells us when it took a prompt, and whether it queued or steered.
function assertPromptAdmissionIsDistinguished() {
  const queued = reduceAll([evt('session.next.prompt.admitted', { delivery: 'queue', messageID: 'msg_1' })]);
  assert.equal(queued.state, 'prompt_queued');
  assert.equal(queued.pendingMessageId, 'msg_1');

  const steered = reduceAll([evt('session.next.prompt.admitted', { delivery: 'steer', messageID: 'msg_2' })]);
  assert.equal(steered.state, 'submitted');

  assert.equal(reduceAll([evt('session.next.prompted')]).state, 'submitted');
}

// The incident that started all of this. retry is the live indicator; it fires
// whatever the status code is.
function assertRetryStatusIsRateLimited() {
  const state = reduceAll([evt('session.status', {
    status: { type: 'retry', attempt: 3, message: 'usage limit reached', next: 1770000000000 },
  })]);
  assert.equal(state.state, 'rate_limited');
  assert.equal(state.rateLimitStartedAt, state.lastEventAt,
    'the first rate-limit event must identify the incident for downstream deduplication');
  assert.equal(state.retry.attempt, 3);
  assert.equal(state.retry.nextAt, 1770000000000);
  assert.match(state.lastError, /usage limit reached/);

  const repeated = sessionState.reduce(state, evt('session.status', {
    status: { type: 'retry', attempt: 4, message: 'usage limit reached', next: 1770000005000 },
  }), { now: '2026-02-02T00:00:05.000Z' });
  assert.equal(repeated.rateLimitStartedAt, state.rateLimitStartedAt,
    'provider retries are the same rate-limit incident, not new notifications');

  const recovered = sessionState.reduce(repeated, evt('session.status', {
    status: { type: 'idle' },
  }), { now: '2026-02-02T00:00:10.000Z' });
  assert.equal(recovered.rateLimitStartedAt, null,
    'leaving rate_limited must clear the incident marker so a later limit can notify again');
}

function assertApiErrorsAreClassified() {
  const rateLimited = reduceAll([evt('session.error', {
    error: { name: 'APIError', data: { message: 'too many requests', statusCode: 429, isRetryable: true } },
  })]);
  assert.equal(rateLimited.state, 'rate_limited');

  const failed = reduceAll([evt('session.error', {
    error: { name: 'ContextOverflowError', data: { message: 'context too long' } },
  })]);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.errorName, 'ContextOverflowError');

  assert.equal(reduceAll([evt('session.next.step.failed', {
    error: { type: 'unknown', message: 'step blew up' },
  })]).state, 'failed');
}

// Questions are the attention path that actually fires today.
function assertQuestionsSuspendAndResume() {
  const asked = reduceAll([
    evt('session.status', { status: { type: 'busy' } }),
    evt('question.asked', { requestID: 'q1' }),
  ]);
  assert.equal(asked.state, 'waiting_user');
  assert.deepEqual(asked.pendingQuestionIds, ['q1']);

  const replied = reduceAll([evt('question.replied', { requestID: 'q1' })], asked);
  assert.equal(replied.state, 'thinking', 'answering a question must restore the state it interrupted');
  assert.deepEqual(replied.pendingQuestionIds, []);

  const v2 = reduceAll([evt('question.v2.asked', { requestID: 'q2' })]);
  assert.equal(v2.state, 'waiting_user');
  const rejected = reduceAll([evt('question.v2.rejected', { requestID: 'q2' })], v2);
  assert.deepEqual(rejected.pendingQuestionIds, []);
}

// Modelled, but nothing may depend on it firing: OpenCode currently writes
// outside the project with no permission gate, so this path is mostly dead.
function assertPermissionIsModelledButNotAssumed() {
  const asked = reduceAll([evt('permission.asked', { requestID: 'p1' })]);
  assert.equal(asked.state, 'waiting_permission');
  const replied = reduceAll([evt('permission.replied', { requestID: 'p1' })], asked);
  assert.notEqual(replied.state, 'waiting_permission');
  assert.equal(sessionState.isSchedulable(asked), false);
}

// The exit from unknown, which is the part the brief said to design before
// shipping. GET /session/status cannot serve it: verified returning {} against
// 72 live sessions.
function assertUnknownIsEnteredOnDisconnectAndExitedOnlyByEvidence() {
  const working = reduceAll([evt('session.status', { status: { type: 'busy' } })]);
  const dropped = sessionState.markStreamDisconnected(working);
  assert.equal(dropped.state, 'unknown');
  assert.equal(dropped.previousState, 'thinking', 'what it was doing must survive the disconnect');
  assert.equal(sessionState.isSchedulable(dropped), false);

  // Any event resolves it. No timeout, no guessing.
  assert.equal(reduceAll([evt('session.idle')], dropped).state, 'idle');
  assert.equal(reduceAll([evt('session.next.text.delta')], dropped).state, 'streaming');

  // A read-only observation may resolve it too: reading the message list costs
  // no quota and sends nothing. It is a fallback, not the main path.
  const settled = sessionState.applyIdleObservation(dropped, { lastMessageRole: 'assistant', completed: true });
  assert.equal(settled.state, 'idle');

  // An inconclusive observation must leave it unknown rather than guess.
  assert.equal(sessionState.applyIdleObservation(dropped, { lastMessageRole: 'user', completed: false }).state, 'unknown');
}

// The first version defined an exit from `unknown` and left three other dead
// ends behind it. Any state that is not schedulable needs a way out that does
// not depend on an event that may never arrive, or the office stalls there.
function assertNoNonSchedulableStateIsAbsorbing() {
  const stuck = [];

  for (const name of sessionState.STATES) {
    const state = { ...sessionState.initialState('ses_1'), state: name };
    if (sessionState.isSchedulable(state)) continue;

    // Escape 1: read-only evidence that the turn is over. Sends nothing.
    const observed = sessionState.applyIdleObservation(state, { lastMessageRole: 'assistant', completed: true });
    // Escape 2: explicitly giving up on knowing, which lands in `unknown`,
    // which escape 1 can then resolve.
    const staled = sessionState.markStale(state, { reason: 'no events' });

    const escaped = observed.state !== name || (staled.state === 'unknown' && name !== 'unknown');
    if (!escaped) stuck.push(name);
  }

  assert.deepEqual(stuck, [], `these states have no exit that does not depend on an event arriving: ${stuck.join(', ')}`);
}

// Degrading to unknown must itself be escapable, or it just moves the dead end.
function assertStaleDegradesToUnknownAndUnknownStillResolves() {
  const failed = { ...sessionState.initialState('ses_1'), state: 'failed', lastError: 'boom' };
  const staled = sessionState.markStale(failed, { reason: 'no events for 10m' });
  assert.equal(staled.state, 'unknown');
  assert.equal(staled.previousState, 'failed');
  assert.equal(staled.lastError, 'boom', 'degrading must not erase why it failed');

  const resolved = sessionState.applyIdleObservation(staled, { lastMessageRole: 'assistant', completed: true });
  assert.equal(resolved.state, 'idle');
}

// A step ending is not a turn ending: a turn runs several steps. Treating
// step.ended as terminal would flip a working agent into a non-schedulable
// state mid-turn and strand it there if the next step.started were missed.
// session.idle is the only terminal signal OpenCode gives us.
function assertStepEndedIsNotTerminal() {
  const state = reduceAll([
    evt('session.status', { status: { type: 'busy' } }),
    evt('session.next.step.ended'),
  ]);
  assert.notEqual(state.state, 'completed');
  assert.equal(sessionState.STATES.includes('completed'), false,
    'completed is either a flicker before session.idle or a trap; it should not be a state');
}

// An idle session that answers a question must go back to being idle.
function assertAnsweringFromIdleReturnsToIdle() {
  const asked = reduceAll([
    evt('session.idle'),
    evt('question.asked', { requestID: 'q1' }),
  ]);
  assert.equal(asked.state, 'waiting_user');

  const replied = reduceAll([evt('question.replied', { requestID: 'q1' })], asked);
  assert.equal(replied.state, 'idle', 'answering from idle fell through to unknown');
}

// Nested interruptions must not eat the state that was interrupted.
function assertNestedInterruptionsRestoreTheOriginalState() {
  const nested = reduceAll([
    evt('session.status', { status: { type: 'busy' } }),
    evt('question.asked', { requestID: 'q1' }),
    evt('permission.asked', { requestID: 'p1' }),
  ]);
  assert.equal(nested.state, 'waiting_permission');
  assert.equal(nested.interruptedState, 'thinking', 'the second interruption overwrote what was interrupted');

  const afterPermission = reduceAll([evt('permission.replied', { requestID: 'p1' })], nested);
  assert.equal(afterPermission.state, 'waiting_user', 'the question is still open');

  const afterQuestion = reduceAll([evt('question.replied', { requestID: 'q1' })], afterPermission);
  assert.equal(afterQuestion.state, 'thinking');
  assert.equal(afterQuestion.interruptedState, null, 'the interrupted state must be cleared once resumed');
}

// Degrading a waiting session to unknown must not launder away the open
// question: the pending ids survive, and the read-only observation must still
// refuse to call it idle while one is outstanding.
function assertStaleDoesNotLaunderAnOpenQuestion() {
  const waiting = reduceAll([
    evt('session.status', { status: { type: 'busy' } }),
    evt('question.asked', { requestID: 'q1' }),
  ]);
  const staled = sessionState.markStale(waiting, { reason: 'no events for 10m' });
  assert.equal(staled.state, 'unknown');
  assert.deepEqual(staled.pendingQuestionIds, ['q1'], 'the open question must survive the degrade');

  const observed = sessionState.applyIdleObservation(staled, { lastMessageRole: 'assistant', completed: true });
  assert.equal(observed.state, 'unknown', 'a session with an unanswered question must not be called idle');
  assert.equal(sessionState.isSchedulable(observed), false);

  // Once it is answered, the same observation may resolve it.
  const answered = reduceAll([evt('question.replied', { requestID: 'q1' })], staled);
  const resolved = sessionState.applyIdleObservation(answered, { lastMessageRole: 'assistant', completed: true });
  assert.equal(resolved.state, 'idle');
}

// Unrelated events must not move the state. The old heuristics drifted because
// anything that touched a session was treated as progress.
function assertUnrelatedEventsDoNotMoveTheState() {
  const idle = reduceAll([evt('session.idle')]);
  for (const type of ['todo.updated', 'file.edited', 'lsp.updated', 'server.connected', 'project.updated']) {
    assert.equal(reduceAll([evt(type)], idle).state, 'idle', `${type} moved the state`);
  }
}

// Decide now, cheap now, impossible later: the transition history cannot be
// reconstructed after the fact.
function assertEveryTransitionIsRecorded() {
  const events = [
    evt('session.next.prompt.admitted', { delivery: 'steer', messageID: 'msg_1' }),
    evt('session.status', { status: { type: 'busy' } }),
    evt('session.next.text.delta'),
    evt('session.idle'),
  ];

  const transitions = [];
  let state = sessionState.initialState();
  for (const event of events) {
    state = sessionState.reduce(state, event, { onTransition: (t) => transitions.push(t) });
  }

  assert.deepEqual(transitions.map((t) => `${t.from}->${t.to}`), [
    'unknown->submitted',
    'submitted->thinking',
    'thinking->streaming',
    'streaming->idle',
  ]);
  for (const transition of transitions) {
    assert.equal(transition.sessionId, 'ses_1');
    assert.equal(typeof transition.eventType, 'string');
    assert.equal(typeof transition.at, 'string');
  }

  // A repeated event that changes nothing must not be recorded as a transition.
  const noise = [];
  sessionState.reduce(state, evt('session.idle'), { onTransition: (t) => noise.push(t) });
  assert.deepEqual(noise, []);
}

// Pure: reducing must never mutate the state it was handed.
function assertReduceDoesNotMutateItsInput() {
  const before = reduceAll([evt('session.status', { status: { type: 'busy' } })]);
  const snapshot = JSON.stringify(before);
  sessionState.reduce(before, evt('session.idle'));
  assert.equal(JSON.stringify(before), snapshot);
}

function main() {
  assertFreshSessionIsUnknownAndNotSchedulable();
  assertOnlyIdleIsSchedulable();
  assertSessionStatusDrivesTheState();
  assertStreamingAndThinkingComeFromTheStream();
  assertPromptAdmissionIsDistinguished();
  assertRetryStatusIsRateLimited();
  assertApiErrorsAreClassified();
  assertQuestionsSuspendAndResume();
  assertPermissionIsModelledButNotAssumed();
  assertUnknownIsEnteredOnDisconnectAndExitedOnlyByEvidence();
  assertNoNonSchedulableStateIsAbsorbing();
  assertStaleDegradesToUnknownAndUnknownStillResolves();
  assertStepEndedIsNotTerminal();
  assertAnsweringFromIdleReturnsToIdle();
  assertNestedInterruptionsRestoreTheOriginalState();
  assertStaleDoesNotLaunderAnOpenQuestion();
  assertUnrelatedEventsDoNotMoveTheState();
  assertEveryTransitionIsRecorded();
  assertReduceDoesNotMutateItsInput();

  console.log('Session state machine validation passed.');
}

main();
