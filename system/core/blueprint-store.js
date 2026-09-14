'use strict';

// Blueprints: cartridge definitions that live in the tray.
//
// They are reusable across projects by definition, so they cannot live in a
// per-project key -- which is exactly what the old cartridge storage was, keyed
// per project by construction. This is app-level machine-local state, and it
// follows the shape `recent-projects.js` already established against APP_ROOT.
//
// **This store knows nothing about instances.** An instance lives in a project's
// coordination database and references a blueprint by id. The join between them
// belongs to the layer above; keeping it out of here is what stops this file
// from growing a second opinion about which instances exist, which is the two-
// writers shape that has cost the most in this project.
//
// Naming is settled (user decision Q5): blueprints, and instances that follow
// them. "Global" is retired -- it came from an early misreading of the feature
// as a shared singleton, and it is the wrong word for a template.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { APP_ROOT } = require('./project-workspace');

const SCHEMA_VERSION = 1;

function utcNow() {
  return new Date().toISOString();
}

// `storeRoot` exists so tests can point at a temporary directory. Production
// passes nothing and gets APP_ROOT, the same as recent-projects.
function blueprintsPath(options = {}) {
  const root = options.storeRoot || APP_ROOT;
  return path.join(root, 'runtime', 'blueprints.json');
}

function emptyStore() {
  return { schemaVersion: SCHEMA_VERSION, updatedAt: null, blueprints: [] };
}

// Reading never writes and never creates the file. The dashboard's read path had
// to learn this the hard way: a read that touches disk turns every poll into a
// write, and this one will be read on every render of the tray.
//
// A corrupt file degrades to empty rather than throwing. It is machine-local
// state a user can delete or edit; losing the tray is bad, and taking the app
// down with it is worse. The next write repairs it.
function readStore(options = {}) {
  const file = blueprintsPath(options);
  if (!fs.existsSync(file)) return emptyStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: parsed.updatedAt || null,
      blueprints: Array.isArray(parsed.blueprints) ? parsed.blueprints : [],
    };
  } catch (_) {
    return emptyStore();
  }
}

function writeStore(options, store) {
  const file = blueprintsPath(options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  return store;
}

// Tray order is what the user arranged, so it is what comes back. The id is the
// tie-break: two blueprints can share an index while one is being dragged past
// another, and without a stable second key the tray would reshuffle itself
// between two reads that changed nothing.
function sortForTray(blueprints) {
  return [...blueprints].sort((a, b) => {
    const byIndex = (Number(a.trayIndex) || 0) - (Number(b.trayIndex) || 0);
    if (byIndex !== 0) return byIndex;
    return String(a.id).localeCompare(String(b.id));
  });
}

function readBlueprints(options = {}) {
  return sortForTray(readStore(options).blueprints);
}

function normalizeDefinition(definition = {}) {
  return {
    name: definition.name || '',
    role: definition.role || '',
    model: definition.model || '',
    adapter: definition.adapter || null,
    cli: definition.cli || null,
    startupInstructions: definition.startupInstructions || null,
  };
}

function sameDefinition(a, b) {
  return JSON.stringify(normalizeDefinition(a)) === JSON.stringify(normalizeDefinition(b));
}

// Creates when there is no id, updates when there is.
//
// `revision` follows the DEFINITION and nothing else. It is what the tray's
// "this blueprint changed" prompt keys on, so counting a tray rearrangement as a
// change would ask the user about running instances every time they tidied up --
// a prompt with no consequence behind it, which is how prompts get dismissed
// without reading.
function saveBlueprint(options = {}, input = {}) {
  const store = readStore(options);
  const now = utcNow();
  const existing = input.id
    ? store.blueprints.find((entry) => entry.id === input.id)
    : null;

  if (input.id && !existing) {
    return { saved: false, reason: 'not-found' };
  }

  const definition = normalizeDefinition(input.definition);
  const trayIndex = Number.isFinite(Number(input.trayIndex)) ? Number(input.trayIndex) : 0;

  const blueprint = existing
    ? {
      ...existing,
      definition,
      trayIndex,
      revision: sameDefinition(existing.definition, definition)
        ? existing.revision
        : (Number(existing.revision) || 1) + 1,
      updatedAt: now,
    }
    : {
      id: `bp-${crypto.randomUUID()}`,
      definition,
      trayIndex,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };

  const blueprints = existing
    ? store.blueprints.map((entry) => (entry.id === blueprint.id ? blueprint : entry))
    : [...store.blueprints, blueprint];

  writeStore(options, { schemaVersion: SCHEMA_VERSION, updatedAt: now, blueprints });
  return { saved: true, blueprint };
}

// Deleting something already gone is not an error: two windows can both delete,
// and the second one must not fail for having lost the race.
function deleteBlueprint(options = {}, id) {
  if (!id) return { removed: 0 };
  const store = readStore(options);
  const blueprints = store.blueprints.filter((entry) => entry.id !== id);
  const removed = store.blueprints.length - blueprints.length;
  if (removed === 0) return { removed: 0 };

  writeStore(options, { schemaVersion: SCHEMA_VERSION, updatedAt: utcNow(), blueprints });
  return { removed };
}

// Reordering the tray: one write for the whole column.
//
// A reorder shifts everything between the item's old place and its new one, so
// saving blueprint by blueprint would be N round trips for one gesture -- and N
// chances to be interrupted halfway, leaving a column that is neither the old
// order nor the new one. The gesture produces the complete order and it lands in
// a single write.
//
// Places that arrive non-contiguous come back contiguous, so gaps cannot
// accumulate across gestures.
function reorderBlueprints(options = {}, order = []) {
  const store = readStore(options);
  const positions = new Map(
    (Array.isArray(order) ? order : [])
      .filter((entry) => entry && entry.id)
      .map((entry) => [entry.id, Number(entry.trayIndex) || 0]),
  );
  if (positions.size === 0) return { reordered: 0 };

  const now = utcNow();
  const blueprints = store.blueprints.map((entry) => (
    positions.has(entry.id)
      ? { ...entry, trayIndex: positions.get(entry.id), updatedAt: now }
      // The revision deliberately does not move: rearranging the tray is not a
      // change to what a blueprint defines, so it must not prompt anyone about
      // their running instances.
      : entry
  ));

  writeStore(options, { schemaVersion: SCHEMA_VERSION, updatedAt: now, blueprints });
  return { reordered: positions.size };
}

module.exports = {
  SCHEMA_VERSION,
  blueprintsPath,
  readBlueprints,
  saveBlueprint,
  deleteBlueprint,
  reorderBlueprints,
};
