'use strict';

// Finding a blueprint's instances in projects that are not open.
//
// Three things in the tray need this and it is written once: the prompt that
// names the running instances a blueprint edit would affect, the prompt that
// offers to break a link, and deleting a blueprint. All three are meaningless if
// they can only see the project currently on screen -- a blueprint is app level
// by definition, so its instances are wherever the user put them.
//
// Two properties matter more than the query itself.
//
// **Reading must not take another project's file lock.** These reads happen
// while a prompt is being drawn, across every known project. Taking N locks to
// answer a question would put a dialog on the same contention path as the daemon.
//
// **An unreachable project is reported, never skipped.** A moved directory or a
// held lock has to surface as "this project blocked it", because the delete rule
// depends on it: if any project cannot be reached, the delete is refused rather
// than half-done.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runtimeStore = require('../runtime/runtime-store');
const reach = require('../core/blueprint-instances');
const blueprintStore = require('../core/blueprint-store');

function makeProject(name) {
  const projectRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tao-reach-')), name);
  fs.mkdirSync(projectRoot, { recursive: true });
  runtimeStore.ensureInitialized({ projectRoot });
  return projectRoot;
}

function placeInstance(projectRoot, blueprintId, overrides = {}) {
  runtimeStore.saveProjectCartridge({ projectRoot }, {
    id: overrides.id || `cart-${Math.random().toString(36).slice(2, 8)}`,
    templateId: blueprintId,
    definition: null,
    x: 100,
    y: 100,
    slotId: null,
    activated: false,
    sessionId: null,
    ...overrides,
  });
}

// A live agent means a registered session whose terminal process is alive. This
// process stands in for one, the same way the scenario suites do it.
function registerLiveAgent(projectRoot, { sessionId, agentName, alive = true }) {
  runtimeStore.mutateCoordination({ projectRoot }, (state) => {
    state.registry.agents = [
      ...(state.registry.agents || []),
      {
        sessionId,
        agentName,
        role: 'Semi Senior',
        adapterType: 'opencode',
        status: 'available',
        activeTaskId: null,
        // A pid that cannot exist stands in for a dead terminal.
        terminalPid: alive ? process.pid : 9999999,
      },
    ];
  });
}

function breakProject(projectRoot) {
  // Present and unreadable: a file where the database should be. A lock held by
  // another build, a corrupt file or a newer schema all land the same way, and
  // this is the case Rule 2 is for.
  const paths = runtimeStore.resolvePaths({ projectRoot });
  fs.writeFileSync(paths.dbPath, 'this is not a sqlite database', 'utf8');
  return projectRoot;
}

function cleanup(roots) {
  for (const root of roots) {
    try {
      fs.rmSync(path.dirname(root), { recursive: true, force: true });
    } catch (_) {
      // Windows can still hold a handle on a database that was opened and found
      // to be invalid. Leaving a temp directory behind is not worth failing a
      // test over, and it must not mask the assertion that already passed.
    }
  }
}

// --- the query --------------------------------------------------------------

function assertItFindsInstancesInProjectsThatAreNotOpen() {
  const a = makeProject('ProjectA');
  const b = makeProject('ProjectB');
  const c = makeProject('ProjectC');
  try {
    placeInstance(a, 'bp-1', { id: 'cart-a' });
    placeInstance(b, 'bp-1', { id: 'cart-b' });
    placeInstance(c, 'bp-other', { id: 'cart-c' });

    const result = reach.findBlueprintInstances('bp-1', { projectRoots: [a, b, c] });

    assert.equal(result.instances.length, 2, 'the query did not find instances across projects');
    const found = result.instances.map((entry) => entry.cartridgeId).sort();
    assert.deepEqual(found, ['cart-a', 'cart-b']);
    assert.deepEqual(result.unreachable, []);

    // The prompt has to name them by project, not just count them: "2 instances"
    // is not enough to decide with.
    const names = result.instances.map((entry) => entry.projectName).sort();
    assert.deepEqual(names, ['ProjectA', 'ProjectB'], 'an instance came back without a project to name it by');

    console.log('Reach: instances are found in projects that are not open, named by project.');
  } finally {
    cleanup([a, b, c]);
  }
}

