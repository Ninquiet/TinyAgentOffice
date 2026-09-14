'use strict';

// The drag that must not jump.
//
// This is the first client-side logic in the project with tests on it. App.tsx is
// 1400 lines of React state with nothing but a type check over it, and this slice
// moves cartridge placement out from under all of it -- so the piece that can be
// made pure is made pure and tested here, and only the wiring is left to be
// checked by hand.
//
// Node 24 runs the TypeScript directly, so this is the real module the app
// imports, not a copy that can drift away from it.

const assert = require('assert');
const {
  mergeCartridges,
  planPlacementCommits,
  classifyCommitFailure,
  retryDelayMs,
  createMergeRecorder,
  DEFAULT_PENDING_TIMEOUT_MS,
} = require('../../app/src/cartridges/mergeCartridges.ts');

function cartridge(id, x, y, extra = {}) {
  return { id, x, y, slotId: null, ...extra };
}

// The ordinary case, and the reason placement is broadcast at all: another
// window moved something and this one follows.
function assertIncomingWinsWhenNothingIsHappening() {
  const result = mergeCartridges({
    incoming: [cartridge('a', 900, 40)],
    local: [cartridge('a', 100, 100)],
  });

  assert.equal(result.cartridges[0].x, 900, 'a second window moved it and this one ignored the move');
  assert.equal(result.counters.incoming, 1);
  assert.equal(result.counters.localDrag, 0);

  console.log('Merge: with no gesture in flight the server wins, so windows stay in step.');
}

// The symptom this exists to prevent: the payload was built before the drag
// started, so applying it puts the cartridge back where it was.
function assertADragIsNotOverwritten() {
  const result = mergeCartridges({
    incoming: [cartridge('a', 100, 100)],
    local: [cartridge('a', 640, 300)],
    draggingId: 'a',
  });

  assert.equal(result.cartridges[0].x, 640, 'the incoming payload yanked the cartridge out from under the cursor');
  assert.equal(result.cartridges[0].y, 300);
  assert.equal(result.counters.localDrag, 1);

  console.log('Merge: an incoming update does not move a cartridge being dragged.');
}

// Only placement is held. Freezing the whole record would stop a terminal going
// live, or an agent's status changing, for as long as someone holds the mouse.
function assertADragOnlyHoldsPlacement() {
  const result = mergeCartridges({
    incoming: [cartridge('a', 100, 100, { presence: 'running', live: true })],
    local: [cartridge('a', 640, 300, { presence: 'idle', live: false })],
    draggingId: 'a',
  });

  assert.equal(result.cartridges[0].x, 640, 'placement should still be local');
  assert.equal(result.cartridges[0].presence, 'running',
    'the whole record was frozen for the duration of a drag, not just its position');
  assert.equal(result.cartridges[0].live, true);

  console.log('Merge: a drag holds the position, not the rest of the cartridge.');
}

// A drag on one cartridge must not freeze the others.
function assertOtherCartridgesKeepUpdatingDuringADrag() {
  const result = mergeCartridges({
    incoming: [cartridge('a', 100, 100), cartridge('b', 800, 500)],
    local: [cartridge('a', 640, 300), cartridge('b', 10, 10)],
    draggingId: 'a',
  });

  const b = result.cartridges.find((entry) => entry.id === 'b');
  assert.equal(b.x, 800, 'dragging one cartridge froze another');
  assert.equal(result.counters.localDrag, 1);
  assert.equal(result.counters.incoming, 1);

  console.log('Merge: dragging one cartridge does not freeze the rest.');
}

// The second jump, one moment later: the drop commits, but the payload already
// in flight still carries the old position.
function assertTheDropIsHeldUntilTheServerCatchesUp() {
  const at = 1000;
  const pending = { a: { x: 640, y: 300, slotId: null, at } };

  const stale = mergeCartridges({
    incoming: [cartridge('a', 100, 100)],
    local: [cartridge('a', 640, 300)],
    pending,
    now: at + 100,
  });
  assert.equal(stale.cartridges[0].x, 640, 'the cartridge snapped back to the old position after the drop');
  assert.equal(stale.counters.localPending, 1);
  assert.ok(stale.pending.a, 'the write is still outstanding and must stay tracked');

  // The server echoes the committed position: the hold is released.
  const caughtUp = mergeCartridges({
    incoming: [cartridge('a', 640, 300)],
    local: [cartridge('a', 640, 300)],
    pending,
    now: at + 200,
  });
  assert.equal(caughtUp.counters.incoming, 1);
  assert.deepEqual(caughtUp.pending, {}, 'the hold outlived the write it was protecting');

  console.log('Merge: a committed drop is held only until the server echoes it.');
}

