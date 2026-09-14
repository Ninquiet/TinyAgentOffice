'use strict';

// Step 4, sixth slice: the ledger wired into the actual send path.
//
// A ledger the send path does not write is worse than no ledger: the caps never
// fire, the table stays empty, and the system looks protected. This covers the
// wiring itself -- that nothing is sent without a reservation, and that the
// lifecycle recorded matches how far the prompt actually got.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sessionDispatch = require('../dispatch/session-dispatch');
const runtimeStore = require('../runtime/runtime-store');

function fakeResolver(overrides = {}) {
  return {
    listSessions: async () => [{ id: 'ses_1', title: 'Pixel Circuit Test' }],
    findSessionByDashboardIdentity: async () => ({ id: 'ses_1', title: 'Pixel Circuit Test' }),
    listMessages: async () => [],
    sessionMessageCheckpoint: () => ({ count: 0, lastMessageId: null }),
    indexSessionUpdates: () => new Map(),
    hasDeliveredPromptAfterCheckpoint: () => true,
    detectTouchedSession: () => null,
    getSession: async () => ({ id: 'ses_1', title: 'Pixel Circuit Test' }),
    messagePayloadMatchesDashboardIdentity: () => false,
    extractMessageText: () => '',
    ...overrides,
  };
}

function recordingLedger(reservation = { reserved: true, entry: { idempotencyKey: 'key-1' } }) {
  const calls = [];
  return {
    calls,
    reserve: (request) => {
      calls.push({ kind: 'reserve', request });
      return reservation;
    },
    recordTransport: (key, status) => calls.push({ kind: 'transport', key, status }),
    recordOutcome: (key, status, details) => calls.push({ kind: 'outcome', key, status, details }),
  };
}

const agent = {
  agentName: 'Pixel Circuit',
  role: 'Semi Senior',
  sessionId: 'pixel-circuit-ss-1',
  adapterType: 'opencode',
  serverHost: '127.0.0.1',
  serverPort: 43102,
  opencodeSessionId: 'ses_1',
  opencodeSessionTitle: 'Pixel Circuit Test',
};

function httpRecorder() {
  const calls = [];
  return {
    calls,
    request: async (_endpoint, method, pathName, body) => {
      calls.push({ method, pathName, body });
      return pathName === '/global/health' ? { healthy: true } : true;
    },
  };
}

// The whole point of the cap: a refused reservation must not reach OpenCode.
async function assertRefusedReservationSendsNothing() {
  const http = httpRecorder();
  const ledger = recordingLedger({ reserved: false, reason: 'task-prompt-cap', limit: 3, used: 3 });

  const result = await sessionDispatch.sendPromptToOpencode(agent, 'Continue the task.', {
    httpJsonRequest: http.request,
    sessionResolver: fakeResolver(),
    sleep: async () => {},
    ledger,
    command: 'continue',
    taskId: 'NEXT-017',
  });

  assert.equal(result.delivered, false);
  assert.equal(result.refusedReason, 'task-prompt-cap');
  assert.equal(http.calls.filter((call) => call.pathName === '/tui/append-prompt').length, 0,
    'a refused prompt reached OpenCode anyway');
  assert.equal(http.calls.filter((call) => call.pathName === '/tui/submit-prompt').length, 0);
  assert.deepEqual(ledger.calls.map((call) => call.kind), ['reserve']);
}

// The reservation carries what the key is built from, including the task, or
// the per-task cap has nothing to count.
async function assertReservationCarriesTheAttribution() {
  const http = httpRecorder();
  const ledger = recordingLedger();

  await sessionDispatch.sendPromptToOpencode(agent, 'Continue the task.', {
    httpJsonRequest: http.request,
    sessionResolver: fakeResolver(),
    sleep: async () => {},
    ledger,
    command: 'continue',
    taskId: 'NEXT-017',
  });

  const reserve = ledger.calls.find((call) => call.kind === 'reserve');
  assert.equal(reserve.request.agentSessionId, 'pixel-circuit-ss-1');
  assert.equal(reserve.request.taskId, 'NEXT-017');
  assert.equal(reserve.request.command, 'continue');
  assert.ok(reserve.request.promptHash, 'the prompt hash is what makes the key idempotent');
}

