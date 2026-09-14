'use strict';

// What the user should end up seeing, from the plan's "What done looks like".
//
// These assert the OUTCOME, not the mechanism. The instancing one does not know
// that `buildCartridgeView` exists or how a definition gets resolved; it knows
// that after instancing a blueprint, the cartridge on screen has that
// blueprint's name and model. It fails wherever the chain broke.
//
// That distinction is the whole point, and it is not theoretical. The link
// between a blueprint and its instance did nothing at all for a while: a linked
// instance carries no definition of its own, and nobody had written the code
// that resolves it from the blueprint. Every unit test passed, because every
// piece was correct -- the instance stored its reference, the blueprint stored
// its definition, the renderer drew what it was handed. None of them asked "and
// who joins these".
//
// It was a MISSING PIECE, not a wrong one. That is the cousin of "no writer",
// with a difference worth naming: there, nobody writes a field. Here, nobody
// PRODUCES a derived value that is stored nowhere. So the seam question
// generalises from "who writes this" to "who produces this", and the second
// includes the first.
//
// Which is also why these run through the real `buildView` rather than calling
// `buildCartridgeView` directly. The missing piece was the argument wiring --
// the view builder never being handed the blueprints. A test that passes them in
// itself would have gone green through the entire bug.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { configureProjectWorkspace, APP_ROOT } = require('../core/project-workspace');
const runtimeStore = require('../runtime/runtime-store');
const blueprintStore = require('../core/blueprint-store');
const dashboardServer = require('../dashboard/server');
const { deleteBlueprintEverywhere } = require('../core/blueprint-instances');
const {
  instanceFromBlueprint,
  saveAsBlueprint,
  unlink,
} = require('../../app/src/cartridges/instancing.ts');

// The blueprint store is app level by design, so a test cannot point it
// somewhere else without lying about what it is. The real file is saved and put
// back instead.
const TRAY_FILE = path.join(APP_ROOT, 'runtime', 'blueprints.json');

