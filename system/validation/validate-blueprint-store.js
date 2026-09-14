'use strict';

// Blueprints: the definitions that live in the tray, not in any project.
//
// They are reusable across projects by definition, so they cannot live in a
// per-project store. This is app-level machine-local state, the same shape as
// `runtime/recent-projects.json` and handled the same way.
//
// The store deliberately knows nothing about instances. An instance lives in a
// project's coordination database and references a blueprint by id; the join
// between them belongs to the layer above, and keeping it out of here is what
// stops this from growing a second opinion about which instances exist.
//
// Naming is settled (user decision Q5): these are blueprints, and instances
// follow them. The word "global" is retired -- it came from an early misreading
// of the feature as a shared singleton.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const blueprintStore = require('../core/blueprint-store');

function withStore(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-blueprints-'));
  try {
    return run({ storeRoot: root });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function definition(overrides = {}) {
  return {
    name: 'Copper Circuit',
    role: 'SS',
    model: 'opencode-go/kimi-k3',
    adapter: 'opencode',
    startupInstructions: 'Read the brief first.',
    ...overrides,
  };
}

function assertABlueprintRoundTrips() {
  withStore((options) => {
    const created = blueprintStore.saveBlueprint(options, {
      definition: definition(),
      trayIndex: 0,
    });

    assert.ok(created.blueprint.id, 'a blueprint needs an id the instances can reference');
    assert.equal(created.blueprint.definition.name, 'Copper Circuit');
    assert.equal(created.blueprint.definition.startupInstructions, 'Read the brief first.');
    assert.equal(created.blueprint.trayIndex, 0);

    const [stored] = blueprintStore.readBlueprints(options);
    assert.deepEqual(stored, created.blueprint, 'what was read back is not what was written');

    console.log('Blueprints: a blueprint round-trips with its definition intact.');
  });
}

// The point of the feature: they belong to the app, so they survive a project
// switch and a restart. Reading through a fresh call with no cached state is the
// closest this layer gets to proving it.
function assertBlueprintsAreNotPerProject() {
  withStore((options) => {
    blueprintStore.saveBlueprint(options, { definition: definition(), trayIndex: 0 });

    // Nothing about a project is passed in, anywhere. If this ever needs one,
    // the store has stopped being app-level.
    assert.equal(
      blueprintStore.readBlueprints(options).length,
      1,
      'reading blueprints required knowing a project, which defeats the whole feature'
    );

    console.log('Blueprints: reading them does not require knowing a project.');
  });
}

function assertSavingAgainUpdatesRatherThanDuplicates() {
  withStore((options) => {
    const created = blueprintStore.saveBlueprint(options, { definition: definition(), trayIndex: 0 });
    const updated = blueprintStore.saveBlueprint(options, {
      id: created.blueprint.id,
      definition: definition({ model: 'opencode-go/gpt-5.6-luna' }),
      trayIndex: 3,
    });

    const stored = blueprintStore.readBlueprints(options);
    assert.equal(stored.length, 1, 'editing a blueprint created a second one');
    assert.equal(stored[0].definition.model, 'opencode-go/gpt-5.6-luna');
    assert.equal(stored[0].trayIndex, 3);
    assert.equal(updated.blueprint.id, created.blueprint.id, 'the id must survive an edit');
    assert.equal(updated.blueprint.createdAt, created.blueprint.createdAt, 'createdAt must not be rewritten');

    console.log('Blueprints: editing keeps the id, so instances stay linked.');
  });
}

// An edit has to be visible as an edit. The tray prompt has to name instances
// affected by a change, and "was it changed" is what triggers it.
function assertAnEditAdvancesTheRevision() {
  withStore((options) => {
    const created = blueprintStore.saveBlueprint(options, { definition: definition(), trayIndex: 0 });
    assert.equal(created.blueprint.revision, 1, 'a new blueprint starts at revision 1');

    const edited = blueprintStore.saveBlueprint(options, {
      id: created.blueprint.id,
      definition: definition({ model: 'changed' }),
      trayIndex: 0,
    });
    assert.equal(edited.blueprint.revision, 2, 'editing the definition did not advance the revision');

    // Moving it in the tray is not a change to what it defines, so instances are
    // unaffected and must not be prompted about.
    const moved = blueprintStore.saveBlueprint(options, {
      id: created.blueprint.id,
      definition: definition({ model: 'changed' }),
      trayIndex: 5,
    });
    assert.equal(
      moved.blueprint.revision,
      2,
      'rearranging the tray counted as a definition change, which would prompt about instances for nothing'
    );

    console.log('Blueprints: the revision follows the definition, not the tray position.');
  });
}

function assertDeletingRemovesExactlyOne() {
  withStore((options) => {
    const first = blueprintStore.saveBlueprint(options, { definition: definition(), trayIndex: 0 });
    blueprintStore.saveBlueprint(options, { definition: definition({ name: 'Neon Socket' }), trayIndex: 1 });

    const result = blueprintStore.deleteBlueprint(options, first.blueprint.id);
    assert.equal(result.removed, 1);

    const stored = blueprintStore.readBlueprints(options);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].definition.name, 'Neon Socket');

    // Deleting something that is not there is not an error: two windows can both
    // delete, and the second must not fail.
    assert.equal(blueprintStore.deleteBlueprint(options, first.blueprint.id).removed, 0);

    console.log('Blueprints: deleting removes one, and deleting twice is not an error.');
  });
}

