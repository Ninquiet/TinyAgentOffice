'use strict';

// Cost and tokens, taken from what OpenCode actually sends.
//
// The closing run finished a whole task cycle and every ledger row had cost 0.
// The pipeline was never connected: nothing read the usage OpenCode reports, so
// the spend cap could not be calibrated and the game's budget mechanic had no
// source.
//
// The shapes below are copied from a real recording of 29,373 events rather than
// from the schema, and the recording corrected an assumption the schema would
// have left standing: **message.updated fires repeatedly for the same message
// id**, with the same cost each time. Accumulating per event would have
// multiplied the bill. Usage is therefore set, not added.
//
// Two sources, and they are not interchangeable:
//   message.updated  -> per assistant message: what one prompt cost
//   session.updated  -> the session's running total
// The ledger attributes per prompt, so it uses the message.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runtimeStore = require('../runtime/runtime-store');

// Trimmed from a real OpenCode event capture.
const REAL_MESSAGE_UPDATED = {
  id: 'evt_real',
  type: 'message.updated',
  properties: {
    sessionID: 'ses_fea01942affeCiiuJfUrvIDcpB',
    info: {
      id: 'msg_01614653c001IppbBkM5UE65O2',
      role: 'assistant',
      sessionID: 'ses_fea01942affeCiiuJfUrvIDcpB',
      cost: 0.01107835,
      tokens: { total: 50798, input: 629, output: 107, reasoning: 142, cache: { write: 0, read: 49920 } },
      time: { created: 1787076830524, completed: 1787076839309 },
    },
  },
};

function withProject(run) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-usage-'));
  try {
    runtimeStore.ensureInitialized({ projectRoot });
    return run({ projectRoot });
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

function reserveAdmitted(options, messageId) {
  const reserved = runtimeStore.reservePrompt(options, {
    agentSessionId: 'neon-hammer-ss-1',
    taskId: 'NEXT-300',
    command: 'dispatch',
    promptHash: 'hash-a',
  });
  runtimeStore.recordPromptTransport(options, reserved.entry.idempotencyKey, 'submitted');
  runtimeStore.recordPromptOutcome(options, reserved.entry.idempotencyKey, 'admitted', { messageId });
  return reserved.entry.idempotencyKey;
}

// The attribution: a prompt's cost is the cost of the message it produced, and
// the messageID from session.next.prompt.admitted is what ties them together.
function assertUsageIsAttributedToThePromptThatCausedIt() {
  withProject((options) => {
    const info = REAL_MESSAGE_UPDATED.properties.info;
    const key = reserveAdmitted(options, info.id);

    const applied = runtimeStore.recordPromptUsage(options, [{
      messageId: info.id,
      cost: info.cost,
      tokens: info.tokens,
    }]);
    assert.equal(applied.updated, 1);

    const entry = runtimeStore.readPromptLedgerEntry(options, key);
    assert.equal(entry.cost, info.cost, 'the prompt was not charged what its message cost');
    assert.equal(entry.inputTokens, 629);
    assert.equal(entry.outputTokens, 107);
    assert.equal(entry.reasoningTokens, 142);
    assert.equal(entry.cacheReadTokens, 49920);
    assert.equal(entry.cacheWriteTokens, 0);
  });
}

// The correction the recording forced. The same message updates several times
// with the same figures; adding them would inflate the bill and fire the spend
// cap early.
function assertRepeatedUpdatesDoNotAccumulate() {
  withProject((options) => {
    const info = REAL_MESSAGE_UPDATED.properties.info;
    const key = reserveAdmitted(options, info.id);

    for (let i = 0; i < 4; i += 1) {
      runtimeStore.recordPromptUsage(options, [{ messageId: info.id, cost: info.cost, tokens: info.tokens }]);
    }

    const entry = runtimeStore.readPromptLedgerEntry(options, key);
    assert.equal(entry.cost, info.cost, 'repeated message.updated events were summed instead of set');
    assert.equal(entry.inputTokens, 629);
  });
}

// A later update with a higher figure is the real total, so it must win.
function assertTheLatestFigureWins() {
  withProject((options) => {
    const info = REAL_MESSAGE_UPDATED.properties.info;
    const key = reserveAdmitted(options, info.id);

    runtimeStore.recordPromptUsage(options, [{ messageId: info.id, cost: 0.001, tokens: { input: 10, output: 1 } }]);
    runtimeStore.recordPromptUsage(options, [{ messageId: info.id, cost: info.cost, tokens: info.tokens }]);

    const entry = runtimeStore.readPromptLedgerEntry(options, key);
    assert.equal(entry.cost, info.cost);
    assert.equal(entry.inputTokens, 629);
  });
}

// Usage for a message no prompt claims must not invent a row. Plenty of
// assistant messages have no ledger entry: manual turns, work started in the
// terminal, anything the office did not send.
function assertUnattributableUsageIsIgnored() {
  withProject((options) => {
    const applied = runtimeStore.recordPromptUsage(options, [{
      messageId: 'msg_nobody_asked_for',
      cost: 9.99,
      tokens: { input: 1, output: 1 },
    }]);
    assert.equal(applied.updated, 0);
    assert.equal(runtimeStore.readPromptLedger(options).length, 0, 'usage invented a ledger row');
  });
}

// The spend cap reads this. If usage never lands, the cap can never fire, which
// is the state the closing run found the system in.
function assertRecordedUsageFeedsTheSpendCap() {
  withProject((options) => {
    const info = REAL_MESSAGE_UPDATED.properties.info;
    reserveAdmitted(options, info.id);
    runtimeStore.recordPromptUsage(options, [{ messageId: info.id, cost: 0.6, tokens: info.tokens }]);

    assert.equal(runtimeStore.sessionSpend(options, 'neon-hammer-ss-1'), 0.6);

    const refused = runtimeStore.reservePrompt(options, {
      agentSessionId: 'neon-hammer-ss-1',
      taskId: 'NEXT-300',
      command: 'continue',
      promptHash: 'hash-b',
    }, { maxSessionCost: 0.5 });

    assert.equal(refused.reserved, false);
    assert.equal(refused.reason, 'session-spend-cap');
  });
}

// The parser reads the event, so a change in the envelope fails here rather than
// silently going back to zero.
function assertTheEventParserMatchesTheRecording() {
  const usage = runtimeStore.usageFromEvent(REAL_MESSAGE_UPDATED);
  assert.ok(usage, 'a real message.updated event produced no usage');
  assert.equal(usage.messageId, 'msg_01614653c001IppbBkM5UE65O2');
  assert.equal(usage.cost, 0.01107835);
  assert.equal(usage.tokens.input, 629);

  // Only assistant messages carry a bill.
  assert.equal(runtimeStore.usageFromEvent({
    type: 'message.updated',
    properties: { info: { id: 'msg_user', role: 'user', cost: 0 } },
  }), null);

  // session.updated carries the running total, not a per-prompt charge, so it
  // must not be mistaken for one.
  assert.equal(runtimeStore.usageFromEvent({
    type: 'session.updated',
    properties: { info: { id: 'ses_x', cost: 0.10191903999999999 } },
  }), null);
}

function main() {
  assertTheEventParserMatchesTheRecording();
  assertUsageIsAttributedToThePromptThatCausedIt();
  assertRepeatedUpdatesDoNotAccumulate();
  assertTheLatestFigureWins();
  assertUnattributableUsageIsIgnored();
  assertRecordedUsageFeedsTheSpendCap();

  console.log('Prompt usage validation passed.');
}

main();
