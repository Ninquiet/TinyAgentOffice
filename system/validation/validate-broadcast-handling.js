'use strict';

// Every event the server broadcasts has to be handled by the client.
//
// This is the fourth seam shape -- a value that stops existing between a correct
// writer and a correct reader -- in the one place it can be caught mechanically.
//
// It has now happened twice in one slice, in two different layers. `splitPayload`
// in the hub names the sections it diffs, so a section added to the payload alone
// arrives on the initial snapshot and never updates; that was predicted, and a
// test covers it. The client then has its own list, in useDashboardData, and
// adding the broadcast without adding the handler produces exactly the same
// symptom one layer further out: it looks like it works on load, and a second
// window never sees a change. That one was not predicted, and cost a live debug
// session to find.
//
// So the two lists are compared. This cannot catch a field dropped from inside a
// section's payload -- nothing can -- but it does catch a whole section that the
// far side has never heard of, which is the version that keeps happening.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const HUB = path.join(__dirname, '..', 'dashboard', 'websocket-hub.js');
const CLIENT_FILES = [
  path.join(__dirname, '..', '..', 'app', 'src', 'hooks', 'useDashboardData.ts'),
  path.join(__dirname, '..', '..', 'app', 'src', 'store.ts'),
];
const TYPES = path.join(__dirname, '..', '..', 'app', 'src', 'types.ts');

// Emitted by the hub for diagnostics rather than state, so nothing has to
// reduce them into the payload.
const NOT_STATE = new Set(['dashboard.snapshot', 'dashboard.error']);

function broadcastEventTypes() {
  const source = fs.readFileSync(HUB, 'utf8');
  const types = new Set();
  for (const match of source.matchAll(/this\.broadcast\(\s*\{\s*type:\s*'([^']+)'/g)) {
    types.add(match[1]);
  }
  return [...types];
}

function main() {
  const emitted = broadcastEventTypes();
  assert.ok(emitted.length >= 8, `expected the hub to broadcast a set of events, found ${emitted.length}`);

  const client = CLIENT_FILES.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  const declared = fs.readFileSync(TYPES, 'utf8');

  const unhandled = [];
  const undeclared = [];
  for (const type of emitted) {
    if (NOT_STATE.has(type)) continue;
    if (!client.includes(`'${type}'`)) unhandled.push(type);
    if (!declared.includes(`'${type}'`)) undeclared.push(type);
  }

  assert.deepEqual(
    unhandled,
    [],
    `the server broadcasts ${unhandled.join(', ')} and no client reducer handles it -- `
    + 'it will arrive on the initial snapshot and never update again'
  );

  assert.deepEqual(
    undeclared,
    [],
    `${undeclared.join(', ')} is broadcast but missing from the DashboardEvent union, `
    + 'so a handler for it would not type-check'
  );

  console.log(`Broadcast handling: ${emitted.length} event types, all handled and declared.`);
  console.log('Broadcast handling validation passed.');
}

main();