// A write that never lands must not pin the local value forever. Believing the
// server again is the safe direction: it is the store of record.
function assertALostWriteStopsHoldingAfterATimeout() {
  const at = 1000;
  const result = mergeCartridges({
    incoming: [cartridge('a', 100, 100)],
    local: [cartridge('a', 640, 300)],
    pending: { a: { x: 640, y: 300, slotId: null, at } },
    now: at + DEFAULT_PENDING_TIMEOUT_MS + 1,
  });

  assert.equal(result.cartridges[0].x, 100, 'a lost write pinned the local position permanently');
  assert.deepEqual(result.pending, {}, 'the expired hold was not released');

  console.log('Merge: a write that never lands stops holding the position.');
}

// A cartridge just created locally is not in the payload yet. Dropping it would
// make it flicker out and back on the first update after it was placed.
function assertANewCartridgeSurvivesUntilTheServerKnowsIt() {
  const at = 1000;
  const result = mergeCartridges({
    incoming: [],
    local: [cartridge('new-1', 320, 180)],
    pending: { 'new-1': { x: 320, y: 180, slotId: null, at } },
    now: at + 50,
  });

  assert.equal(result.cartridges.length, 1, 'a cartridge vanished between being placed and being saved');
  assert.equal(result.counters.localUnacknowledged, 1);

  console.log('Merge: a newly placed cartridge does not flicker before its write lands.');
}

// The other direction: the server is authority on what exists. A cartridge
// deleted in another window has to disappear here too.
function assertADeletedCartridgeDisappears() {
  const result = mergeCartridges({
    incoming: [cartridge('a', 100, 100)],
    local: [cartridge('a', 100, 100), cartridge('gone', 500, 500)],
  });

  assert.equal(result.cartridges.length, 1, 'a cartridge deleted elsewhere stayed on screen');
  assert.equal(result.cartridges[0].id, 'a');

  console.log('Merge: a cartridge deleted in another window disappears here.');
}

// The payload arrives about once a second. If an unchanged one produces a new
// array, React re-renders the whole cartridge layer every second -- with its
// terminals and its animations -- for nothing.
//
// This is cheap now and expensive later. In an app about to become an animated
// room it does not get reported as "one extra render", it gets reported as "the
// office feels heavy", and by then twenty things could be the cause.
function assertAnUnchangedPayloadKeepsTheSameReference() {
  const local = [cartridge('a', 100, 100, { presence: 'idle' }), cartridge('b', 400, 200)];

  // A fresh payload, parsed from JSON: equal in value, all new objects.
  const incoming = JSON.parse(JSON.stringify(local));

  const result = mergeCartridges({ incoming, local });
  assert.strictEqual(result.cartridges, local,
    'an unchanged payload produced a new array, so the whole cartridge layer re-renders every second');

  // And it must still notice a real change.
  const moved = JSON.parse(JSON.stringify(local));
  moved[1].x = 900;
  const after = mergeCartridges({ incoming: moved, local });
  assert.notStrictEqual(after.cartridges, local, 'a real change was swallowed by the identity check');
  assert.equal(after.cartridges[1].x, 900);

  console.log('Merge: an unchanged payload returns the same array, so nothing re-renders.');
}