function withScene(run) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tao-outcome-'));
  const saved = fs.existsSync(TRAY_FILE) ? fs.readFileSync(TRAY_FILE, 'utf8') : null;
  fs.rmSync(TRAY_FILE, { force: true });

  try {
    configureProjectWorkspace(projectRoot);
    runtimeStore.ensureInitialized({ projectRoot });
    return run({ projectRoot, options: { projectRoot } });
  } finally {
    dashboardServer.disposeOpencodeRuntime();
    fs.rmSync(TRAY_FILE, { force: true });
    if (saved !== null) fs.writeFileSync(TRAY_FILE, saved, 'utf8');
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

function definition(overrides = {}) {
  return {
    name: 'Copper Circuit',
    role: 'SS',
    model: 'opencode-go/kimi-k3',
    adapter: 'opencode',
    cli: null,
    startupInstructions: 'Read the brief first.',
    ...overrides,
  };
}

// Instancing the way the app does it: the decision comes from the real module,
// the write from the real store.
function instanceInto(options, blueprint, at = { x: 320, y: 180 }) {
  const view = dashboardServer.buildView();
  const result = instanceFromBlueprint({
    blueprint,
    cartridges: view.cartridges || [],
    at,
    newId: () => `cart-${Math.random().toString(36).slice(2, 10)}`,
  });
  if (result.created) runtimeStore.saveProjectCartridge(options, result.cartridge);
  return result;
}

function cartridgesOnScreen() {
  return dashboardServer.buildView().cartridges || [];
}

// --- 1 ----------------------------------------------------------------------

function assertInstancingShowsTheBlueprintsDefinition() {
  withScene(({ options }) => {
    const { blueprint } = blueprintStore.saveBlueprint({}, { definition: definition(), trayIndex: 0 });

    instanceInto(options, blueprint);

    const [shown] = cartridgesOnScreen();
    assert.ok(shown, 'instancing a blueprint put nothing on the board');
    assert.ok(shown.definition, 'the cartridge has no definition, so nothing can be drawn');
    assert.equal(shown.definition.name, 'Copper Circuit', 'the cartridge does not show the blueprint\'s name');
    assert.equal(shown.definition.model, 'opencode-go/kimi-k3');
    assert.equal(shown.definition.startupInstructions, 'Read the brief first.');
    assert.equal(shown.linked, true);

    console.log('Outcome: instancing a blueprint shows a cartridge with that blueprint\'s definition.');
  });
}

// --- 2 ----------------------------------------------------------------------

function assertEditingABlueprintChangesItsInstances() {
  withScene(({ options }) => {
    const { blueprint } = blueprintStore.saveBlueprint({}, { definition: definition(), trayIndex: 0 });
    instanceInto(options, blueprint);

    blueprintStore.saveBlueprint({}, {
      id: blueprint.id,
      definition: definition({ name: 'Copper Circuit MK2', model: 'opencode-go/gpt-5.6-luna' }),
      trayIndex: 0,
    });

    const [shown] = cartridgesOnScreen();
    assert.equal(shown.definition.name, 'Copper Circuit MK2', 'editing the blueprint did not reach its instance');
    assert.equal(shown.definition.model, 'opencode-go/gpt-5.6-luna');
    assert.equal(shown.blueprintRevision, 2);

    console.log('Outcome: editing a blueprint changes the cartridges that follow it.');
  });
}

// --- 3 ----------------------------------------------------------------------

function assertUnlinkingStopsPropagation() {
  withScene(({ options }) => {
    const { blueprint } = blueprintStore.saveBlueprint({}, { definition: definition(), trayIndex: 0 });
    instanceInto(options, blueprint);

    const [before] = cartridgesOnScreen();
    runtimeStore.saveProjectCartridge(options, unlink(before, [blueprint]));

    const [unlinked] = cartridgesOnScreen();
    assert.equal(unlinked.linked, false, 'the cartridge still follows the blueprint after unlinking');
    assert.equal(unlinked.templateId, null);
    assert.equal(unlinked.definition.name, 'Copper Circuit', 'unlinking lost the definition it was supposed to keep');

    // The half that matters: a later edit must not reach it.
    blueprintStore.saveBlueprint({}, {
      id: blueprint.id,
      definition: definition({ name: 'Changed After Unlinking', model: 'changed' }),
      trayIndex: 0,
    });

    const [after] = cartridgesOnScreen();
    assert.equal(after.definition.name, 'Copper Circuit', 'a blueprint edit reached a cartridge that had unlinked from it');
    assert.equal(after.definition.model, 'opencode-go/kimi-k3');
    assert.equal(after.blueprintRevision, null);

    console.log('Outcome: after unlinking, editing the blueprint no longer touches the cartridge.');
  });
}

// --- 4 ----------------------------------------------------------------------

// User decision Q4: deleting a blueprint unlinks its instances. Nothing stops,
// nothing is lost -- each keeps a snapshot and carries on as an ordinary local
// cartridge.
function assertDeletingABlueprintLeavesItsInstancesAlive() {
  withScene(({ options }) => {
    const { blueprint } = blueprintStore.saveBlueprint({}, { definition: definition(), trayIndex: 0 });
    instanceInto(options, blueprint);

    // Deleting goes through the operation that unlinks first and removes last,
    // not through the bare store call -- the store call alone is what left
    // instances pointing at nothing.
    const result = deleteBlueprintEverywhere(blueprint.id, { projectRoots: [options.projectRoot] });
    assert.equal(result.deleted, true, `the delete was refused: ${result.reason}`);

    const [survivor] = cartridgesOnScreen();
    assert.ok(survivor, 'deleting a blueprint removed the cartridge that followed it');
    assert.ok(
      survivor.definition,
      'the surviving cartridge has no definition, so it cannot be drawn -- deleting a blueprint erased its instances in practice'
    );
    assert.equal(survivor.definition.name, 'Copper Circuit');
    assert.equal(survivor.linked, false, 'the cartridge still claims to follow a blueprint that no longer exists');
    assert.equal(survivor.templateId, null);

    console.log('Outcome: deleting a blueprint leaves its cartridges alive and unlinked.');
  });
}

// --- 5 ----------------------------------------------------------------------

function assertADuplicateInstanceIsRefusedAndWritesNothing() {
  withScene(({ options }) => {
    const { blueprint } = blueprintStore.saveBlueprint({}, { definition: definition(), trayIndex: 0 });
    instanceInto(options, blueprint);

    const before = runtimeStore.readProjectCartridges(options);
    assert.equal(before.length, 1);

    const refused = instanceInto(options, blueprint, { x: 600, y: 400 });

    assert.equal(refused.created, false, 'a second instance of one blueprint was created in the same project');
    assert.equal(refused.reason, 'already-instanced');

    const after = runtimeStore.readProjectCartridges(options);
    assert.equal(after.length, 1, 'the refused instancing wrote a row anyway');
    assert.equal(after[0].id, before[0].id, 'the refused instancing replaced the existing instance');
    assert.equal(cartridgesOnScreen().length, 1);

    console.log('Outcome: a duplicate instance is refused, and no row is written.');
  });
}

// Dropping a project cartridge into the tray consumes it: after the blueprint is
// saved, the source placement is removed from the project. The write order is
// load-bearing -- saving first keeps the cartridge recoverable if the blueprint
// write fails.
function assertSavingABlueprintConsumesTheSourcePlacement() {
  withScene(({ options }) => {
    runtimeStore.saveProjectCartridge(options, {
      id: 'cart-source',
      templateId: null,
      definition: definition({ name: 'Shelf Agent' }),
      x: 180,
      y: 220,
      slotId: null,
      activated: false,
      sessionId: null,
    });

    const [source] = cartridgesOnScreen();
    const saved = saveAsBlueprint({ cartridge: source, trayIndex: 0 });
    assert.equal(saved.saved, true, 'the source cartridge could not become a blueprint');

    const created = blueprintStore.saveBlueprint({}, saved.blueprint).blueprint;
    assert.ok(created.id, 'the blueprint save returned no id, so the source cannot be safely consumed');
    runtimeStore.removeProjectCartridge(options, source.id);

    assert.equal(cartridgesOnScreen().length, 0, 'the source cartridge stayed on the board after being put away');
    const [blueprint] = blueprintStore.readBlueprints({});
    assert.equal(blueprint.definition.name, 'Shelf Agent', 'the consumed cartridge did not survive as a tray blueprint');

    console.log('Outcome: saving a cartridge as a blueprint consumes the source placement.');
  });
}

function main() {
  assertInstancingShowsTheBlueprintsDefinition();
  assertEditingABlueprintChangesItsInstances();
  assertUnlinkingStopsPropagation();
  assertDeletingABlueprintLeavesItsInstancesAlive();
  assertADuplicateInstanceIsRefusedAndWritesNothing();
  assertSavingABlueprintConsumesTheSourcePlacement();

  console.log('Blueprint outcome validation passed.');
}

main();