// The prompt only asks about RUNNING instances. Idle linked ones update quietly,
// since there is nothing to stop and no conflict to resolve (Q1).
function assertItSeparatesRunningFromIdle() {
  const a = makeProject('ProjectA');
  const b = makeProject('ProjectB');
  try {
    placeInstance(a, 'bp-1', { id: 'cart-running', sessionId: 'ses-a', activated: true });
    registerLiveAgent(a, { sessionId: 'ses-a', agentName: 'Neon Hammer', alive: true });

    placeInstance(b, 'bp-1', { id: 'cart-idle' });

    const result = reach.findBlueprintInstances('bp-1', { projectRoots: [a, b] });
    const running = result.instances.filter((entry) => entry.running);
    const idle = result.instances.filter((entry) => !entry.running);

    assert.equal(running.length, 1, 'the running instance was not recognised');
    assert.equal(running[0].cartridgeId, 'cart-running');
    assert.equal(running[0].agentName, 'Neon Hammer', 'a running instance must be nameable in the prompt');
    assert.equal(idle.length, 1);
    assert.equal(idle[0].cartridgeId, 'cart-idle');

    console.log('Reach: running and idle instances are separated, and running ones carry a name.');
  } finally {
    cleanup([a, b]);
  }
}

// A cartridge marked activated whose terminal is gone is not running. Intent and
// observation again: the row says the user started it, the process says it is
// not there, and the prompt must ask about what is actually running.
function assertADeadTerminalIsNotRunning() {
  const a = makeProject('ProjectA');
  try {
    placeInstance(a, 'bp-1', { id: 'cart-dead', sessionId: 'ses-dead', activated: true });
    registerLiveAgent(a, { sessionId: 'ses-dead', agentName: 'Gone Away', alive: false });

    const result = reach.findBlueprintInstances('bp-1', { projectRoots: [a] });
    assert.equal(result.instances.length, 1);
    assert.equal(
      result.instances[0].running,
      false,
      'a cartridge whose terminal is dead was reported as running, so the prompt would offer to stop nothing'
    );

    console.log('Reach: a dead terminal is not a running instance.');
  } finally {
    cleanup([a]);
  }
}

// --- reachability -----------------------------------------------------------

