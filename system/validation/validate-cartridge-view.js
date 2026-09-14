'use strict';

// Cartridges reach the UI: the join, and the broadcast.
//
// Two things are being fixed at once, and they are different in kind.
//
// **Intent and observation must not share a field.** A cartridge row says the
// user switched it on. The registry says whether a session is actually alive.
// Letting either overwrite the other is finding 06 again -- the same shape as
// `desiredAutoMode` against `daemonStatus.running`, which is what made the Auto
// Mode switch turn itself off with nothing to explain why. If the row is reset
// to `activated: false` because the process died, the user sees a cartridge that
// is merely off and cannot tell whether they turned it off, never turned it on,
// or it fell over. Both values are kept and the disagreement is what gets
// rendered.
//
// **A ninth payload section is not automatically broadcast.** `splitPayload`
// names exactly eight sections and `broadcastChanges` diffs only those, so a
// section added to the payload alone arrives on the initial snapshot and then
// never updates. It would look like it worked. This was found by reading the
// hub before writing the code -- the fourth seam shape, caught in advance for
// once -- and this test is what keeps it caught.

const assert = require('assert');
const { buildCartridgeView } = require('../dashboard/cartridge-view');
const { DashboardWebSocketHub } = require('../dashboard/websocket-hub');

function cartridge(overrides = {}) {
  return {
    id: 'cart-1',
    templateId: null,
    definition: { name: 'Copper Circuit', role: 'SS', model: 'opencode-go/kimi-k3' },
    x: 320,
    y: 180,
    slotId: null,
    activated: false,
    sessionId: null,
    ...overrides,
  };
}

function agent(overrides = {}) {
  return {
    sessionId: 'copper-circuit-ss-1',
    agentName: 'Copper Circuit',
    role: 'Semi Senior',
    hasLiveTerminal: true,
    ...overrides,
  };
}

// The case this exists for. The user switched it on; the terminal is gone.
function assertIntentSurvivesADeadSession() {
  const [view] = buildCartridgeView(
    [cartridge({ activated: true, sessionId: 'copper-circuit-ss-1' })],
    [agent({ sessionId: 'copper-circuit-ss-1', hasLiveTerminal: false })]
  );

  assert.equal(view.activated, true,
    'the user intent was overwritten because the session died; that is finding 06 again');
  assert.equal(view.live, false, 'the observation must be reported as itself');
  assert.equal(view.presence, 'stopped',
    'intent without a live session is actionable -- "this was running and is not" -- not simply off');

  console.log('Cartridges: a dead session does not erase the fact that the user started it.');
}

function assertTheThreePresences() {
  const running = buildCartridgeView(
    [cartridge({ activated: true, sessionId: 'copper-circuit-ss-1' })],
    [agent()]
  )[0];
  assert.equal(running.presence, 'running');
  assert.equal(running.live, true);

  // Never switched on. Not the same as stopped, and must not read as a failure.
  const idle = buildCartridgeView([cartridge({ activated: false })], [])[0];
  assert.equal(idle.presence, 'idle');
  assert.equal(idle.live, false);
  assert.equal(idle.activated, false);

  // Switched on, but the registry has no such session at all -- the app was
  // killed before the agent ever announced itself.
  const orphaned = buildCartridgeView(
    [cartridge({ activated: true, sessionId: 'gone-forever' })],
    []
  )[0];
  assert.equal(orphaned.presence, 'stopped');

  console.log('Cartridges: running, stopped and idle are three distinct answers.');
}

// The LINKED tag is drawn from the link itself, and its absence is the whole
// visual for an unlinked cartridge (user decision Q3).
function assertLinkedIsDerivedFromTheLink() {
  const linked = buildCartridgeView([cartridge({ templateId: 'bp-1' })], [])[0];
  assert.equal(linked.linked, true);
  assert.equal(linked.templateId, 'bp-1');

  const unlinked = buildCartridgeView([cartridge({ templateId: null })], [])[0];
  assert.equal(unlinked.linked, false, 'an unlinked cartridge must not claim a blueprint');

  console.log('Cartridges: LINKED follows the blueprint reference, nothing else.');
}

// The definition of a linked cartridge lives on its blueprint, so the row
// carries none. The view must not invent one.
function assertALinkedCartridgeCarriesNoPrivateDefinition() {
  const [view] = buildCartridgeView([cartridge({ templateId: 'bp-1', definition: null })], []);
  assert.equal(view.definition, null,
    'a private copy of the definition is exactly what makes propagation impossible');
  console.log('Cartridges: a linked cartridge carries no private definition.');
}

