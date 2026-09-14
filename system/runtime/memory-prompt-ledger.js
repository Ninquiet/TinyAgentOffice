'use strict';

// An in-memory implementation of the prompt ledger contract.
//
// It exists so that code which needs prompt delivery without a database still
// goes through a ledger, rather than being allowed to run without one. There is
// deliberately no way to send a prompt with no ledger at all: the send path
// falls back to the store-backed ledger, and callers that cannot use a database
// pass this instead.
//
// It enforces the same idempotency rule as the store-backed one, so a caller
// that works against this does not discover different behaviour in production.

const { TERMINAL_OUTCOMES, promptIdempotencyKey } = require('./prompt-lifecycle');

function createMemoryPromptLedger(options = {}) {
  const entries = new Map();
  const recorded = [];
  const limits = options.limits || {};

  function reserve(request) {
    const idempotencyKey = promptIdempotencyKey(request);
    const existing = entries.get(idempotencyKey);

    if (existing && !TERMINAL_OUTCOMES.has(existing.outcomeStatus)) {
      return { reserved: false, reason: 'duplicate', entry: existing };
    }
    if (existing && existing.outcomeStatus === 'failed' && existing.transportStatus === 'submitted') {
      return { reserved: false, reason: 'failed-after-submit', entry: existing };
    }

    if (Number.isInteger(limits.maxPromptsPerTask) && request.taskId) {
      const used = Array.from(entries.values()).filter((entry) => entry.taskId === request.taskId).length;
      if (used >= limits.maxPromptsPerTask) {
        return { reserved: false, reason: 'task-prompt-cap', used, limit: limits.maxPromptsPerTask };
      }
    }

    const entry = {
      idempotencyKey,
      agentSessionId: request.agentSessionId,
      taskId: request.taskId || null,
      command: request.command,
      promptHash: request.promptHash,
      transportStatus: 'created',
      outcomeStatus: 'pending',
      cost: 0,
    };
    entries.set(idempotencyKey, entry);
    recorded.push({ kind: 'reserve', request });
    return { reserved: true, entry };
  }

  function recordTransport(idempotencyKey, transportStatus, details) {
    const entry = entries.get(idempotencyKey);
    if (entry) entry.transportStatus = transportStatus;
    recorded.push({ kind: 'transport', key: idempotencyKey, status: transportStatus, details });
  }

  function recordOutcome(idempotencyKey, outcomeStatus, details) {
    const entry = entries.get(idempotencyKey);
    if (entry) {
      entry.outcomeStatus = outcomeStatus;
      if (details && Number.isFinite(details.cost)) entry.cost += details.cost;
    }
    recorded.push({ kind: 'outcome', key: idempotencyKey, status: outcomeStatus, details });
  }

  return {
    reserve,
    recordTransport,
    recordOutcome,
    // Inspection, for callers that want to assert what happened.
    entries: () => Array.from(entries.values()),
    recorded: () => recorded.slice(),
    transportSequence: () => recorded.filter((call) => call.kind === 'transport').map((call) => call.status),
    outcomeSequence: () => recorded.filter((call) => call.kind === 'outcome').map((call) => call.status),
  };
}

module.exports = {
  createMemoryPromptLedger,
};