// Nested values have to be compared, not just the top level: an unlinked
// cartridge carries a definition object that is rebuilt by every JSON parse.
function assertTheIdentityCheckLooksInsideNestedValues() {
  const local = [cartridge('a', 100, 100, { definition: { name: 'Copper Circuit', role: 'SS' } })];

  const same = mergeCartridges({ incoming: JSON.parse(JSON.stringify(local)), local });
  assert.strictEqual(same.cartridges, local,
    'a nested definition object defeated the identity check, so every payload re-rendered');

  const renamed = JSON.parse(JSON.stringify(local));
  renamed[0].definition.name = 'Neon Socket';
  const changed = mergeCartridges({ incoming: renamed, local });
  assert.notStrictEqual(changed.cartridges, local, 'a change inside the definition went unnoticed');

  console.log('Merge: the identity check reads nested values, and still sees changes in them.');
}

// Switching project replaces every cartridge at once. Reading that as "they all
// moved" would be worse than a visual glitch: the pending writes from the old
// project are still outstanding, and committing them against the new project
// writes one project's layout into another's database.
function assertAProjectSwitchResetsRatherThanMerges() {
  const local = [cartridge('old-1', 100, 100)];
  const pending = { 'old-1': { x: 100, y: 100, slotId: null, at: Date.now() } };

  const result = mergeCartridges({
    incoming: [cartridge('new-1', 500, 300)],
    local,
    pending,
    previousProjectRoot: 'C:/work/ProjectA',
    projectRoot: 'C:/work/ProjectB',
  });

  assert.equal(result.reset, true, 'a project switch was merged instead of reset');
  assert.equal(result.cartridges.length, 1);
  assert.equal(result.cartridges[0].id, 'new-1', "the previous project's cartridges survived the switch");
  assert.deepEqual(result.pending, {},
    "pending writes from the previous project would be committed against the new one");

  console.log('Merge: switching project resets, so one project cannot write into another.');
}

// A payload from the project we are already on is an ordinary update, not a
// reset -- otherwise every tick would throw away pending writes and drags.
function assertTheSameProjectIsNotAReset() {
  const local = [cartridge('a', 640, 300)];
  const result = mergeCartridges({
    incoming: [cartridge('a', 100, 100)],
    local,
    draggingId: 'a',
    previousProjectRoot: 'C:/work/ProjectA',
    projectRoot: 'C:/work/ProjectA',
  });

  assert.ok(!result.reset, 'an ordinary payload was treated as a project switch');
  assert.equal(result.cartridges[0].x, 640, 'the drag was dropped by a reset that should not have happened');

  console.log('Merge: a payload from the same project is an ordinary update.');
}

// The first payload of a session has no previous project to compare against and
// must not be treated as a switch -- there is nothing local to protect yet, and
// calling it a reset would be a lie in the counters.
function assertTheFirstPayloadIsNotAReset() {
  const result = mergeCartridges({
    incoming: [cartridge('a', 100, 100)],
    local: [],
    projectRoot: 'C:/work/ProjectA',
  });

  assert.ok(!result.reset, 'the first payload of a session was reported as a project switch');
  assert.equal(result.cartridges.length, 1);

  console.log('Merge: the first payload of a session is not a switch.');
}

// Persistence comes from one effect watching `bots`, so that any of the 24
// mutation sites -- and the twenty-fifth somebody adds next year -- saves
// itself. The cost of that shape is that the effect runs on every mouse move
// during a drag, because the dragged cartridge's position is part of `bots`.
//
// So the effect must commit what CHANGED, not "everything except the dragged
// one". With four cartridges on screen the naive version sends three writes per
// frame for cartridges nobody touched -- the hot-path writing we just removed,
// back through another door, and it would be reported as "dragging gets slow
// when there are several cartridges".
function assertStillCartridgesAreNotWrittenDuringADrag() {
  const others = [cartridge('b', 400, 200), cartridge('c', 600, 200), cartridge('d', 800, 200)];
  let committed = [cartridge('a', 100, 100), ...others];
  let writes = 0;
  const writesById = {};

  for (let frame = 0; frame < 40; frame += 1) {
    const bots = [cartridge('a', 100 + frame * 8, 100), ...others];
    const plan = planPlacementCommits({ bots, committed, draggingId: 'a' });
    for (const entry of plan) {
      writes += 1;
      writesById[entry.id] = (writesById[entry.id] || 0) + 1;
    }
    // The effect records what it actually sent, which is nothing here.
    committed = committed.map((entry) => plan.find((sent) => sent.id === entry.id) || entry);
  }

  assert.equal(writesById.b || 0, 0, 'a cartridge nobody touched was written during a drag');
  assert.equal(writesById.c || 0, 0);
  assert.equal(writesById.d || 0, 0);
  assert.equal(writes, 0, `${writes} writes went out during a drag that moved one cartridge`);

  console.log('Commits: 40 frames of dragging one cartridge, with three others idle, sent 0 writes.');
}