// A linked instance keeps no definition of its own -- that is what makes
// propagation possible -- so something has to resolve it from the blueprint. If
// nothing does, every linked instance arrives with no name, role or model, and
// the board renders nothing at all. Found by instancing one and watching it not
// appear.
function assertALinkedInstanceGetsItsDefinitionFromItsBlueprint() {
  const blueprints = [{
    id: 'bp-1',
    definition: { name: 'Copper Circuit', role: 'SS', model: 'opencode-go/kimi-k3', adapter: null, cli: null, startupInstructions: 'Read the brief.' },
    trayIndex: 0,
    revision: 3,
  }];

  const [view] = buildCartridgeView([cartridge({ templateId: 'bp-1', definition: null })], [], blueprints);

  assert.ok(view.definition, 'a linked instance arrived with no definition, so it cannot be drawn');
  assert.equal(view.definition.name, 'Copper Circuit');
  assert.equal(view.definition.startupInstructions, 'Read the brief.');
  assert.equal(view.linked, true);
  assert.equal(view.blueprintRevision, 3,
    'the revision has to travel with it, or nothing can tell which version an instance is showing');

  console.log('Cartridges: a linked instance is drawn with the definition from its blueprint.');
}

// Propagation, which is the entire point of the link: edit the blueprint and
// every linked instance shows the new definition without being touched.
function assertEditingABlueprintReachesItsInstances() {
  const before = buildCartridgeView(
    [cartridge({ templateId: 'bp-1', definition: null })],
    [],
    [{ id: 'bp-1', definition: { name: 'Copper Circuit', role: 'SS', model: 'old' }, trayIndex: 0, revision: 1 }]
  )[0];
  const after = buildCartridgeView(
    [cartridge({ templateId: 'bp-1', definition: null })],
    [],
    [{ id: 'bp-1', definition: { name: 'Copper Circuit', role: 'SS', model: 'new' }, trayIndex: 0, revision: 2 }]
  )[0];

  assert.equal(before.definition.model, 'old');
  assert.equal(after.definition.model, 'new', 'editing the blueprint did not reach its instance');
  assert.equal(after.blueprintRevision, 2);

  console.log('Cartridges: editing a blueprint reaches its linked instances.');
}

// An unlinked cartridge carries its own definition and must not be overwritten
// by any blueprint -- that is what breaking the link bought the user.
function assertAnUnlinkedCartridgeKeepsItsOwnDefinition() {
  const own = { name: 'Copper Circuit', role: 'SS', model: 'the one it kept' };
  const [view] = buildCartridgeView(
    [cartridge({ templateId: null, definition: own })],
    [],
    [{ id: 'bp-1', definition: { name: 'Copper Circuit', role: 'SS', model: 'changed since' }, trayIndex: 0, revision: 9 }]
  );

  assert.equal(view.definition.model, 'the one it kept', 'an unlinked cartridge was overwritten by a blueprint');
  assert.equal(view.linked, false);
  assert.equal(view.blueprintRevision, null, 'an unlinked cartridge follows no revision');

  console.log('Cartridges: an unlinked cartridge keeps the definition it kept.');
}

// A blueprint deleted while an instance still points at it. Nothing renders from
// nothing, so the instance keeps whatever snapshot it has rather than becoming
// invisible.
function assertAMissingBlueprintDoesNotEraseTheInstance() {
  const [view] = buildCartridgeView(
    [cartridge({ templateId: 'bp-gone', definition: { name: 'Copper Circuit', role: 'SS', model: 'snapshot' } })],
    [],
    []
  );

  assert.ok(view.definition, 'an instance whose blueprint is gone became undrawable');
  assert.equal(view.definition.model, 'snapshot');

  console.log('Cartridges: an instance outlives a deleted blueprint rather than vanishing.');
}

// The hazard, as a test. If a future edit drops cartridges from splitPayload,
// the payload still contains them and everything looks fine until a second
// window fails to see a move.
function assertACartridgeChangeIsBroadcast() {
  let payload = { cartridges: [cartridge()] };
  const hub = new DashboardWebSocketHub({ buildPayload: async () => payload });

  const sent = [];
  hub.broadcast = (event) => sent.push(event);
  hub.wss = { clients: new Set([{}]) };

  return (async () => {
    await hub.broadcastChanges();
    assert.equal(sent[0] && sent[0].type, 'dashboard.snapshot', 'the first pass sends a snapshot');
    sent.length = 0;

    // Nothing changed: silence.
    await hub.broadcastChanges();
    assert.equal(sent.length, 0, 'an unchanged payload was broadcast anyway');

    // A cartridge moves.
    payload = { cartridges: [cartridge({ x: 900 })] };
    await hub.broadcastChanges();

    const event = sent.find((entry) => entry.type === 'cartridges.changed');
    assert.ok(event, 'moving a cartridge broadcast nothing; splitPayload does not know about them');
    assert.equal(event.payload[0].x, 900);

    console.log('Cartridges: a change reaches other windows instead of waiting for a reconnect.');
  })();
}

async function main() {
  assertIntentSurvivesADeadSession();
  assertTheThreePresences();
  assertLinkedIsDerivedFromTheLink();
  assertALinkedInstanceGetsItsDefinitionFromItsBlueprint();
  assertEditingABlueprintReachesItsInstances();
  assertAnUnlinkedCartridgeKeepsItsOwnDefinition();
  assertAMissingBlueprintDoesNotEraseTheInstance();
  assertALinkedCartridgeCarriesNoPrivateDefinition();
  await assertACartridgeChangeIsBroadcast();

  console.log('Cartridge view validation passed.');
}

main().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
