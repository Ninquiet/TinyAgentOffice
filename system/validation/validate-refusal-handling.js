'use strict';

// A refusal that nobody looks at is read as success.
//
// Seam 7, mechanised. `sendPromptToOpencode` reports a refusal by returning
// `{ delivered: false, refusedReason }` rather than throwing, because hitting a
// cap is a normal outcome and not an error. That decision is right and it cost
// five bugs, one per caller, every one the same shape: the task left claimed
// with an agent owning work nobody told it about, a user's request recorded as
// sent and then vanishing, an agent marked working with the prompt still in the
// caller's hand.
//
// All five were fixed by reading the result. Nothing stops a sixth caller from
// not reading it, and the sixth caller will be written by someone who does not
// know any of this happened.
//
// What is decidable here is weaker than "handles the refusal correctly" -- that
// is semantic, and no check can have it. What a check can have is that the
// result is not thrown away: a call whose value is never bound and never
// inspected cannot possibly be handling a refusal. That is exactly the bug that
// occurred, five times.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SEND_FUNCTIONS = ['sendPrompt', 'sendPromptToOpencode'];

// Files that legitimately mention the names without calling them.
const NOT_CALLERS = new Set([
  path.join('opencode', 'provider.js'), // a capability flag, not a call
  path.join('dispatch', 'session-dispatch.js'), // defines them; checked separately below
]);

function sourceFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'validation' || entry.name === 'node_modules') continue;
      sourceFiles(full, found);
    } else if (entry.name.endsWith('.js')) {
      found.push(full);
    }
  }
  return found;
}

// A call is "discarded" when the line starts the statement with the call itself:
// `await x.sendPrompt(...)` or `x.sendPrompt(...)`, with nothing capturing it.
// Anything bound to a name, returned, or used in an expression is fine -- the
// question of whether it is then inspected properly is not decidable here, and
// the tests cover it.
function discardedCalls(source) {
  const discarded = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const name of SEND_FUNCTIONS) {
      // Word boundaries that still allow a method call. An earlier version used
      // a negated class containing `.` to stop `sendPrompt` matching inside
      // `sendPromptToOpencode`, and it excluded every `x.sendPrompt(` in the
      // codebase along with it -- the check passed while checking nothing,
      // which is the exact family of bug it exists to catch. Caught by
      // injecting a real discard and watching it stay green.
      const pattern = new RegExp(`(?<![\\w])${name}(?![\\w])\\s*\\(`);
      if (!pattern.test(line)) continue;
      if (/^\s*(\/\/|\*)/.test(line)) continue;

      const before = line.slice(0, line.indexOf(name));
      const captured = /[=:]\s*(await\s+)?[\w.]*$/.test(before)
        || /\breturn\s+(await\s+)?[\w.]*$/.test(before)
        || /[([,]\s*(await\s+)?[\w.]*$/.test(before);
      if (!captured) discarded.push({ line: index + 1, text: line.trim() });
    }
  }
  return discarded;
}

function main() {
  const offenders = [];

  for (const file of sourceFiles(ROOT)) {
    const relative = path.relative(ROOT, file);
    if (NOT_CALLERS.has(relative)) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (!SEND_FUNCTIONS.some((name) => source.includes(name))) continue;

    for (const hit of discardedCalls(source)) {
      offenders.push(`system/${relative.replace(/\\/g, '/')}:${hit.line}  ${hit.text}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'these send-path calls throw their result away, so a refusal there reads as success:\n  '
    + offenders.join('\n  ')
  );

  // The definitions themselves must keep reporting refusals as data. If this
  // ever starts throwing instead, every caller's handling becomes dead code and
  // this whole check is measuring nothing.
  const dispatch = fs.readFileSync(path.join(ROOT, 'dispatch', 'session-dispatch.js'), 'utf8');
  assert.ok(
    dispatch.includes('delivered: false'),
    'sendPromptToOpencode no longer returns a refusal as data; this check and every '
    + 'caller\'s refusal handling would be measuring nothing'
  );

  console.log('Refusal handling: no send-path call discards its result.');
  console.log('Refusal handling validation passed.');
}

main();
