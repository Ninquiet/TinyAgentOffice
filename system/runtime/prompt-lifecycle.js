'use strict';

// The rules both prompt ledger implementations must share.
//
// These were defined twice, in the store-backed ledger and in the in-memory one.
// A test double that disagrees with the real thing is worse than no double: the
// suite stays green while production behaves differently. Adding a terminal
// outcome to one and not the other is exactly how that happens, so there is one
// definition and both import it.

// An outcome is terminal when the prompt's story is over and its key is free to
// be used again. `admitted` is deliberately absent: OpenCode accepting a prompt
// is not the turn being over, and something has to close it afterwards.
const TERMINAL_OUTCOMES = new Set(['completed', 'failed', 'cancelled']);

// The idempotency key. Any change here changes what counts as "the same prompt",
// so it belongs in one place too.
// Identifies one prompt occasion, so that retrying transport cannot send the
// same instruction twice.
//
// `attempt` is what separates a genuine second run at a task from a duplicate
// of the first. A released task is dispatched again with the same agent, the
// same command and the same text, so without it the two are byte-identical and
// the ledger refuses the new one as `already-completed` -- observed the first
// time a task was released by hand, which left the agent in `attention`
// instead of retrying.
//
// Attempt 0 is left out of the key entirely, so every entry already written
// keeps the key it was written with.
function promptIdempotencyKey(request) {
  const attempt = Number(request.attempt) || 0;
  return [
    request.agentSessionId,
    request.taskId || 'no-task',
    request.command,
    ...(attempt > 0 ? [`attempt-${attempt}`] : []),
    request.promptHash,
  ].join('::');
}

function isTerminalOutcome(outcomeStatus) {
  return TERMINAL_OUTCOMES.has(outcomeStatus);
}

module.exports = {
  TERMINAL_OUTCOMES,
  promptIdempotencyKey,
  isTerminalOutcome,
};