// And the drop is what sends it -- not because the drop site calls save, but
// because the dragged cartridge stops being excluded once the gesture ends.
function assertTheDropCommitsExactlyOnce() {
  const committed = [cartridge('a', 100, 100), cartridge('b', 400, 200)];
  const bots = [cartridge('a', 900, 40), cartridge('b', 400, 200)];

  const during = planPlacementCommits({ bots, committed, draggingId: 'a' });
  assert.equal(during.length, 0, 'the cartridge was written while it was still under the cursor');

  const onDrop = planPlacementCommits({ bots, committed, draggingId: null });
  assert.equal(onDrop.length, 1, 'the drop did not commit');
  assert.equal(onDrop[0].id, 'a');
  assert.equal(onDrop[0].x, 900);

  // Once recorded, it is not sent again on the next pass.
  const after = planPlacementCommits({ bots, committed: bots, draggingId: null });
  assert.equal(after.length, 0, 'the same placement was committed twice');

  console.log('Commits: the drop sends one write, and only one.');
}

// A mutation that is not a drag -- deleting a slot, a resize reflow, anything
// from the other 23 sites -- still saves itself, with nobody having called save.
function assertAnyMutationCommitsWithoutBeingAskedTo() {
  const committed = [cartridge('a', 100, 100, { slotId: null })];
  const bots = [cartridge('a', 100, 100, { slotId: 'slot-2' })];

  const plan = planPlacementCommits({ bots, committed, draggingId: null });
  assert.equal(plan.length, 1, 'a slot change did not persist; the effect only watches positions');
  assert.equal(plan[0].slotId, 'slot-2');

  console.log('Commits: a change from any mutation site persists without being asked to.');
}

// What retries a failed write, and what does not.
//
// "It holds and is marked" and "the mark clears when the server comes back" only
// fit together with a rule about which failures are worth retrying. Without one
// there are two bad ends: nothing retries and the mark never clears even after
// the server returns, or everything retries and a 409 -- which will never
// succeed, however many times it is sent -- spins forever.
function assertFailuresAreClassified() {
  // No response at all: the dashboard is down or the network dropped.
  assert.equal(classifyCommitFailure({}), 'transient');
  assert.equal(classifyCommitFailure({ status: 0 }), 'transient');
  assert.equal(classifyCommitFailure({ status: 500 }), 'transient');
  assert.equal(classifyCommitFailure({ status: 503 }), 'transient');

  // Slow down and come back: worth retrying, and the server said so.
  assert.equal(classifyCommitFailure({ status: 408 }), 'transient');
  assert.equal(classifyCommitFailure({ status: 429 }), 'transient');

  // The request itself is the problem. Sending it again changes nothing.
  assert.equal(classifyCommitFailure({ status: 409 }), 'permanent',
    'a duplicate-blueprint refusal would spin forever');
  assert.equal(classifyCommitFailure({ status: 400 }), 'permanent');
  assert.equal(classifyCommitFailure({ status: 404 }), 'permanent');

  console.log('Commits: failures are classified, so a 409 never enters a retry loop.');
}

// Backoff, so a dashboard that is down for an hour is not hammered once a
// second for an hour.
function assertTheRetryBacksOff() {
  const delays = [0, 1, 2, 3, 4, 5, 10].map((attempt) => retryDelayMs(attempt));
  for (let i = 1; i < delays.length; i += 1) {
    assert.ok(delays[i] >= delays[i - 1], `backoff went backwards at attempt ${i}`);
  }
  assert.ok(delays[0] <= 1000, 'the first retry should be quick; the server may have blinked');
  assert.ok(delays[delays.length - 1] <= 60000, 'the backoff must stay bounded, or recovery never happens');

  console.log(`Commits: retry backoff runs ${delays[0]}ms to ${delays[delays.length - 1]}ms and stops growing.`);
}