function assertAnUnreachableProjectIsReportedNotSkipped() {
  const a = makeProject('ProjectA');
  // Unique per run. An earlier version of this test used a fixed path, and the
  // bug it was catching -- a read that CREATES the project it was asked about --
  // left a database there. The next run then found it and reported the project
  // reachable, so the test passed for the wrong reason on the second attempt.
  const gone = path.join(os.tmpdir(), `tao-reach-gone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, 'Ghost');
  try {
    placeInstance(a, 'bp-1', { id: 'cart-a' });

    const result = reach.findBlueprintInstances('bp-1', { projectRoots: [a, gone] });

    assert.equal(result.instances.length, 1, 'the reachable project was not read');
    assert.equal(result.gone.length, 1, 'a project that no longer exists was not reported at all');
    assert.equal(result.gone[0].projectRoot, gone);
    assert.deepEqual(
      result.unreachable,
      [],
      'a project that no longer exists was treated as unreachable, which would block every delete and edit forever'
    );

    // And asking about it must not have brought it into existence, which is what
    // the read did before the guard: openDatabase creates the coordination
    // directory on the way in, so the query answered "reachable, no instances"
    // for a project that had been moved or deleted -- indistinguishable from a
    // project that is simply empty, and that is the distinction the delete rule
    // turns on.
    assert.equal(
      fs.existsSync(path.join(gone, '.tiny-agent-office')),
      false,
      'asking about a missing project created it'
    );

    console.log('Reach: a project that no longer exists is reported as gone, and asking does not create it.');
  } finally {
    cleanup([a]);
  }
}

// The read runs while a prompt is being drawn, across every known project.
// Taking a lock per project would put a dialog on the same contention path as
// the daemon -- the one this refactor spent a slice clearing.
function assertReadingTakesNoLocks() {
  const a = makeProject('ProjectA');
  try {
    placeInstance(a, 'bp-1', { id: 'cart-a' });
    const lockPath = `${runtimeStore.resolvePaths({ projectRoot: a }).dbPath}.lock`;

    // Hold the lock the way another process would, then read anyway.
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid }), 'utf8');

    const started = Date.now();
    const result = reach.findBlueprintInstances('bp-1', { projectRoots: [a] });
    const elapsed = Date.now() - started;

    assert.equal(result.instances.length, 1, 'a held lock stopped the read, so the query waits on other windows');
    assert.ok(elapsed < 2000, `the read waited ${elapsed}ms, which means it is queueing behind the lock`);

    fs.rmSync(lockPath, { recursive: true, force: true });
    console.log(`Reach: the read ignores a held lock and answered in ${elapsed}ms.`);
  } finally {
    cleanup([a]);
  }
}

// --- deleting a blueprint ---------------------------------------------------

// Q4: deleting a blueprint leaves its instances alive and unlinked. Nothing
// stops, nothing is lost.
//
// There is no transaction across projects: this mutates N SQLite databases with
// N locks, so one day it fails halfway. The question is not whether, it is what
// state it leaves behind.
function assertDeletingUnlinksEverywhereThenRemoves() {
  const a = makeProject('ProjectA');
  const b = makeProject('ProjectB');
  try {
    const { blueprint } = blueprintStore.saveBlueprint({ storeRoot: a }, {
      definition: { name: 'Neon Hammer', role: 'SS', model: 'opencode-go/kimi-k3', startupInstructions: 'Brief.' },
      trayIndex: 0,
    });
    placeInstance(a, blueprint.id, { id: 'cart-a' });
    placeInstance(b, blueprint.id, { id: 'cart-b' });

    const result = reach.deleteBlueprintEverywhere(blueprint.id, {
      projectRoots: [a, b],
      storeOptions: { storeRoot: a },
    });

    assert.equal(result.deleted, true, `the delete was refused: ${result.reason}`);
    assert.equal(result.unlinked, 2, 'not every instance was unlinked');

    for (const [root, id] of [[a, 'cart-a'], [b, 'cart-b']]) {
      const [row] = runtimeStore.readProjectCartridges({ projectRoot: root }).filter((c) => c.id === id);
      assert.ok(row, `${id} disappeared instead of surviving the delete`);
      assert.equal(row.templateId, null, `${id} still points at a blueprint that no longer exists`);
      assert.ok(row.definition, `${id} kept no definition, so it cannot be drawn -- the delete erased it in practice`);
      assert.equal(row.definition.name, 'Neon Hammer');
      assert.equal(row.definition.startupInstructions, 'Brief.', 'the snapshot dropped part of the definition');
    }

    assert.equal(
      blueprintStore.readBlueprints({ storeRoot: a }).length,
      0,
      'the blueprint survived a delete that reported success'
    );

    console.log('Delete: every instance is unlinked with its definition, then the blueprint goes.');
  } finally {
    cleanup([a, b]);
  }
}

// Rule 2. If any project cannot be reached, the delete does not happen at all,
// and the message names which one.
//
// "I deleted the blueprint and two projects were left with undrawable ghosts" is
// unrecoverable data loss. Refusing is ugly and recoverable; partial is tidy and
// is not.
function assertAnUnreachableProjectRefusesTheWholeDelete() {
  const a = makeProject('ProjectA');
  // Present and unreadable, not missing. A missing project cannot be holding an
  // instance and must not block -- see the note on the gone/unreachable split.
  const blocked = breakProject(makeProject('BlockedProject'));
  try {
    const { blueprint } = blueprintStore.saveBlueprint({ storeRoot: a }, {
      definition: { name: 'Neon Hammer', role: 'SS', model: 'm' },
      trayIndex: 0,
    });
    placeInstance(a, blueprint.id, { id: 'cart-a' });

    const result = reach.deleteBlueprintEverywhere(blueprint.id, {
      projectRoots: [a, blocked],
      storeOptions: { storeRoot: a },
    });

    assert.equal(result.deleted, false, 'the delete went ahead with a project it could not reach');
    assert.equal(result.reason, 'unreachable-project');
    assert.ok(result.unreachable.length >= 1, 'the refusal must say which project blocked it');
    assert.ok(
      String(result.unreachable[0].projectName || '').length > 0,
      'the blocked project has to be nameable, or the user cannot act on the refusal'
    );

    // Nothing moved: the blueprint is there and the instance still follows it.
    assert.equal(blueprintStore.readBlueprints({ storeRoot: a }).length, 1, 'the blueprint was deleted anyway');
    const [row] = runtimeStore.readProjectCartridges({ projectRoot: a });
    assert.equal(row.templateId, blueprint.id, 'a refused delete still unlinked an instance');

    console.log('Delete: one unreachable project refuses the whole delete, and names it.');
  } finally {
    cleanup([a, blocked]);
  }
}

// Rule 1, as the property that matters: the blueprint is the only thing that
// makes recovery possible, so it goes last. If unlinking fails partway, the
// blueprint is still there and no instance is orphaned -- retry and it is fine.
// The other order leaves instances pointing at something that no longer exists,
// and those cannot be recovered.
function assertAFailureDuringUnlinkingLeavesTheBlueprintIntact() {
  const a = makeProject('ProjectA');
  const b = makeProject('ProjectB');
  try {
    const { blueprint } = blueprintStore.saveBlueprint({ storeRoot: a }, {
      definition: { name: 'Neon Hammer', role: 'SS', model: 'm' },
      trayIndex: 0,
    });
    placeInstance(a, blueprint.id, { id: 'cart-a' });
    placeInstance(b, blueprint.id, { id: 'cart-b' });

    // The second project fails while being written.
    const realSave = runtimeStore.saveProjectCartridge;
    let calls = 0;
    runtimeStore.saveProjectCartridge = (options, cartridge) => {
      calls += 1;
      if (calls === 2) throw new Error('disk went away');
      return realSave(options, cartridge);
    };

    let result;
    try {
      result = reach.deleteBlueprintEverywhere(blueprint.id, {
        projectRoots: [a, b],
        storeOptions: { storeRoot: a },
      });
    } finally {
      runtimeStore.saveProjectCartridge = realSave;
    }

    assert.equal(result.deleted, false, 'the blueprint was deleted even though unlinking failed partway');
    assert.equal(result.reason, 'unlink-failed');

    assert.equal(
      blueprintStore.readBlueprints({ storeRoot: a }).length,
      1,
      'the blueprint went first, so any instance not yet unlinked is now unrecoverable'
    );

    // Whatever was unlinked before the failure is fine -- it kept its
    // definition, so a retry finishes the job rather than repairing damage.
    for (const [root, id] of [[a, 'cart-a'], [b, 'cart-b']]) {
      const [row] = runtimeStore.readProjectCartridges({ projectRoot: root }).filter((c) => c.id === id);
      assert.ok(
        row.templateId === blueprint.id || row.definition,
        `${id} is orphaned: it follows nothing and has no definition`
      );
    }

    console.log('Delete: a failure partway leaves the blueprint intact and nothing orphaned.');
  } finally {
    cleanup([a, b]);
  }
}

// --- editing a blueprint that has running instances -------------------------

// The same ordering question as the delete, and the same answer: the edit is the
// irreversible commit, so everything that happens to the instances happens
// first.
//
// Apply the edit and then fail to stop a session, and there is an agent running
// whose definition changed underneath it -- precisely what the plan says must
// never happen, and the class of confusion that cost days here. The other way
// round has no bad state: if anything fails before the edit, the blueprint is
// exactly as it was and no instance is halfway.
function assertStopThemStopsEverythingBeforeEditing() {
  const a = makeProject('ProjectA');
  const b = makeProject('ProjectB');
  try {
    const { blueprint } = blueprintStore.saveBlueprint({ storeRoot: a }, {
      definition: { name: 'Neon Hammer', role: 'SS', model: 'old' },
      trayIndex: 0,
    });
    placeInstance(a, blueprint.id, { id: 'cart-a', sessionId: 'ses-a', activated: true });
    registerLiveAgent(a, { sessionId: 'ses-a', agentName: 'Neon Hammer', alive: true });
    placeInstance(b, blueprint.id, { id: 'cart-b', sessionId: 'ses-b', activated: true });
    registerLiveAgent(b, { sessionId: 'ses-b', agentName: 'Neon Hammer', alive: true });

    const stopped = [];
    const result = reach.applyBlueprintEdit(blueprint.id, {
      definition: { name: 'Neon Hammer', role: 'SS', model: 'new' },
      trayIndex: 0,
      choice: 'stop',
      projectRoots: [a, b],
      storeOptions: { storeRoot: a },
      stopSession: (instance) => { stopped.push(instance.cartridgeId); return true; },
    });

    assert.equal(result.applied, true, `the edit was refused: ${result.reason}`);
    assert.equal(stopped.length, 2, 'not every running session was stopped');
    assert.deepEqual(stopped.sort(), ['cart-a', 'cart-b']);

    // The edit landed, and the instances still follow the blueprint: stopping
    // keeps the link and picks up the new version on next activation.
    assert.equal(blueprintStore.readBlueprints({ storeRoot: a })[0].definition.model, 'new');
    for (const [root, id] of [[a, 'cart-a'], [b, 'cart-b']]) {
      const [row] = runtimeStore.readProjectCartridges({ projectRoot: root }).filter((c) => c.id === id);
      assert.equal(row.templateId, blueprint.id, `${id} was unlinked by the stop button, which is the other one`);
      assert.equal(row.activated, false, `${id} is still marked as running after being stopped`);
    }

    console.log('Edit: stopping ends every session, then the edit is applied.');
  } finally {
    cleanup([a, b]);
  }
}

function assertUnlinkThemUnlinksEverythingBeforeEditing() {
  const a = makeProject('ProjectA');
  try {
    const { blueprint } = blueprintStore.saveBlueprint({ storeRoot: a }, {
      definition: { name: 'Neon Hammer', role: 'SS', model: 'old', startupInstructions: 'Old brief.' },
      trayIndex: 0,
    });
    placeInstance(a, blueprint.id, { id: 'cart-a', sessionId: 'ses-a', activated: true });
    registerLiveAgent(a, { sessionId: 'ses-a', agentName: 'Neon Hammer', alive: true });

    const result = reach.applyBlueprintEdit(blueprint.id, {
      definition: { name: 'Neon Hammer', role: 'SS', model: 'new', startupInstructions: 'New brief.' },
      trayIndex: 0,
      choice: 'unlink',
      projectRoots: [a],
      storeOptions: { storeRoot: a },
      stopSession: () => { throw new Error('unlinking must not stop anything'); },
    });

    assert.equal(result.applied, true, `the edit was refused: ${result.reason}`);

    // They keep running, on the definition they started under.
    const [row] = runtimeStore.readProjectCartridges({ projectRoot: a });
    assert.equal(row.templateId, null, 'the running instance still follows the blueprint after unlinking');
    assert.equal(row.activated, true, 'unlinking stopped a session; they are supposed to keep going');
    assert.equal(row.definition.model, 'old', 'the running instance was handed the new definition underneath it');
    assert.equal(row.definition.startupInstructions, 'Old brief.');

    assert.equal(blueprintStore.readBlueprints({ storeRoot: a })[0].definition.model, 'new');

    console.log('Edit: unlinking releases every running instance, then the edit is applied.');
  } finally {
    cleanup([a]);
  }
}

// Rule 2, extended to the edit. A session that cannot be stopped means the edit
// does not happen -- never "the blueprint changed but two are still running on
// the old version".
function assertASessionThatWillNotStopRefusesTheEdit() {
  const a = makeProject('ProjectA');
  try {
    const { blueprint } = blueprintStore.saveBlueprint({ storeRoot: a }, {
      definition: { name: 'Neon Hammer', role: 'SS', model: 'old' },
      trayIndex: 0,
    });
    placeInstance(a, blueprint.id, { id: 'cart-a', sessionId: 'ses-a', activated: true });
    registerLiveAgent(a, { sessionId: 'ses-a', agentName: 'Neon Hammer', alive: true });

    const result = reach.applyBlueprintEdit(blueprint.id, {
      definition: { name: 'Neon Hammer', role: 'SS', model: 'new' },
      trayIndex: 0,
      choice: 'stop',
      projectRoots: [a],
      storeOptions: { storeRoot: a },
      stopSession: () => false,
    });

    assert.equal(result.applied, false, 'the edit went ahead with a session it could not stop');
    assert.equal(result.reason, 'stop-failed');
    assert.ok(result.blockedBy, 'the refusal must name what blocked it');
    assert.equal(result.blockedBy.agentName, 'Neon Hammer');
    assert.equal(result.blockedBy.projectName, 'ProjectA');

    assert.equal(
      blueprintStore.readBlueprints({ storeRoot: a })[0].definition.model,
      'old',
      'the blueprint was edited even though a session could not be stopped'
    );

    console.log('Edit: a session that will not stop refuses the edit, and names itself.');
  } finally {
    cleanup([a]);
  }
}

function assertAnUnreachableProjectRefusesTheEdit() {
  const a = makeProject('ProjectA');
  const blocked = breakProject(makeProject('BlockedProject'));
  try {
    const { blueprint } = blueprintStore.saveBlueprint({ storeRoot: a }, {
      definition: { name: 'Neon Hammer', role: 'SS', model: 'old' },
      trayIndex: 0,
    });
    placeInstance(a, blueprint.id, { id: 'cart-a' });

    const result = reach.applyBlueprintEdit(blueprint.id, {
      definition: { name: 'Neon Hammer', role: 'SS', model: 'new' },
      trayIndex: 0,
      choice: 'stop',
      projectRoots: [a, blocked],
      storeOptions: { storeRoot: a },
      stopSession: () => true,
    });

    assert.equal(result.applied, false, 'the edit went ahead with a project it could not reach');
    assert.equal(result.reason, 'unreachable-project');
    assert.equal(
      blueprintStore.readBlueprints({ storeRoot: a })[0].definition.model,
      'old',
      'the blueprint was edited despite an unreachable project'
    );

    console.log('Edit: an unreachable project refuses the edit too.');
  } finally {
    cleanup([a, blocked]);
  }
}

// Idle linked instances are not part of any prompt (Q1): there is nothing to
// stop and no conflict to resolve, so they update quietly. An edit with nothing
// running must not ask anything at all.
function assertIdleInstancesNeedNoPrompt() {
  const a = makeProject('ProjectA');
  try {
    const { blueprint } = blueprintStore.saveBlueprint({ storeRoot: a }, {
      definition: { name: 'Neon Hammer', role: 'SS', model: 'old' },
      trayIndex: 0,
    });
    placeInstance(a, blueprint.id, { id: 'cart-idle' });

    const found = reach.findBlueprintInstances(blueprint.id, { projectRoots: [a] });
    assert.equal(found.instances.filter((entry) => entry.running).length, 0);

    // No choice given, because nothing is running to ask about.
    const result = reach.applyBlueprintEdit(blueprint.id, {
      definition: { name: 'Neon Hammer', role: 'SS', model: 'new' },
      trayIndex: 0,
      projectRoots: [a],
      storeOptions: { storeRoot: a },
    });

    assert.equal(result.applied, true, 'an edit with only idle instances was refused for wanting a choice');
    assert.equal(result.running, 0, 'idle instances were counted as running, which would raise a prompt for nothing');

    const [row] = runtimeStore.readProjectCartridges({ projectRoot: a });
    assert.equal(row.templateId, blueprint.id, 'an idle instance was unlinked without being asked about');

    console.log('Edit: with nothing running, the edit just happens -- no prompt, no unlinking.');
  } finally {
    cleanup([a]);
  }
}

// The other half of that distinction, and the one that must block.
//
// A database that exists and cannot be read is not a project that went away:
// something is there, it may hold instances, and the cause is usually transient.
// Refusing is right here, and only here.
function assertAPresentButUnreadableProjectBlocks() {
  const a = makeProject('ProjectA');
  const broken = makeProject('BrokenProject');
  try {
    placeInstance(a, 'bp-1', { id: 'cart-a' });

    // A file that is there and is not a database. A lock held by another build
    // or a newer schema would land the same way.
    const paths = runtimeStore.resolvePaths({ projectRoot: broken });
    fs.writeFileSync(paths.dbPath, 'this is not a sqlite database', 'utf8');

    const result = reach.findBlueprintInstances('bp-1', { projectRoots: [a, broken] });

    assert.equal(result.unreachable.length, 1, 'a project whose database cannot be read did not block');
    assert.equal(result.unreachable[0].projectName, 'BrokenProject');
    assert.ok(result.unreachable[0].reason, 'the block must come with a reason to show the user');
    assert.deepEqual(result.gone, [], 'a project that is present was written off as gone');

    console.log('Reach: a project that is present and unreadable blocks, and says why.');
  } finally {
    cleanup([a, broken]);
  }
}

// The reason the distinction exists at all: a recent-projects list fills up with
// deleted projects in ordinary use, and treating those as blockers would refuse
// every delete for a list nobody prunes.
function assertDeletedProjectsDoNotBlockADelete() {
  const a = makeProject('ProjectA');
  const gone = path.join(os.tmpdir(), `tao-gone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, 'Ghost');
  try {
    const { blueprint } = blueprintStore.saveBlueprint({ storeRoot: a }, {
      definition: { name: 'Neon Hammer', role: 'SS', model: 'm' },
      trayIndex: 0,
    });
    placeInstance(a, blueprint.id, { id: 'cart-a' });

    const result = reach.deleteBlueprintEverywhere(blueprint.id, {
      projectRoots: [a, gone],
      storeOptions: { storeRoot: a },
    });

    assert.equal(
      result.deleted,
      true,
      `a project that no longer exists blocked the delete: ${result.reason}. A stale recent-projects entry would make the tray permanently unusable.`
    );
    assert.equal(blueprintStore.readBlueprints({ storeRoot: a }).length, 0);

    console.log('Reach: a deleted project does not block a delete; only a present unreadable one does.');
  } finally {
    cleanup([a]);
  }
}

function main() {
  assertItFindsInstancesInProjectsThatAreNotOpen();
  assertItSeparatesRunningFromIdle();
  assertADeadTerminalIsNotRunning();
  assertAnUnreachableProjectIsReportedNotSkipped();
  assertAPresentButUnreadableProjectBlocks();
  assertDeletedProjectsDoNotBlockADelete();
  assertReadingTakesNoLocks();
  assertDeletingUnlinksEverywhereThenRemoves();
  assertAnUnreachableProjectRefusesTheWholeDelete();
  assertAFailureDuringUnlinkingLeavesTheBlueprintIntact();
  assertStopThemStopsEverythingBeforeEditing();
  assertUnlinkThemUnlinksEverythingBeforeEditing();
  assertASessionThatWillNotStopRefusesTheEdit();
  assertAnUnreachableProjectRefusesTheEdit();
  assertIdleInstancesNeedNoPrompt();

  console.log('Blueprint reach validation passed.');
}

main();
