'use strict';

// Fails when a module writes a cross-boundary field it does not own.
//
// This is the mechanical version of the question that found five integration
// bugs: who writes this, and who reads it. Two of those bugs were a writer count
// being wrong -- zero for `runtimeState` on idle agents, two for the session id
// -- and a scan catches that shape before it ships.
//
// Declarations live in field-ownership.js, exceptions included, with reasons.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { OWNERSHIP } = require('./field-ownership');

const SYSTEM_DIR = path.resolve(__dirname, '..');
const REPO_DIR = path.resolve(SYSTEM_DIR, '..');

function sourceFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!/\.(js|cjs)$/.test(entry.name)) continue;
      // The validation suite builds fixtures; it is not production wiring.
      if (full.startsWith(path.join(SYSTEM_DIR, 'validation'))) continue;
      files.push(full);
    }
  };
  walk(SYSTEM_DIR);
  return files;
}

function relative(file) {
  return path.relative(REPO_DIR, file).split(path.sep).join('/');
}

// Property assignment only: `something.field =`, not `field:` in an object
// literal and not a comparison. Building a value is not owning the field; the
// bug shape is a module reaching into shared state and writing it.
function writesIn(source, field) {
  const pattern = new RegExp(`\\.${field}\\s*=(?!=)`);
  const hits = [];
  source.split('\n').forEach((line, index) => {
    if (line.trim().startsWith('//')) return;
    if (pattern.test(line)) hits.push(index + 1);
  });
  return hits;
}

function assertOnlyDeclaredWritersTouchOwnedFields() {
  const files = sourceFiles();
  const violations = [];

  for (const rule of OWNERSHIP) {
    const allowed = new Set(rule.writers);
    for (const file of files) {
      const relativePath = relative(file);
      if (allowed.has(relativePath)) continue;
      const lines = writesIn(fs.readFileSync(file, 'utf8'), rule.field);
      for (const line of lines) {
        violations.push(`${relativePath}:${line} writes ${rule.field} (owned by ${rule.writers.join(', ')})`);
      }
    }
  }

  assert.deepEqual(violations, [], [
    'These modules write a field they do not own:',
    ...violations.map((entry) => `  ${entry}`),
    '',
    'Either route the write through the owner, or add the file to',
    'system/validation/field-ownership.js WITH a reason. An undeclared second',
    'writer is what made the UI and the scheduler disagree about the same agent.',
  ].join('\n'));
}

// A declaration listing a file that no longer writes the field is stale, and a
// stale freeze quietly stops freezing anything.
function assertDeclarationsAreNotStale() {
  const stale = [];

  for (const rule of OWNERSHIP) {
    for (const writer of rule.writers) {
      const full = path.join(REPO_DIR, writer);
      if (!fs.existsSync(full)) {
        stale.push(`${writer} is declared as a writer of ${rule.field} but does not exist`);
        continue;
      }
      if (writesIn(fs.readFileSync(full, 'utf8'), rule.field).length === 0) {
        stale.push(`${writer} is declared as a writer of ${rule.field} but no longer writes it`);
      }
    }
  }

  assert.deepEqual(stale, [], [
    'Stale ownership declarations:',
    ...stale.map((entry) => `  ${entry}`),
    '',
    'Remove them. A declaration that lists writers which no longer exist makes',
    'the freeze wider than reality and lets a real second writer slip in.',
  ].join('\n'));
}

// Every rule has to say why, because the reason is the part that survives.
function assertEveryRuleExplainsItself() {
  for (const rule of OWNERSHIP) {
    assert.ok(rule.field, 'a rule has no field');
    assert.ok(Array.isArray(rule.writers) && rule.writers.length > 0, `${rule.field} has no declared writer`);
    assert.ok(rule.reason && rule.reason.length > 20, `${rule.field} has no reason worth reading`);
  }
}

function main() {
  assertEveryRuleExplainsItself();
  assertOnlyDeclaredWritersTouchOwnedFields();
  assertDeclarationsAreNotStale();

  console.log('Field ownership validation passed.');
}

main();
