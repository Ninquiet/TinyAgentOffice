'use strict';

// A turn the provider dropped, and what the office owes an agent afterwards.
//
// Observed live: Copper Circuit worked seven turns on TASK-002, then its eighth
// closed with `finish: "unknown"`, zero tokens and zero cost -- the provider let
// go of the turn mid-reasoning. OpenCode raised no error, so the session simply
// went idle. The agent still owned the task, so the daemon would not schedule it
// (`activeTaskId` is an absolute bar), and the session was `idle` rather than
// `unknown`/`failed`, so the watchdog did not consider it abandoned. It sat there
// for an hour and a half, belonging to nobody.
//
// The trigger here is evidence, not a clock. That distinction is load-bearing:
// an implementer that finished its work and is waiting on a reviewer looks
// identical to a timer -- idle, holding a task, silent -- and releasing that
// agent would take a completed task away from someone who did the work and pay
// for it twice. Its last turn ended with real tokens and a real finish reason,
// so the evidence separates the two cases and a timeout cannot.
//
// The timeout is not gone, it is just no longer the trigger: a session stuck in
// a non-idle state still degrades to `unknown` through the state store's sweep,
// and `unknown` is still abandoned. That path is the backup for stalls of a
// shape we have not seen yet.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionState = require('../opencode/session-state');
const runtimeStore = require('../runtime/runtime-store');
const activityWatchdog = require('../opencode/activity-watchdog');
const { getPolicy } = require('../runtime/runtime-policy');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'dropped-turn.json'), 'utf8'));

function messageUpdated(info) {
  return { type: 'message.updated', properties: { info } };
}

function partUpdated(sessionId, tool, filePath) {
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        type: 'tool',
        sessionID: sessionId,
        tool,
        state: { status: 'completed', input: { filePath } },
      },
    },
  };
}

function tempProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-dropped-'));
  runtimeStore.ensureInitialized({ projectRoot });
  return projectRoot;
}

function seed(options, agentPatch = {}, taskPatch = {}) {
  runtimeStore.mutateCoordination(options, (state) => {
    state.registry.agents = [{
      sessionId: 'copper-circuit-ss-1',
      agentName: 'Copper Circuit',
      role: 'Semi Senior',
      adapterType: 'opencode',
      opencodeSessionId: 'ses_1',
      status: 'working',
      activeTaskId: 'TASK-002',
      terminalPid: process.pid,
      attentionRequired: false,
      ...agentPatch,
    }];
    state.tasksStore.tasks = [{
      id: 'TASK-002',
      type: 'task',
      section: 'active',
      status: 'IN_PROGRESS',
      title: 'Implement the platformer core',
      recommendedRole: 'Semi Senior',
      prerequisites: [],
      claim: { agentName: 'Copper Circuit', role: 'Semi Senior' },
      reports: [],
      notes: [],
      children: [],
      workflow: { step: 'implementation', currentActorRole: 'Semi Senior', currentActorSessionId: 'copper-circuit-ss-1' },
      ...taskPatch,
    }];
  });
}

function readState(options) {
  const snapshot = runtimeStore.readCoordinationState(options);
  return {
    agent: (snapshot.registry.agents || [])[0],
    task: (snapshot.tasksStore.tasks || [])[0],
  };
}

// --- 1. the reducer recognises a dropped turn, and only a dropped turn -------

