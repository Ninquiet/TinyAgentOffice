'use strict';

// Cartridge placement becomes coordinator state (architecture review, finding 07).
//
// Today `App.tsx` holds the cartridges in React state and persists them to a
// per-project `localStorage` key, and `loadStoredBots` forces
// `sessionId: null, activated: false` on every load. So a refresh makes the UI
// forget what was running while the coordinator still holds the live sessions --
// two stores describing the same thing, and only one of them right.
//
// This is the storage layer for the move: a table, a narrow write path and a
// read path. No payload and no UI yet.
//
// Two rules are enforced here rather than in the callers:
//
// - One instance per template per project (user decision Q2) is a partial unique
//   index, so a code path that forgets to check cannot create a second one. The
//   returned refusal is for the expected case; the constraint is what holds when
//   the expected case is bypassed.
// - The legacy import runs once and records that it ran. "Import when the store
//   is empty" would resurrect cartridges the user deleted, the next time the
//   project was opened.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const runtimeStore = require('../runtime/runtime-store');

function tempProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-cartridges-'));
  runtimeStore.ensureInitialized({ projectRoot });
  return projectRoot;
}

async function withProject(run) {
  const projectRoot = tempProject();
  try {
    return await run({ projectRoot });
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

function cartridge(overrides = {}) {
  return {
    id: 'cart-1',
    templateId: null,
    definition: {
      name: 'Copper Circuit',
      role: 'SS',
      model: 'opencode-go/kimi-k3',
      adapter: 'opencode',
      startupInstructions: 'Read the brief first.',
    },
    x: 320,
    y: 180,
    slotId: null,
    activated: false,
    sessionId: null,
    ...overrides,
  };
}

// A placement written is a placement read back, with its types intact.
async function assertPlacementRoundTrips() {
  await withProject(async (options) => {
    runtimeStore.saveProjectCartridge(options, cartridge({ x: 320.5, y: 180.25, slotId: 'slot-2' }));

    const stored = runtimeStore.readProjectCartridges(options);
    assert.equal(stored.length, 1);
    const [entry] = stored;
    assert.equal(entry.id, 'cart-1');
    assert.equal(entry.x, 320.5, 'positions are fractional and must not be rounded to integers');
    assert.equal(entry.y, 180.25);
    assert.equal(entry.slotId, 'slot-2');
    assert.equal(entry.templateId, null);
    assert.deepEqual(entry.definition.name, 'Copper Circuit');
    assert.equal(entry.definition.startupInstructions, 'Read the brief first.');

    console.log('Cartridges: a placement round-trips with its types intact.');
  });
}

// The bug this move exists to fix. `loadStoredBots` forced activation off on
// every load, so a refresh forgot what was running.
async function assertActivationSurvives() {
  await withProject(async (options) => {
    runtimeStore.saveProjectCartridge(options, cartridge({
      activated: true,
      sessionId: 'copper-circuit-ss-1787090906554',
    }));

    const [entry] = runtimeStore.readProjectCartridges(options);
    assert.equal(entry.activated, true, 'activation must survive; forgetting it is the bug being fixed');
    assert.equal(entry.sessionId, 'copper-circuit-ss-1787090906554',
      'the link to the registry session must survive, or the UI cannot rejoin a running agent');

    console.log('Cartridges: activation and the session link survive a reload.');
  });
}

// Saving the same id again moves it; it does not accumulate rows. Placement is
// committed on drop, so this is the common write.
async function assertSavingAgainMovesRatherThanDuplicates() {
  await withProject(async (options) => {
    runtimeStore.saveProjectCartridge(options, cartridge());
    runtimeStore.saveProjectCartridge(options, cartridge({ x: 900, y: 40, slotId: 'slot-3' }));

    const stored = runtimeStore.readProjectCartridges(options);
    assert.equal(stored.length, 1, 'saving the same cartridge twice created a second row');
    assert.equal(stored[0].x, 900);
    assert.equal(stored[0].slotId, 'slot-3');

    console.log('Cartridges: saving an existing cartridge moves it.');
  });
}

// User decision Q2: one instance per template per project. Across projects is
// the whole point of the feature; within one project it is refused.
async function assertOneInstancePerTemplate() {
  await withProject(async (options) => {
    const first = runtimeStore.saveProjectCartridge(options, cartridge({ id: 'cart-1', templateId: 'tpl-pm' }));
    assert.equal(first.saved, true);

    const second = runtimeStore.saveProjectCartridge(options, cartridge({ id: 'cart-2', templateId: 'tpl-pm' }));
    assert.equal(second.saved, false, 'a second instance of the same template was allowed');
    assert.equal(second.reason, 'duplicate-template');

    const stored = runtimeStore.readProjectCartridges(options);
    assert.equal(stored.length, 1, 'the refused save wrote a row anyway');
    assert.equal(stored[0].id, 'cart-1', 'the refused save replaced the existing instance');

    // The refusal is for the expected path. The constraint is what holds when a
    // new code path forgets to look at it -- the same reason the prompt ledger
    // keys on the database rather than on a check in the caller.
    const paths = runtimeStore.resolvePaths(options);
    const db = new DatabaseSync(paths.dbPath);
    try {
      assert.throws(
        () => db.prepare(`
          INSERT INTO project_cartridges
            (id, template_id, definition_json, position_x, position_y, slot_id, activated, session_id, created_at, updated_at)
          VALUES ('cart-3', 'tpl-pm', NULL, 0, 0, NULL, 0, NULL, '2026-08-19', '2026-08-19')
        `).run(),
        /UNIQUE|constraint/i,
        'the database allows two instances of one template; the rule is only in the caller'
      );
    } finally {
      db.close();
    }

    console.log('Cartridges: one instance per template per project, enforced by the schema.');
  });
}

// The partial index must not treat unlinked cartridges as duplicates of each
// other. A project can hold any number of purely local cartridges.
async function assertUnlinkedCartridgesAreNotDuplicates() {
  await withProject(async (options) => {
    for (const id of ['local-1', 'local-2', 'local-3']) {
      const result = runtimeStore.saveProjectCartridge(options, cartridge({ id, templateId: null }));
      assert.equal(result.saved, true, `${id} was refused as a duplicate; NULL template ids must not collide`);
    }

    assert.equal(runtimeStore.readProjectCartridges(options).length, 3);
    console.log('Cartridges: unlinked cartridges do not collide with each other.');
  });
}

async function assertRemovalRemoves() {
  await withProject(async (options) => {
    runtimeStore.saveProjectCartridge(options, cartridge({ id: 'cart-1' }));
    runtimeStore.saveProjectCartridge(options, cartridge({ id: 'cart-2' }));

    runtimeStore.removeProjectCartridge(options, 'cart-1');

    const stored = runtimeStore.readProjectCartridges(options);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, 'cart-2');
    console.log('Cartridges: removal removes exactly one.');
  });
}

// The migration, and the resurrection it must not cause.
//
// "Import when the store is empty" is not enough: a user who deletes every
// cartridge leaves an empty store, and the next open would import the browser's
// copy again. The marker records that the import happened, so an empty store
// stays empty.
async function assertLegacyImportRunsOnceOnly() {
  await withProject(async (options) => {
    const legacy = [cartridge({ id: 'old-1' }), cartridge({ id: 'old-2' })];

    const first = runtimeStore.importLegacyProjectCartridges(options, legacy);
    assert.equal(first.imported, 2);
    assert.equal(runtimeStore.readProjectCartridges(options).length, 2);

    // Same browser, second load: nothing to do.
    const second = runtimeStore.importLegacyProjectCartridges(options, legacy);
    assert.equal(second.imported, 0, 'the import ran twice');
    assert.equal(second.reason, 'already-imported');
    assert.equal(runtimeStore.readProjectCartridges(options).length, 2);

    // The user deletes everything, then reopens the project. The browser still
    // has its copy. Nothing may come back.
    runtimeStore.removeProjectCartridge(options, 'old-1');
    runtimeStore.removeProjectCartridge(options, 'old-2');
    assert.equal(runtimeStore.readProjectCartridges(options).length, 0);

    const third = runtimeStore.importLegacyProjectCartridges(options, legacy);
    assert.equal(third.imported, 0, 'deleted cartridges were resurrected from localStorage');
    assert.equal(runtimeStore.readProjectCartridges(options).length, 0);

    console.log('Cartridges: the legacy import runs once and cannot resurrect deleted cartridges.');
  });
}

// The import is the only step in this feature a user cannot undo, so it needs a
// door back in.
//
// If it goes wrong -- half the cartridges, positions lost -- the marker is
// already set and the ordinary path will not run again. The source data is still
// in localStorage, so nothing is lost; what is missing is a way to retry.
// `force` is that way, and it repairs rather than skips: re-running has to be
// able to fix rows that came in wrong, which `DO NOTHING` would leave exactly as
// they are.
async function assertForceCanRepeatTheImport() {
  await withProject(async (options) => {
    // A first import that went wrong: one of the two cartridges, in the wrong place.
    runtimeStore.importLegacyProjectCartridges(options, [cartridge({ id: 'old-1', x: 0, y: 0 })]);
    assert.equal(runtimeStore.readProjectCartridges(options).length, 1);

    const good = [
      cartridge({ id: 'old-1', x: 320, y: 180 }),
      cartridge({ id: 'old-2', x: 640, y: 240 }),
    ];

    // The ordinary path is closed, which is the whole point of the marker.
    assert.equal(runtimeStore.importLegacyProjectCartridges(options, good).imported, 0);

    const forced = runtimeStore.importLegacyProjectCartridges(options, good, { force: true });
    assert.equal(forced.imported, 2, 'force did not repeat the import');

    const stored = runtimeStore.readProjectCartridges(options);
    assert.equal(stored.length, 2, 'the missing cartridge was not recovered');
    const repaired = stored.find((entry) => entry.id === 'old-1');
    assert.equal(repaired.x, 320, 'force skipped the row that came in wrong instead of repairing it');
    assert.equal(repaired.y, 180);

    // And it stays closed afterwards, so force is a deliberate act each time.
    assert.equal(runtimeStore.importLegacyProjectCartridges(options, good).imported, 0);

    console.log('Cartridges: a failed import can be repeated with force, and only with force.');
  });
}

// A narrow write path, like appendWorkflowTransitions: it takes the lock and
// writes its own table, and does not rewrite the JSON mirrors. Placement is
// committed on every drop, so rewriting tasks.json on each one would put a
// cosmetic gesture on the hot write path.
async function assertWritesDoNotTouchTheJsonMirrors() {
  await withProject(async (options) => {
    const paths = runtimeStore.resolvePaths(options);
    runtimeStore.saveProjectCartridge(options, cartridge());

    const before = {
      tasks: fs.statSync(paths.tasksPath).mtimeMs,
      registry: fs.statSync(paths.registryPath).mtimeMs,
    };

    for (let i = 0; i < 10; i += 1) {
      runtimeStore.saveProjectCartridge(options, cartridge({ x: 100 + i, y: 200 + i }));
    }

    assert.equal(fs.statSync(paths.tasksPath).mtimeMs, before.tasks,
      'moving a cartridge rewrote tasks.json');
    assert.equal(fs.statSync(paths.registryPath).mtimeMs, before.registry,
      'moving a cartridge rewrote agents.json');

    console.log('Cartridges: the write path stays out of the JSON mirrors.');
  });
}

async function main() {
  await assertPlacementRoundTrips();
  await assertActivationSurvives();
  await assertSavingAgainMovesRatherThanDuplicates();
  await assertOneInstancePerTemplate();
  await assertUnlinkedCartridgesAreNotDuplicates();
  await assertRemovalRemoves();
  await assertLegacyImportRunsOnceOnly();
  await assertForceCanRepeatTheImport();
  await assertWritesDoNotTouchTheJsonMirrors();

  console.log('Project cartridge store validation passed.');
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