// The same text must hash the same way, or deduplication silently stops working.
async function assertThePromptHashIsStable() {
  const hashes = [];
  for (let i = 0; i < 2; i += 1) {
    const ledger = recordingLedger();
    // eslint-disable-next-line no-await-in-loop
    await sessionDispatch.sendPromptToOpencode(agent, 'Continue the task.', {
      httpJsonRequest: httpRecorder().request,
      sessionResolver: fakeResolver(),
      sleep: async () => {},
      ledger,
      command: 'continue',
      taskId: 'NEXT-017',
    });
    hashes.push(ledger.calls.find((call) => call.kind === 'reserve').request.promptHash);
  }
  assert.equal(hashes[0], hashes[1]);
}

// Transport and outcome are recorded as they actually happen, not optimistically
// at the start.
async function assertDeliveryRecordsBothLifecycles() {
  const ledger = recordingLedger();
  const result = await sessionDispatch.sendPromptToOpencode(agent, 'Continue the task.', {
    httpJsonRequest: httpRecorder().request,
    sessionResolver: fakeResolver(),
    sleep: async () => {},
    ledger,
    command: 'continue',
    taskId: 'NEXT-017',
  });

  assert.equal(result.deliveryVerified, true);
  const transports = ledger.calls.filter((call) => call.kind === 'transport').map((call) => call.status);
  assert.deepEqual(transports, ['appended', 'submitted']);
  const outcome = ledger.calls.find((call) => call.kind === 'outcome');
  assert.equal(outcome.status, 'admitted');
}

// The re-append bug, now expressed through the ledger: OpenCode accepted the
// submit, so the transport reached `submitted` and the outcome is a failure
// that must not be retried automatically.
async function assertFailureAfterSubmitIsRecordedAsSuch() {
  const http = httpRecorder();
  const ledger = recordingLedger();
  let reads = 0;

  const result = await sessionDispatch.sendPromptToOpencode(agent, 'Continue the task.', {
    httpJsonRequest: http.request,
    sessionResolver: fakeResolver({
      listMessages: async () => {
        reads += 1;
        if (reads > 1) throw new Error('transient session read failure');
        return [];
      },
      hasDeliveredPromptAfterCheckpoint: () => false,
    }),
    sleep: async () => {},
    ledger,
    command: 'continue',
    taskId: 'NEXT-017',
  });

  assert.equal(result.deliveryVerified, false);
  assert.equal(http.calls.filter((call) => call.pathName === '/tui/append-prompt').length, 1,
    'the prompt was appended more than once');
  assert.equal(http.calls.filter((call) => call.pathName === '/tui/submit-prompt').length, 1);

  const transports = ledger.calls.filter((call) => call.kind === 'transport').map((call) => call.status);
  assert.ok(transports.includes('submitted'), 'the ledger must know the prompt got as far as submit');
  const outcome = ledger.calls.filter((call) => call.kind === 'outcome').pop();
  assert.equal(outcome.status, 'failed');
}

// There is no way to send without a ledger. Passing null does not disable
// recording, it falls back to the store-backed one -- so an unrecorded prompt
// is not something a caller can ask for. Unrecorded delivery is exactly what
// left no trace of the thirteen continue prompts.
async function assertThereIsNoWayToSendWithoutALedger() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-delivery-'));
  try {
    runtimeStore.ensureInitialized({ projectRoot });
    await sessionDispatch.sendPromptToOpencode(agent, 'Continue the task.', {
      httpJsonRequest: httpRecorder().request,
      sessionResolver: fakeResolver(),
      sleep: async () => {},
      ledger: null,
      runtimeOptions: { projectRoot },
      command: 'continue',
      taskId: 'NEXT-017',
    });

    const entries = runtimeStore.readPromptLedger({ projectRoot });
    assert.equal(entries.length, 1, 'passing a null ledger silently skipped recording');
    assert.equal(entries[0].taskId, 'NEXT-017');
    assert.equal(entries[0].transportStatus, 'submitted');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

async function main() {
  await assertRefusedReservationSendsNothing();
  await assertReservationCarriesTheAttribution();
  await assertThePromptHashIsStable();
  await assertDeliveryRecordsBothLifecycles();
  await assertFailureAfterSubmitIsRecordedAsSuch();
  await assertThereIsNoWayToSendWithoutALedger();

  console.log('Prompt delivery validation passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