// A transient failure is retried: the same placement is proposed again once the
// backoff has elapsed, so a server that comes back heals the mark by itself.
function assertATransientFailureIsRetried() {
  const bots = [cartridge('a', 900, 40)];
  const committed = [cartridge('a', 100, 100)];
  const failures = { a: { x: 900, y: 40, slotId: null, kind: 'transient', attempts: 1, nextAttemptAt: 5000 } };

  const tooSoon = planPlacementCommits({ bots, committed, failures, now: 4000 });
  assert.equal(tooSoon.length, 0, 'the retry ignored its own backoff');

  const due = planPlacementCommits({ bots, committed, failures, now: 5001 });
  assert.equal(due.length, 1, 'a transient failure was never retried, so the mark can never clear');

  console.log('Commits: a transient failure retries after its backoff, so recovery is automatic.');
}

// A permanent failure is not retried for the same placement. Without this the
// ordinary diff keeps proposing it forever, because the write never landed and
// the committed snapshot never advanced -- the retry loop by accident.
function assertAPermanentFailureIsNotRetried() {
  const bots = [cartridge('a', 900, 40)];
  const committed = [cartridge('a', 100, 100)];
  const failures = { a: { x: 900, y: 40, slotId: null, kind: 'permanent', attempts: 1 } };

  const plan = planPlacementCommits({ bots, committed, failures, now: Date.now() + 3600000 });
  assert.equal(plan.length, 0, 'a permanently refused write is being resent forever');

  console.log('Commits: a permanent refusal is not resent, however long you wait.');
}

// But it must not become a dead cartridge either. Moving it again is a different
// request, and deserves its own attempt.
function assertMovingAgainClearsAPermanentFailure() {
  const committed = [cartridge('a', 100, 100)];
  const failures = { a: { x: 900, y: 40, slotId: null, kind: 'permanent', attempts: 1 } };

  const movedElsewhere = planPlacementCommits({
    bots: [cartridge('a', 300, 300)],
    committed,
    failures,
    now: Date.now(),
  });
  assert.equal(movedElsewhere.length, 1,
    'a cartridge that failed once could never be saved again, whatever the user did');
  assert.equal(movedElsewhere[0].x, 300);

  console.log('Commits: moving a refused cartridge somewhere else is a new attempt.');
}

// What happens when a commit fails.
//
// Decided: never revert in silence. If the hold is simply released, the server
// wins on the next payload and the cartridge the user moved slides back to its
// old place with no explanation -- which is exactly how "sometimes the
// cartridges move on their own" gets reported. The local value is kept and the
// cartridge is marked as unsaved instead, so the disagreement is visible and the
// user can act on it. Same rule as `activated` against a dead session: report
// the disagreement, do not resolve it quietly.
function assertAFailedCommitHoldsAndIsMarked() {
  const at = 1000;
  const failed = { a: { x: 640, y: 300, slotId: null, at, failed: true } };

  // Well past the timeout that releases an ordinary in-flight write.
  const result = mergeCartridges({
    incoming: [cartridge('a', 100, 100)],
    local: [cartridge('a', 640, 300)],
    pending: failed,
    now: at + DEFAULT_PENDING_TIMEOUT_MS * 10,
  });

  assert.equal(result.cartridges[0].x, 640,
    'a cartridge slid back to its old position five seconds after a failed save');
  assert.equal(result.cartridges[0].unsaved, true,
    'the failure was invisible, which is how "the cartridges move on their own" gets reported');
  assert.ok(result.pending.a, 'the failed write was forgotten, so the local value is next');

  console.log('Commits: a failed save holds its position and says so, rather than reverting silently.');
}

// The other half of that: an in-flight write is not a failed one, and still
// releases on the timeout. Otherwise a dropped connection pins the position for
// good and nothing ever says why.
function assertAnInFlightWriteStillExpires() {
  const at = 1000;
  const result = mergeCartridges({
    incoming: [cartridge('a', 100, 100)],
    local: [cartridge('a', 640, 300)],
    pending: { a: { x: 640, y: 300, slotId: null, at } },
    now: at + DEFAULT_PENDING_TIMEOUT_MS + 1,
  });

  assert.equal(result.cartridges[0].x, 100);
  assert.ok(!result.cartridges[0].unsaved, 'an expired in-flight write must not claim it failed');

  console.log('Commits: an in-flight write still expires; only a failed one holds.');
}