function validateDroppedTurnEvidence() {
  const dropped = sessionState.reduce(
    { ...sessionState.initialState('ses_1'), state: 'streaming' },
    messageUpdated(fixture.dropped.info)
  );
  assert.ok(dropped.droppedTurnAt, 'the captured dropped turn must be recorded as evidence');
  assert.strictEqual(dropped.droppedTurnMessageId, fixture.dropped.info.id);

  // Evidence only. The turn ending is what session.idle is for; this must not
  // move the session itself, or it would be a second writer of the state.
  assert.strictEqual(dropped.state, 'streaming', 'recording evidence must not change the session state');

  const healthy = sessionState.reduce(
    { ...sessionState.initialState('ses_1'), state: 'streaming' },
    messageUpdated(fixture.healthy.info)
  );
  assert.strictEqual(healthy.droppedTurnAt, null, 'a turn that finished with real tokens is not dropped');

  // The trap: a message still being written also has zero cost and zero tokens
  // and no finish reason. Only `time.completed` separates it from a dropped one.
  const inFlight = sessionState.reduce(
    { ...sessionState.initialState('ses_1'), state: 'streaming' },
    messageUpdated({
      id: 'msg_inflight',
      sessionID: 'ses_1',
      role: 'assistant',
      time: { created: Date.now() },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
  );
  assert.strictEqual(inFlight.droppedTurnAt, null, 'an in-flight message must never look dropped');

  // A user message carries no finish reason at all and is not a turn outcome.
  const userMessage = sessionState.reduce(
    { ...sessionState.initialState('ses_1'), state: 'idle' },
    messageUpdated({ id: 'msg_user', sessionID: 'ses_1', role: 'user', time: { created: 1, completed: 2 } })
  );
  assert.strictEqual(userMessage.droppedTurnAt, null, 'a user message is not a dropped turn');

  console.log('Dropped-turn evidence: recognised, and not confused with in-flight or healthy turns.');
}

function validateEvidenceClearsOnNextTurn() {
  let state = sessionState.reduce(
    { ...sessionState.initialState('ses_1'), state: 'streaming' },
    messageUpdated(fixture.dropped.info)
  );
  state = sessionState.reduce(state, { type: 'session.idle', properties: { sessionID: 'ses_1' } });
  assert.ok(state.droppedTurnAt, 'going idle after a dropped turn keeps the evidence; that is the whole case');

  state = sessionState.reduce(state, {
    type: 'session.next.prompt.admitted',
    properties: { sessionID: 'ses_1', messageID: 'msg_new', delivery: 'steer' },
  });
  assert.strictEqual(state.droppedTurnAt, null, 'a new turn clears the evidence');
  assert.strictEqual(state.droppedTurnMessageId, null);

  console.log('Dropped-turn evidence: survives going idle, cleared when a new turn starts.');
}

// The strongest available check that this does not fire on healthy work: replay
// the full 29,373-event capture of a real task cycle and require that it never
// once concludes a turn was dropped.
function validateNoFalsePositivesOnRecording() {
  const recording = path.join(__dirname, '..', '..', 'TEMP', 'recordings', 'pass1-neon-hammer.jsonl');
  if (!fs.existsSync(recording)) {
    console.log('Dropped-turn evidence: recording absent, replay skipped.');
    return;
  }

  const states = new Map();
  let events = 0;
  let flagged = 0;
  for (const line of fs.readFileSync(recording, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch (_) { continue; }
    const event = parsed.event || parsed;
    const sessionId = (event.properties && (event.properties.sessionID
      || (event.properties.info && event.properties.info.sessionID)
      || (event.properties.part && event.properties.part.sessionID))) || null;
    if (!sessionId) continue;
    events += 1;
    const next = sessionState.reduce(states.get(sessionId) || sessionState.initialState(sessionId), event);
    states.set(sessionId, next);
    if (next.droppedTurnAt) flagged += 1;
  }

  assert.ok(events > 1000, `expected a substantial replay, got ${events} events`);
  assert.strictEqual(flagged, 0, `a healthy recorded run must never look like a dropped turn (${flagged} of ${events})`);
  console.log(`Dropped-turn evidence: replayed ${events} recorded events, zero false positives.`);
}

// --- 2. what the session actually produced ----------------------------------

function validateTouchedFiles() {
  let state = sessionState.initialState('ses_1');
  state = sessionState.reduce(state, partUpdated('ses_1', 'write', 'C:\\p\\src\\game.py'));
  state = sessionState.reduce(state, partUpdated('ses_1', 'edit', 'C:\\p\\tests\\test_physics.py'));
  state = sessionState.reduce(state, partUpdated('ses_1', 'read', 'C:\\p\\README.md'));
  state = sessionState.reduce(state, partUpdated('ses_1', 'write', 'C:\\p\\src\\game.py'));

  assert.deepStrictEqual(
    state.touchedFiles,
    ['C:\\p\\src\\game.py', 'C:\\p\\tests\\test_physics.py'],
    'only files written or edited count as produced work, recorded once each'
  );
  console.log('Touched files: writes and edits collected, reads ignored, no duplicates.');
}

// --- 3. the watchdog acts on the evidence -----------------------------------

async function validateReleaseAfterDroppedTurn() {
  const projectRoot = tempProject();
  const options = { projectRoot };
  seed(options);

  const droppedAt = new Date('2026-08-18T22:28:16.624Z').toISOString();
  const runtime = {
    state: 'idle',
    lastEventAt: droppedAt,
    droppedTurnAt: droppedAt,
    droppedTurnMessageId: 'msg_dropped',
    touchedFiles: ['C:\\p\\src\\squirrel_platformer\\app.py', 'C:\\p\\tests\\test_physics.py'],
  };
  const dependencies = { sessionStateFor: () => runtime };

  const first = await activityWatchdog.reconcileOpencodeActivity(options, {
    ...dependencies,
    now: Date.parse(droppedAt) + 1000,
  });
  assert.strictEqual(first.marked, 1, 'an idle agent whose last turn was dropped is stalled');
  assert.strictEqual(first.released, 0, 'the first pass marks; it does not release');

  const marked = readState(options);
  assert.ok(marked.agent.stalledSinceAt, 'the release clock must start');
  assert.strictEqual(marked.task.status, 'IN_PROGRESS', 'the task is not released yet');

  // The clock must survive the passes in between. It used to be nulled on every
  // pass where the state was not `unknown`/`failed`, which for an idle session
  // meant the grace period could never elapse.
  await activityWatchdog.reconcileOpencodeActivity(options, {
    ...dependencies,
    now: Date.parse(droppedAt) + 2000,
  });
  const stillMarked = readState(options);
  assert.strictEqual(
    stillMarked.agent.stalledSinceAt,
    marked.agent.stalledSinceAt,
    'the release clock must not reset on every pass'
  );

  const afterGrace = await activityWatchdog.reconcileOpencodeActivity(options, {
    ...dependencies,
    now: Date.parse(marked.agent.stalledSinceAt) + getPolicy().releaseGraceMs + 1000,
  });
  assert.strictEqual(afterGrace.released, 1, 'the assignment is released once the grace period passes');

  const released = readState(options);
  assert.strictEqual(released.task.status, 'TODO', 'the task goes back to the queue');
  assert.strictEqual(released.task.claim, null);
  assert.strictEqual(released.agent.activeTaskId, null, 'the agent is free to be scheduled again');
  assert.strictEqual(released.agent.status, 'available');

  // The cost of releasing is that the work is redone and paid for twice. What
  // reached disk survives the release, so the next attempt starts informed.
  const note = (released.task.notes || []).find((entry) => entry.kind === 'watchdog-release');
  assert.ok(note, 'the release must be recorded on the task');
  assert.match(note.text, /app\.py/, 'the note must say what the dropped turn left on disk');
  assert.match(note.text, /test_physics\.py/);
  assert.ok(Array.isArray(note.touchedFiles) && note.touchedFiles.length === 2, 'and carry the list as data');

  console.log('Watchdog: dropped turn marked, clock kept, assignment released with what survived on disk.');
}

// The case the evidence trigger exists to protect. An implementer that finished
// its work and is waiting on a reviewer is idle, holds its task, and is silent
// -- indistinguishable from a stall by any clock. Its last turn is the
// difference: it ended properly.
async function validateFinishedAgentIsNeverReleased() {
  const projectRoot = tempProject();
  const options = { projectRoot };
  seed(options);

  const finishedAt = new Date('2026-08-18T20:00:00.000Z').toISOString();
  const runtime = { state: 'idle', lastEventAt: finishedAt, droppedTurnAt: null, touchedFiles: [] };

  // Hours later, still nothing. A timeout would have taken the task away.
  const result = await activityWatchdog.reconcileOpencodeActivity(options, {
    sessionStateFor: () => runtime,
    now: Date.parse(finishedAt) + (6 * 60 * 60 * 1000),
  });

  assert.strictEqual(result.marked, 0, 'an agent whose last turn completed properly is not stalled');
  assert.strictEqual(result.released, 0);

  const after = readState(options);
  assert.strictEqual(after.task.status, 'IN_PROGRESS', 'its task stays with it');
  assert.strictEqual(after.agent.activeTaskId, 'TASK-002');
  assert.strictEqual(after.agent.stalledSinceAt || null, null, 'and no release clock is started');

  console.log('Watchdog: an agent that finished its turn keeps its task, however long it waits.');
}

// The backup path stays exactly as it was: a session stuck somewhere non-idle
// degrades to `unknown` through the sweep, and `unknown` is still abandoned.
async function validateUnknownStillReleases() {
  const projectRoot = tempProject();
  const options = { projectRoot };
  seed(options);

  const at = new Date('2026-08-18T21:00:00.000Z').toISOString();
  const runtime = { state: 'unknown', lastEventAt: at, droppedTurnAt: null, touchedFiles: [] };
  const dependencies = { sessionStateFor: () => runtime };

  await activityWatchdog.reconcileOpencodeActivity(options, { ...dependencies, now: Date.parse(at) + 1000 });
  const marked = readState(options);
  assert.ok(marked.agent.stalledSinceAt, 'an unrecoverable session still starts the clock');

  const after = await activityWatchdog.reconcileOpencodeActivity(options, {
    ...dependencies,
    now: Date.parse(marked.agent.stalledSinceAt) + getPolicy().releaseGraceMs + 1000,
  });
  assert.strictEqual(after.released, 1, 'the timeout path must keep working as the backup');

  console.log('Watchdog: the unknown/failed backup path still releases.');
}

// Found by releasing TASK-002 by hand on the live project, which is the only
// reason it was found at all: the release worked, the daemon re-dispatched
// within seconds, and the ledger refused the prompt as `already-completed`.
// Copper Circuit went to `attention` instead of retrying.
//
// The idempotency key is agentSession::task::command::promptHash, so a genuine
// second attempt at the same task is byte-identical to a duplicate of the
// first. Releasing a task therefore has to start a new attempt, or option 1
// releases work that can never be picked up again by the same agent.
function validateReleasedTaskCanBeDispatchedAgain() {
  const { promptIdempotencyKey } = require('../runtime/prompt-lifecycle');

  const request = {
    agentSessionId: 'copper-circuit-ss-1',
    taskId: 'TASK-002',
    command: 'dispatch',
    promptHash: 'abc123',
  };

  const first = promptIdempotencyKey(request);
  const second = promptIdempotencyKey({ ...request, attempt: 1 });
  assert.notStrictEqual(first, second, 'a new attempt at a task must be a new ledger entry');

  // The keys already written must keep the shape they were written with, or
  // every existing row is orphaned and every past prompt becomes re-issuable.
  assert.strictEqual(
    promptIdempotencyKey({ ...request, attempt: 0 }),
    first,
    'the first attempt keeps the original key'
  );
  assert.strictEqual(promptIdempotencyKey({ ...request, attempt: null }), first);

  console.log('Prompt ledger: a released task starts a new attempt rather than colliding.');
}

async function validateReleaseStartsANewAttempt() {
  const projectRoot = tempProject();
  const options = { projectRoot };
  seed(options);

  const droppedAt = new Date('2026-08-18T22:28:16.624Z').toISOString();
  const runtime = { state: 'idle', lastEventAt: droppedAt, droppedTurnAt: droppedAt, touchedFiles: [] };
  const dependencies = { sessionStateFor: () => runtime };

  await activityWatchdog.reconcileOpencodeActivity(options, { ...dependencies, now: Date.parse(droppedAt) + 1000 });
  const marked = readState(options);
  await activityWatchdog.reconcileOpencodeActivity(options, {
    ...dependencies,
    now: Date.parse(marked.agent.stalledSinceAt) + getPolicy().releaseGraceMs + 1000,
  });

  const released = readState(options);
  assert.strictEqual(released.task.attempt, 1, 'releasing a task counts as a failed attempt');

  console.log('Watchdog: releasing a task advances its attempt counter.');
}

async function main() {
  validateDroppedTurnEvidence();
  validateEvidenceClearsOnNextTurn();
  validateNoFalsePositivesOnRecording();
  validateTouchedFiles();
  await validateReleaseAfterDroppedTurn();
  await validateFinishedAgentIsNeverReleased();
  await validateUnknownStillReleases();
  validateReleasedTaskCanBeDispatchedAgain();
  await validateReleaseStartsANewAttempt();
  console.log('Dropped-turn release validation passed.');
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
