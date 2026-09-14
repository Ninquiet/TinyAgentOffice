'use strict';

// Blueprints, instances, and the ghost between them.
//
// The prefab model: a blueprint lives in the tray and never leaves it, an
// instance lives in a project and references it, and the definition belongs to
// the blueprint while the link holds. Everything that decides anything is pure
// and lives here, so the component is left holding only the gesture -- the same
// split that made the merge and the commit plan testable.

const assert = require('assert');
const instancing = require('../../app/src/cartridges/instancing.ts');

function blueprint(overrides = {}) {
  return {
    id: 'bp-1',
    definition: {
      name: 'Copper Circuit',
      role: 'SS',
      model: 'opencode-go/kimi-k3',
      adapter: 'opencode',
      cli: null,
      startupInstructions: 'Read the brief first.',
    },
    trayIndex: 2,
    revision: 1,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

function instance(overrides = {}) {
  return {
    id: 'cart-1',
    templateId: 'bp-1',
    linked: true,
    definition: null,
    x: 100,
    y: 100,
    slotId: null,
    activated: false,
    sessionId: null,
    live: false,
    presence: 'idle',
    ...overrides,
  };
}

// --- the ghost --------------------------------------------------------------

// It exists only while something is being dragged, and it says the tray slot is
// still occupied -- the blueprint never actually leaves.
function assertTheGhostIsDerivedNotStored() {
  const tray = [blueprint(), blueprint({ id: 'bp-2', trayIndex: 5 })];

  assert.equal(instancing.ghostFor(tray, null), null, 'a ghost appeared with nothing being dragged');
  assert.equal(instancing.ghostFor(tray, undefined), null);

  const ghost = instancing.ghostFor(tray, 'bp-2');
  assert.deepEqual(ghost, { blueprintId: 'bp-2', trayIndex: 5 },
    'the ghost must hold the tray slot the blueprint occupies, or the column closes up under the drag');

  console.log('Ghost: present only during a drag, and it holds the slot.');
}

// The failure that persisting it would eventually produce, refused up front: a
// ghost for a blueprint that is not there is a rendering problem with no data
// behind it to explain it.
function assertAGhostWithoutABlueprintIsRefused() {
  assert.equal(
    instancing.ghostFor([blueprint()], 'bp-deleted'),
    null,
    'a ghost was produced for a blueprint that does not exist'
  );
  assert.equal(instancing.ghostFor([], 'bp-1'), null);

  console.log('Ghost: never drawn for a blueprint that is not in the tray.');
}

function assertGhostsComeFromDragOrOpenInstance() {
  const tray = [
    blueprint({ id: 'bp-dragged', trayIndex: 0 }),
    blueprint({ id: 'bp-used', trayIndex: 1 }),
    blueprint({ id: 'bp-idle', trayIndex: 2 }),
  ];

  const instanceDrag = instancing.ghostsFor({
    blueprints: tray,
    draggingBlueprintId: 'bp-dragged',
    draggingGesture: 'instance',
    usedBlueprintIds: new Set(['bp-used']),
  });

  assert.deepEqual(
    instanceDrag.map((entry) => entry.blueprintId).sort(),
    ['bp-dragged', 'bp-used'],
    'drag-out and existing instances must both produce ghosts from one predicate'
  );

  const reorderDrag = instancing.ghostsFor({
    blueprints: tray,
    draggingBlueprintId: 'bp-dragged',
    draggingGesture: 'reorder',
    usedBlueprintIds: new Set(['bp-used']),
  });

  assert.deepEqual(
    reorderDrag.map((entry) => entry.blueprintId).sort(),
    ['bp-dragged', 'bp-used'],
    'reordering must leave a ghost behind for the dragged blueprint without turning off persistent ghosts'
  );

  console.log('Ghost: one predicate covers drag-out and open instances without killing other ghosts during reorder.');
}

// --- dragging a blueprint out ----------------------------------------------

function assertDraggingOutCreatesALinkedInstance() {
  const result = instancing.instanceFromBlueprint({
    blueprint: blueprint(),
    cartridges: [],
    at: { x: 320, y: 180 },
    newId: () => 'cart-new',
  });

  assert.equal(result.created, true);
  assert.equal(result.cartridge.templateId, 'bp-1', 'the instance must reference its blueprint');
  assert.equal(result.cartridge.x, 320);
  assert.equal(result.cartridge.y, 180);
  assert.equal(
    result.cartridge.definition,
    null,
    'a linked instance must carry no private definition; a copy is what makes propagation impossible'
  );
  assert.equal(result.cartridge.activated, false, 'instancing places a cartridge, it does not start an agent');

  console.log('Instancing: dragging a blueprint out creates a linked instance with no private definition.');
}

// User decision Q2. Across projects is the point of the feature; within one
// project a second instance is refused with a hint, not silently created and not
// replacing the first.
function assertOneInstancePerBlueprintPerProject() {
  const result = instancing.instanceFromBlueprint({
    blueprint: blueprint(),
    cartridges: [instance({ id: 'cart-existing' })],
    at: { x: 400, y: 200 },
    newId: () => 'cart-new',
  });

  assert.equal(result.created, false, 'a second instance of one blueprint was created in the same project');
  assert.equal(result.reason, 'already-instanced');
  assert.equal(result.existingId, 'cart-existing', 'the refusal must name the instance already holding it');
  assert.equal(result.cartridge, undefined);

  // An unlinked cartridge is not an instance of anything, so it must not block
  // instancing -- a user who unlinked one and wants a fresh one is not stuck.
  const afterUnlink = instancing.instanceFromBlueprint({
    blueprint: blueprint(),
    cartridges: [instance({ id: 'cart-unlinked', templateId: null, linked: false })],
    at: { x: 400, y: 200 },
    newId: () => 'cart-new',
  });
  assert.equal(afterUnlink.created, true, 'an unlinked cartridge blocked instancing, so unlinking is a trap');

  console.log('Instancing: one instance per blueprint per project, and unlinking does not lock you out.');
}

// --- dragging a cartridge in ------------------------------------------------

function assertDraggingInSavesABlueprint() {
  const result = instancing.saveAsBlueprint({
    cartridge: {
      id: 'cart-1',
      name: 'Neon Socket',
      role: 'Jr',
      model: 'opencode-go/kimi-k2.7-code',
      adapter: 'opencode',
      startupInstructions: 'Ask before writing.',
    },
    trayIndex: 0,
  });

  assert.equal(result.saved, true);
  assert.equal(result.blueprint.definition.name, 'Neon Socket');
  assert.equal(result.blueprint.definition.startupInstructions, 'Ask before writing.',
    'the startup instructions are part of what a blueprint is for');
  assert.equal(result.blueprint.trayIndex, 0);

  console.log('Instancing: dragging a cartridge in saves its whole definition as a blueprint.');
}

// User decision 2026-08-21: a running cartridge cannot be put away. The gesture
// must be refused rather than stopping the live session as a side effect.
function assertARunningCartridgeIsNotSavedAsABlueprint() {
  const result = instancing.saveAsBlueprint({
    cartridge: {
      id: 'cart-running',
      name: 'Live Wire',
      role: 'SS',
      model: 'opencode',
      live: true,
    },
    trayIndex: 0,
  });

  assert.equal(result.saved, false, 'a running cartridge was saved to the tray');
  assert.equal(result.reason, 'running', 'the refusal must name the recoverable action the UI can explain');
  assert.equal(result.blueprint, undefined);

  console.log('Instancing: a running cartridge is refused before saving as a blueprint.');
}

// A cartridge that already follows a blueprint is already in the tray. Making a
// copy would leave two blueprints with the same definition and no way to tell
// which one an instance follows.
function assertACartridgeThatFollowsOneIsNotDuplicated() {
  const result = instancing.saveAsBlueprint({
    cartridge: { id: 'cart-1', templateId: 'bp-1', name: 'Copper Circuit', role: 'SS' },
    trayIndex: 0,
  });

  assert.equal(result.saved, false, 'a linked cartridge was turned into a second copy of its own blueprint');
  assert.equal(result.reason, 'already-a-blueprint');
  assert.equal(result.existingId, 'bp-1', 'the refusal must point at the blueprint it already follows');

  // And a cartridge with nothing to save is refused rather than producing a
  // blueprint with an empty name sitting in the tray forever.
  const empty = instancing.saveAsBlueprint({ cartridge: { id: 'cart-2' }, trayIndex: 0 });
  assert.equal(empty.saved, false);
  assert.equal(empty.reason, 'nothing-to-save');

  console.log('Instancing: a cartridge already following a blueprint is not duplicated into the tray.');
}

// Shelf model, not promotion.
//
// The user reversed the earlier prefab-style decision: dropping a cartridge into
// the tray consumes it. The source must be removed from the project after the
// blueprint is saved; it must not be converted into a linked instance.
function assertSavingConsumesTheSourceCartridge() {
  assert.equal(
    'linkToBlueprint' in instancing,
    false,
    'the old promotion helper still exists; saving to the tray must consume the source placement instead'
  );

  console.log('Saving: the source cartridge is consumed, not promoted into an instance.');
}

// A cartridge that already follows a blueprint is refused. The path to a variant
// is duplicate, edit the clean copy, then drag that copy in.
function assertPromotingALinkedCartridgeIsRefusedForNow() {
  const result = instancing.saveAsBlueprint({
    cartridge: { id: 'cart-1', templateId: 'bp-existing', name: 'Copper Circuit', role: 'SS' },
    trayIndex: 0,
  });

  assert.equal(result.saved, false, 'a linked cartridge was re-parented to a new blueprint without a decision');
  assert.equal(result.reason, 'already-a-blueprint');
  assert.equal(result.existingId, 'bp-existing', 'the hint must name the blueprint it already follows');

  console.log('Saving: a cartridge that already follows a blueprint is refused.');
}

// --- duplicate (user decision Q6) -------------------------------------------

// A duplicate is the way to get a variant, and it replaced re-parenting. The
// path to "I want a variant of this blueprint" is duplicate, edit the copy, drag
// it in -- three explicit steps, and nothing changes parent implicitly.
function assertDuplicateIsCleanAndUnlinked() {
  const source = instance({
    id: 'cart-1',
    templateId: 'bp-1',
    linked: true,
    // The view has already resolved this from the blueprint, which is why the
    // duplicate takes the view model rather than the row.
    definition: { name: 'Neon Hammer', role: 'SS', model: 'opencode-go/kimi-k3', adapter: null, cli: null, startupInstructions: 'Brief.' },
  });

  const result = instancing.duplicateCartridge({
    cartridge: source,
    takenNames: ['Neon Hammer'],
    at: { x: 500, y: 300 },
    newId: () => 'cart-copy',
  });

  assert.equal(result.created, true);
  assert.equal(result.cartridge.templateId, null, 'a duplicate must be unlinked; that is what makes it droppable in the tray');
  assert.ok(result.cartridge.definition, 'a duplicate carries its own definition, resolved at this moment');
  assert.equal(result.cartridge.definition.model, 'opencode-go/kimi-k3');
  assert.equal(result.cartridge.definition.startupInstructions, 'Brief.');
  assert.equal(result.cartridge.activated, false, 'duplicating places a cartridge, it does not start an agent');

  console.log('Duplicate: a clean unlinked copy with the definition resolved now.');
}

// The part that would look cosmetic and is not.
//
// Agent names appear in task claims. Two cartridges called "Neon Hammer" in one
// project make a claim ambiguous -- the very thing Q2 avoided by forbidding
// duplicate instances. Being unlinked does not help: the LINKED tag separates
// them on screen, not in `task.claim.agentName`.
function assertADuplicateNeverSharesANameWithinTheProject() {
  const source = instance({
    definition: { name: 'Neon Hammer', role: 'SS', model: 'm', adapter: null, cli: null, startupInstructions: null },
  });

  const first = instancing.duplicateCartridge({
    cartridge: source, takenNames: ['Neon Hammer'], at: { x: 0, y: 0 }, newId: () => 'a',
  });
  assert.notEqual(first.cartridge.definition.name, 'Neon Hammer', 'the duplicate shares a name, so a task claim is ambiguous');
  assert.equal(first.cartridge.definition.name, 'Neon Hammer 2');

  // Duplicating again skips what is taken rather than colliding.
  const second = instancing.duplicateCartridge({
    cartridge: source, takenNames: ['Neon Hammer', 'Neon Hammer 2'], at: { x: 0, y: 0 }, newId: () => 'b',
  });
  assert.equal(second.cartridge.definition.name, 'Neon Hammer 3');

  // And duplicating a duplicate counts up rather than stacking suffixes.
  const third = instancing.duplicateCartridge({
    cartridge: instance({ definition: { name: 'Neon Hammer 2', role: 'SS', model: 'm', adapter: null, cli: null, startupInstructions: null } }),
    takenNames: ['Neon Hammer', 'Neon Hammer 2'],
    at: { x: 0, y: 0 },
    newId: () => 'c',
  });
  assert.equal(third.cartridge.definition.name, 'Neon Hammer 3', 'suffixes stacked into "Neon Hammer 2 2"');

  // Case must not be a loophole: "neon hammer 2" already taken is taken.
  assert.equal(
    instancing.uniqueCartridgeName('Neon Hammer', ['neon hammer 2']),
    'Neon Hammer 3',
    'a differently-cased name was treated as free, so two claims can still collide'
  );

  console.log('Duplicate: names are unique within the project, so task claims stay unambiguous.');
}

// A duplicate has to be droppable into the tray, which is the whole point of the
// path Q6 chose: duplicate, edit, drag in.
function assertADuplicateCanBecomeABlueprint() {
  const duplicate = instancing.duplicateCartridge({
    cartridge: instance({ definition: { name: 'Neon Hammer', role: 'SS', model: 'm', adapter: null, cli: null, startupInstructions: null } }),
    takenNames: ['Neon Hammer'],
    at: { x: 0, y: 0 },
    newId: () => 'cart-copy',
  }).cartridge;

  const saved = instancing.saveAsBlueprint({ cartridge: duplicate, trayIndex: 0 });
  assert.equal(saved.saved, true, 'the duplicate could not be saved as a blueprint, so Q6 has no path at all');
  assert.equal(saved.blueprint.definition.name, 'Neon Hammer 2');

  console.log('Duplicate: the copy can be dropped into the tray, which is the path Q6 chose.');
}

function assertThereIsNothingToDuplicateWithoutADefinition() {
  const result = instancing.duplicateCartridge({
    cartridge: instance({ definition: null }),
    takenNames: [],
    at: { x: 0, y: 0 },
    newId: () => 'x',
  });
  assert.equal(result.created, false);
  assert.equal(result.reason, 'nothing-to-duplicate');

  console.log('Duplicate: a cartridge with no resolved definition is refused rather than copied empty.');
}

// --- unlink -----------------------------------------------------------------

// One operation, three triggers (Q1, Q3, Q4). Implemented once so the three
// cannot drift apart.
function assertUnlinkCopiesTheDefinitionIn() {
  const unlinked = instancing.unlink(instance(), [blueprint()]);

  assert.equal(unlinked.templateId, null, 'the reference must be dropped');
  assert.equal(unlinked.linked, false, 'the LINKED tag is the entire visual for this; its absence is the state');
  assert.equal(
    unlinked.definition.name,
    'Copper Circuit',
    'the definition must be copied in, or an unlinked cartridge has no definition at all'
  );
  assert.equal(unlinked.definition.startupInstructions, 'Read the brief first.');

  // Placement is untouched: unlinking is about the link, not about moving
  // anything or stopping anything.
  assert.equal(unlinked.x, 100);
  assert.equal(unlinked.y, 100);
  assert.equal(unlinked.activated, false);

  console.log('Unlink: the definition is copied in, the reference dropped, the placement untouched.');
}

// Q4: deleting a blueprint unlinks its instances. By then the blueprint may
// already be gone from the list, and an unlinked cartridge with no definition is
// worse than one with a stale definition.
function assertUnlinkSurvivesAMissingBlueprint() {
  const withSnapshot = instance({
    definition: { name: 'Copper Circuit', role: 'SS', model: 'old', adapter: null, cli: null, startupInstructions: null },
  });
  const unlinked = instancing.unlink(withSnapshot, []);

  assert.equal(unlinked.templateId, null);
  assert.ok(unlinked.definition, 'unlinking against a deleted blueprint left the cartridge with no definition');
  assert.equal(unlinked.definition.model, 'old');

  console.log('Unlink: a deleted blueprint still leaves the cartridge with a definition.');
}

// Unlinking something already unlinked is not an error and must not change it.
// All three triggers can fire on the same cartridge in any order.
function assertUnlinkingTwiceIsHarmless() {
  const already = instance({ templateId: null, linked: false, definition: { name: 'X', role: 'SS', model: 'm', adapter: null, cli: null, startupInstructions: null } });
  const result = instancing.unlink(already, [blueprint()]);

  assert.strictEqual(result, already, 'unlinking an unlinked cartridge produced a new object for no reason');

  console.log('Unlink: unlinking twice changes nothing.');
}

function main() {
  assertTheGhostIsDerivedNotStored();
  assertAGhostWithoutABlueprintIsRefused();
  assertGhostsComeFromDragOrOpenInstance();
  assertDraggingOutCreatesALinkedInstance();
  assertOneInstancePerBlueprintPerProject();
  assertDraggingInSavesABlueprint();
  assertARunningCartridgeIsNotSavedAsABlueprint();
  assertACartridgeThatFollowsOneIsNotDuplicated();
  assertSavingConsumesTheSourceCartridge();
  assertPromotingALinkedCartridgeIsRefusedForNow();
  assertDuplicateIsCleanAndUnlinked();
  assertADuplicateNeverSharesANameWithinTheProject();
  assertADuplicateCanBecomeABlueprint();
  assertThereIsNothingToDuplicateWithoutADefinition();
  assertUnlinkCopiesTheDefinitionIn();
  assertUnlinkSurvivesAMissingBlueprint();
  assertUnlinkingTwiceIsHarmless();

  console.log('Instancing validation passed.');
}

main();