// Tray order is what the user arranged. It has to come back in that order rather
// than in whatever order the file happens to hold.
function assertTrayOrderIsStable() {
  withStore((options) => {
    const c = blueprintStore.saveBlueprint(options, { definition: definition({ name: 'C' }), trayIndex: 2 });
    const a = blueprintStore.saveBlueprint(options, { definition: definition({ name: 'A' }), trayIndex: 0 });
    const b = blueprintStore.saveBlueprint(options, { definition: definition({ name: 'B' }), trayIndex: 1 });

    const names = blueprintStore.readBlueprints(options).map((entry) => entry.definition.name);
    assert.deepEqual(names, ['A', 'B', 'C'], 'the tray came back in the wrong order');

    // Two blueprints given the same index must still come back in a stable
    // order, or the tray reshuffles itself between reads for no reason.
    blueprintStore.saveBlueprint(options, { id: b.blueprint.id, definition: definition({ name: 'B' }), trayIndex: 0 });
    const first = blueprintStore.readBlueprints(options).map((entry) => entry.definition.name);
    const second = blueprintStore.readBlueprints(options).map((entry) => entry.definition.name);
    assert.deepEqual(first, second, 'two reads of the same tray produced different orders');

    void a; void c;
    console.log('Blueprints: the tray comes back in the order the user arranged, stably.');
  });
}

// A corrupt or missing file must not take the app down. It is machine-local
// state a user could delete, and losing the tray is bad but crashing is worse.
function assertACorruptFileIsSurvivable() {
  withStore((options) => {
    blueprintStore.saveBlueprint(options, { definition: definition(), trayIndex: 0 });
    fs.writeFileSync(blueprintStore.blueprintsPath(options), '{ this is not json', 'utf8');

    assert.doesNotThrow(
      () => blueprintStore.readBlueprints(options),
      'a corrupt blueprints file crashed the read instead of degrading'
    );
    assert.deepEqual(blueprintStore.readBlueprints(options), []);

    // And it must be writable again afterwards rather than staying broken.
    const recovered = blueprintStore.saveBlueprint(options, { definition: definition(), trayIndex: 0 });
    assert.ok(recovered.blueprint.id);
    assert.equal(blueprintStore.readBlueprints(options).length, 1);

    console.log('Blueprints: a corrupt file degrades to empty and can be written again.');
  });
}

// Reading must not write. The same rule the dashboard read path had to learn:
// a read that touches disk turns every poll into a write.
function assertReadingDoesNotWrite() {
  withStore((options) => {
    blueprintStore.saveBlueprint(options, { definition: definition(), trayIndex: 0 });
    const file = blueprintStore.blueprintsPath(options);
    const before = fs.statSync(file).mtimeMs;

    for (let i = 0; i < 20; i += 1) blueprintStore.readBlueprints(options);

    assert.equal(fs.statSync(file).mtimeMs, before, 'reading the tray rewrote the file');

    // An empty store must not create the file either.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-bp-empty-'));
    try {
      assert.deepEqual(blueprintStore.readBlueprints({ storeRoot: empty }), []);
      assert.equal(
        fs.existsSync(blueprintStore.blueprintsPath({ storeRoot: empty })),
        false,
        'reading an empty store created the file'
      );
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }

    console.log('Blueprints: reading never writes, and never creates the file.');
  });
}

function main() {
  assertABlueprintRoundTrips();
  assertBlueprintsAreNotPerProject();
  assertSavingAgainUpdatesRatherThanDuplicates();
  assertAnEditAdvancesTheRevision();
  assertDeletingRemovesExactlyOne();
  assertTrayOrderIsStable();
  assertACorruptFileIsSurvivable();
  assertReadingDoesNotWrite();

  console.log('Blueprint store validation passed.');
}

main();
