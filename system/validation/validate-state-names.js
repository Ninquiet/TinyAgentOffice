'use strict';

// Every state name compared outside the state machine has to be a real state.
//
// The state machine owns `STATES`. Other modules decide things by comparing a
// session's state against string literals: the daemon will only schedule when
// `runtime.state === 'idle'`, the watchdog releases on `unknown` and `failed`.
// Those literals are not connected to `STATES` by anything but spelling.
//
// Rename or remove a state and the comparison does not break -- it just stops
// being true. The daemon would find nothing schedulable, ever. That is the
// failure mode this refactor already lived through once, when `runtimeState`
// had no writer for idle agents: total deadlock, and every test green, because
// nothing in a test suite notices a comparison that is merely always false.
//
// Both lists are enumerable, so this is decidable. What is NOT decidable, and
// deliberately not attempted, is whether the right states are in the right sets
// -- whether `rate_limited` should count as abandoned is a policy decision that
// belongs in the code and its comments, not here.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sessionState = require('../opencode/session-state');

// Where state names are compared or collected, and what to read out of each.
const SITES = [
  {
    file: path.join('daemon', 'agent-daemon.js'),
    what: 'the scheduler',
    // runtime.state === 'idle' / runtimeState !== 'x'
    pattern: /(?:runtime\.state|runtimeState|\.state)\s*(?:===|!==)\s*'([a-z_]+)'/g,
  },
  {
    file: path.join('opencode', 'activity-watchdog.js'),
    what: 'the watchdog',
    // ABANDONED_STATES = new Set(['unknown', 'failed'])
    pattern: /ABANDONED_STATES\s*=\s*new Set\(\[([^\]]*)\]\)/g,
    list: true,
  },
];

function statesIn(source, site) {
  const found = new Set();
  for (const match of source.matchAll(site.pattern)) {
    if (site.list) {
      for (const literal of match[1].matchAll(/'([a-z_]+)'/g)) found.add(literal[1]);
    } else {
      found.add(match[1]);
    }
  }
  return [...found];
}

function main() {
  const known = new Set(sessionState.STATES);
  assert.ok(known.size >= 5, `expected the state machine to declare its states, found ${known.size}`);

  const unknown = [];
  let compared = 0;

  for (const site of SITES) {
    const full = path.join(ROOT, site.file);
    const source = fs.readFileSync(full, 'utf8');
    const names = statesIn(source, site);

    assert.ok(
      names.length > 0,
      `${site.file} no longer compares any state name. Either ${site.what} stopped `
      + 'reading the state machine, or this check has gone blind and is passing for '
      + 'the wrong reason.'
    );

    compared += names.length;
    for (const name of names) {
      if (!known.has(name)) unknown.push(`${site.file}: '${name}' (${site.what})`);
    }
  }

  assert.deepEqual(
    unknown,
    [],
    'these compare against a state the machine does not have, so the comparison is '
    + 'simply never true:\n  ' + unknown.join('\n  ')
    + `\n  known states: ${[...known].join(', ')}`
  );

  // The one the whole scheduler hangs on. If `idle` is ever renamed, this names
  // it rather than leaving a silent deadlock.
  assert.ok(known.has('idle'), 'the schedulable state is gone; the daemon can never dispatch');
  assert.ok(
    sessionState.isSchedulable({ state: 'idle' }),
    'idle exists but is no longer schedulable, and nothing else is'
  );

  console.log(`State names: ${compared} comparisons across ${SITES.length} modules, all real states.`);
  console.log('State name validation passed.');
}

main();