// The pass criterion for the manual run, as a number rather than a look.
//
// After a drop the hold must be released by the echo, and released quickly. If it
// is instead released by the timeout, the position on screen is correct and is
// being held for the wrong reason -- indistinguishable by eye, and it means the
// write never actually landed. `pending` returning to empty is the observable
// difference, so the manual checklist asks for that number and this fixes what
// "quickly" means.
function assertPendingClearsOnTheEchoNotTheTimeout() {
  const at = 1000;
  let pending = { a: { x: 640, y: 300, slotId: null, at } };
  let passes = 0;

  // Two payloads still in flight from before the write landed, then the echo.
  const payloads = [
    [cartridge('a', 100, 100)],
    [cartridge('a', 100, 100)],
    [cartridge('a', 640, 300)],
  ];

  for (const incoming of payloads) {
    passes += 1;
    const result = mergeCartridges({
      incoming,
      local: [cartridge('a', 640, 300)],
      pending,
      // Well inside the timeout: nothing here may be released by expiry.
      now: at + passes * 60,
    });
    pending = result.pending;
  }

  assert.deepEqual(pending, {}, 'the hold was still outstanding after the server echoed the position');
  assert.ok(passes * 60 < DEFAULT_PENDING_TIMEOUT_MS,
    'this scenario has to finish well inside the timeout, or it proves nothing');

  console.log(`Merge: after a drop the hold clears on the echo, in ${passes} passes, not on the timeout.`);
}

// Verification by counter rather than by impression: a drag produces a number
// that says which side won, so "it did not jump" becomes something to read
// rather than something to feel.
function assertADragProducesEvidence() {
  const recorder = createMergeRecorder();
  let local = [cartridge('a', 100, 100)];

  // Three seconds of dragging at roughly one payload per 60ms.
  for (let frame = 0; frame < 50; frame += 1) {
    local = [cartridge('a', 100 + frame * 8, 100 + frame * 4)];
    const result = mergeCartridges({
      incoming: [cartridge('a', 100, 100)],
      local,
      draggingId: 'a',
    });
    recorder.record(result.counters);
  }

  const totals = recorder.totals();
  assert.equal(totals.localDrag, 50, 'the drag did not win every pass');
  assert.equal(totals.incoming, 0, `the incoming payload won ${totals.incoming} times during a drag`);

  console.log(`Merge: over 50 passes of a drag, local won ${totals.localDrag} and incoming won ${totals.incoming}.`);
}

function main() {
  assertIncomingWinsWhenNothingIsHappening();
  assertADragIsNotOverwritten();
  assertADragOnlyHoldsPlacement();
  assertOtherCartridgesKeepUpdatingDuringADrag();
  assertTheDropIsHeldUntilTheServerCatchesUp();
  assertALostWriteStopsHoldingAfterATimeout();
  assertANewCartridgeSurvivesUntilTheServerKnowsIt();
  assertADeletedCartridgeDisappears();
  assertStillCartridgesAreNotWrittenDuringADrag();
  assertTheDropCommitsExactlyOnce();
  assertAnyMutationCommitsWithoutBeingAskedTo();
  assertFailuresAreClassified();
  assertTheRetryBacksOff();
  assertATransientFailureIsRetried();
  assertAPermanentFailureIsNotRetried();
  assertMovingAgainClearsAPermanentFailure();
  assertAFailedCommitHoldsAndIsMarked();
  assertAnInFlightWriteStillExpires();
  assertAnUnchangedPayloadKeepsTheSameReference();
  assertTheIdentityCheckLooksInsideNestedValues();
  assertAProjectSwitchResetsRatherThanMerges();
  assertTheSameProjectIsNotAReset();
  assertTheFirstPayloadIsNotAReset();
  assertPendingClearsOnTheEchoNotTheTimeout();
  assertADragProducesEvidence();

  console.log('Cartridge merge validation passed.');
}

main();
