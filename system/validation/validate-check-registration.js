'use strict';

// Every validator on disk has to actually run.
//
// This is the smallest check in the suite and it was the most overdue. Three
// validators sat in this directory unregistered: `validate-superseded-archive`
// and `validate-task-graph-integrity`, both passing and both covering ground
// nothing else covers, and `validate-assign-contention`, which was failing.
// Nobody saw any of it, because nothing ever ran them. Git has no record of them
// being removed from `check` -- they were simply never added.
//
// It is the same shape as the dead prompt cap, the retry that never retried and
// the identity check that reported a change every time: a safeguard that exists,
// looks like protection, and does nothing. That family has cost more here than
// any single bug, and this is the one member of it that is trivially decidable.
//
// The rule is deliberately dumb: a file matching validate-*.js is either named
// in a script, or listed below with a reason. There is no third state, because
// the third state is what this exists to prevent.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const VALIDATION_DIR = __dirname;
const PACKAGE_JSON = path.join(__dirname, '..', '..', 'package.json');

// Validators deliberately not in any script. Each needs a reason; "it is slow"
// is not one, that is what check:scenarios is for.
const UNREGISTERED_BY_DESIGN = new Map([
  // (empty -- add entries here with their reason rather than leaving a file
  // silently unrun)
]);

function main() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  const scripts = Object.values(pkg.scripts || {}).join(' \n');

  const onDisk = fs.readdirSync(VALIDATION_DIR)
    .filter((file) => /^validate-.*\.js$/.test(file))
    .sort();

  assert.ok(onDisk.length > 10, `expected a suite of validators, found ${onDisk.length}`);

  const unrun = onDisk.filter((file) => (
    !scripts.includes(file) && !UNREGISTERED_BY_DESIGN.has(file)
  ));

  assert.deepEqual(
    unrun,
    [],
    `${unrun.join(', ')} exists but no npm script runs it. A validator nobody runs is `
    + 'not a safety net, it is a file. Add it to check or check:scenarios, or declare '
    + 'it in UNREGISTERED_BY_DESIGN with a reason.'
  );

  // And the other direction: a script naming a validator that is not there fails
  // the whole run with a module-not-found, which is loud enough on its own --
  // but catching it here names it properly.
  const named = [...scripts.matchAll(/system\/validation\/(validate-[a-z0-9-]+\.js)/g)]
    .map((match) => match[1]);
  const missing = [...new Set(named)].filter((file) => !onDisk.includes(file));
  assert.deepEqual(missing, [], `a script runs ${missing.join(', ')}, which does not exist`);

  console.log(`Check registration: ${onDisk.length} validators on disk, all of them run.`);
  console.log('Check registration validation passed.');
}

main();
