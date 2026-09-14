'use strict';

// Reordering inside the tray, and the two gestures that share one element.
//
// Dragging a blueprint out instances it; dragging it within the tray reorders
// it. The drop decides. The user has to know which is about to happen before
// letting go, and the two affordances are what tell them -- a gap means reorder,
// a ghost means instance -- so the rule that matters most here is that they are
// never both showing.

const assert = require('assert');
const ordering = require('../../app/src/cartridges/trayOrdering.ts');
const { ghostFor } = require('../../app/src/cartridges/instancing.ts');
const geometry = require('../../app/src/cartridges/geometry.ts');
const { CARTRIDGE_HEIGHT } = geometry;

const TRAY = { top: 100, bottom: 700, left: 980, right: 1280 };

function blueprint(id, trayIndex) {
  return {
    id,
    definition: { name: id, role: 'SS', model: 'm', adapter: null, cli: null, startupInstructions: null },
    trayIndex,
    revision: 1,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  };
}

// --- telling the gestures apart ---------------------------------------------

function assertTheDropPointDecidesTheGesture() {
  assert.equal(ordering.gestureFor({ x: 1100, y: 400 }, TRAY), 'reorder', 'a drop inside the tray must reorder');
  assert.equal(ordering.gestureFor({ x: 500, y: 400 }, TRAY), 'instance', 'a drop on the board must instance');
  assert.equal(ordering.gestureFor({ x: 1100, y: 900 }, TRAY), 'instance', 'below the tray is outside it');
  assert.equal(ordering.gestureFor({ x: 1100, y: 400 }, null), 'instance', 'with no tray there is nothing to reorder within');

  console.log('Gestures: the drop point decides, inside reorders and outside instances.');
}

// The affordance and the action are the same decision, called twice. If they
// were two decisions they could disagree, and the user would see one thing and
// get the other -- which is the worst outcome available here, worse than either
// gesture being wrong on its own.
function assertTheAffordanceMatchesWhatWillHappen() {
  const blueprints = [blueprint('a', 0), blueprint('b', 1)];

  for (const pointer of [{ x: 1100, y: 300 }, { x: 400, y: 300 }, { x: 1100, y: 950 }]) {
    const gesture = ordering.gestureFor(pointer, TRAY);
    const gap = ordering.gapIndexFor({
      gesture,
      insertionIndex: geometry.insertionIndexAt({
        pointerY: pointer.y, trayTop: TRAY.top, count: blueprints.length, scale: 0.5, gap: 12,
      }),
    });
    const ghost = gesture === 'instance' ? ghostFor(blueprints, 'a') : null;

    assert.ok(
      !(gap !== null && ghost !== null),
      `at (${pointer.x}, ${pointer.y}) both a gap and a ghost were showing, so the user cannot tell what will happen`
    );
    if (gesture === 'reorder') {
      assert.ok(gap !== null, 'a reorder showed no gap, so it looks like an instance');
      assert.equal(ghost, null);
    } else {
      assert.ok(ghost !== null, 'an instance showed no ghost, so it looks like a reorder');
      assert.equal(gap, null);
    }
  }

  console.log('Gestures: exactly one affordance shows, and it is the one that matches the drop.');
}

// --- the insertion index is geometry ----------------------------------------

// The same hazard as the drag geometry. A theme at a different scale draws
// shorter items, so the same Y is a different slot -- read it from a constant
// and items land somewhere the user did not point at, in that theme only.
function assertTheInsertionIndexReadsTheThemeScale() {
  const count = 4;
  const gap = 0;

  // At half scale an item is 87px, so 200px down the tray is the third slot.
  const half = geometry.insertionIndexAt({
    pointerY: TRAY.top + (CARTRIDGE_HEIGHT * 0.5) * 2, trayTop: TRAY.top, count, scale: 0.5, gap,
  });
  assert.equal(half, 2, 'at half scale the pointer landed in the wrong slot');

  // The same Y at full scale is only the first, because items are twice as tall.
  const full = geometry.insertionIndexAt({
    pointerY: TRAY.top + (CARTRIDGE_HEIGHT * 0.5) * 2, trayTop: TRAY.top, count, scale: 1, gap,
  });
  assert.equal(full, 1, 'the index ignored the scale, so a themed tray drops items in the wrong place');

  assert.notEqual(half, full, 'scale made no difference at all, which means it is not being read');

  console.log(`Insertion: the same Y is slot ${half} at half scale and slot ${full} at full scale.`);
}

function assertTheGapBetweenItemsCounts() {
  // At half scale a slot is 87px without spacing and 99px with a 12px gap, so
  // 400px down the column is the fifth slot without it and the fourth with it.
  // The Y has to be chosen where those actually differ -- an earlier version of
  // this test picked one where both rounded to the same slot, so it passed
  // whether or not the gap was being counted.
  const withoutGap = geometry.insertionIndexAt({ pointerY: TRAY.top + 400, trayTop: TRAY.top, count: 8, scale: 0.5, gap: 0 });
  const withGap = geometry.insertionIndexAt({ pointerY: TRAY.top + 400, trayTop: TRAY.top, count: 8, scale: 0.5, gap: 12 });

  assert.notEqual(withGap, withoutGap, 'the theme gap is not part of the slot height, so spacing shifts the drop');

  console.log(`Insertion: the theme gap counts -- slot ${withoutGap} without it, ${withGap} with it.`);
}

function assertTheIndexStaysInsideTheList() {
  assert.equal(geometry.insertionIndexAt({ pointerY: -9999, trayTop: TRAY.top, count: 3, scale: 0.5 }), 0);
  assert.equal(geometry.insertionIndexAt({ pointerY: 99999, trayTop: TRAY.top, count: 3, scale: 0.5 }), 3);
  assert.equal(geometry.insertionIndexAt({ pointerY: TRAY.top, trayTop: TRAY.top, count: 0, scale: 0.5 }), 0);

  // A missing or nonsense scale must not collapse every slot onto zero.
  assert.equal(
    geometry.insertionIndexAt({ pointerY: TRAY.top + 400, trayTop: TRAY.top, count: 4 }),
    geometry.insertionIndexAt({ pointerY: TRAY.top + 400, trayTop: TRAY.top, count: 4, scale: 1 }),
    'a missing scale did not fall back to full size'
  );

  console.log('Insertion: the index is clamped to the list, and a missing scale falls back.');
}

function assertTwoColumnInsertionUsesBothAxesAndScroll() {
  const content = {
    trayTop: 120,
    trayLeft: 1000,
    trayWidth: 268,
    count: 6,
    columns: 2,
    scale: 0.5,
    gap: 12,
  };

  const first = geometry.insertionIndexAt({
    ...content,
    pointerX: content.trayLeft + 12,
    pointerY: content.trayTop + 12,
  });
  const second = geometry.insertionIndexAt({
    ...content,
    pointerX: content.trayLeft + 152,
    pointerY: content.trayTop + 12,
  });
  assert.equal(first, 0, 'the left cell in the first row must resolve to the first insertion slot');
  assert.equal(second, 1, 'the right cell in the same row must resolve to the second insertion slot');
  assert.notEqual(first, second, 'a two-column tray cannot use Y alone to choose an insertion slot');

  const crossRow = geometry.insertionIndexAt({
    ...content,
    pointerX: content.trayLeft + 152,
    pointerY: content.trayTop + 111,
  });
  assert.equal(crossRow, 3, 'the right cell in the second row must preserve row-major order');

  const oneRowScrolled = geometry.insertionIndexAt({
    ...content,
    pointerX: content.trayLeft + 12,
    pointerY: content.trayTop + 12,
    scrollTop: (CARTRIDGE_HEIGHT * 0.5) + content.gap,
  });
  assert.equal(oneRowScrolled, 2, 'scrollTop must keep the visible row aligned with its real insertion slots');

  const last = geometry.insertionIndexAt({
    ...content,
    pointerX: content.trayLeft + content.trayWidth + 20,
    pointerY: content.trayTop + 260,
  });
  assert.equal(last, content.count, 'a pointer after the final grid cell must clamp to the list end');

  console.log('Insertion: two-column row-major geometry uses X, Y, and tray scroll.');
}

// --- the reorder itself -----------------------------------------------------

// One write, not N. Moving the top item to the bottom shifts everything between
// them, so doing it one blueprint at a time is N round trips for one gesture --
// and N chances to end up half reordered.
function assertAReorderProducesTheWholeOrderAtOnce() {
  const blueprints = [blueprint('a', 0), blueprint('b', 1), blueprint('c', 2), blueprint('d', 3)];

  const next = ordering.reorderBlueprints(blueprints, 'a', 4);

  assert.deepEqual(
    next.map((entry) => entry.id),
    ['b', 'c', 'd', 'a'],
    'moving the first item to the end did not reflow the rest'
  );
  assert.deepEqual(
    next.map((entry) => entry.trayIndex),
    [0, 1, 2, 3],
    'the places are not contiguous, so the next reorder computes against gaps'
  );
  assert.equal(next.length, blueprints.length, 'a reorder must return every blueprint, not just the moved one');

  console.log('Reorder: one gesture produces the complete order, ready for a single write.');
}

function assertMovingUpAndDownBothLandWhereShown() {
  const blueprints = [blueprint('a', 0), blueprint('b', 1), blueprint('c', 2), blueprint('d', 3)];

  // Dropping 'd' between 'a' and 'b' is insertion index 1.
  assert.deepEqual(
    ordering.reorderBlueprints(blueprints, 'd', 1).map((entry) => entry.id),
    ['a', 'd', 'b', 'c'],
    'moving an item up landed in the wrong slot'
  );

  // Dropping 'a' between 'b' and 'c' is insertion index 2 in the list the user
  // sees -- which still contains 'a'. Removing it first shifts everything up,
  // so without adjusting the target it lands one place too far down.
  assert.deepEqual(
    ordering.reorderBlueprints(blueprints, 'a', 2).map((entry) => entry.id),
    ['b', 'a', 'c', 'd'],
    'moving an item down landed one slot too far, because the index was not adjusted for its own removal'
  );

  console.log('Reorder: moving up and moving down both land where the gap was showing.');
}

function assertReorderingIsStableAndTotal() {
  const blueprints = [blueprint('a', 0), blueprint('b', 1), blueprint('c', 2)];

  // Dropping something back where it already is changes nothing.
  assert.deepEqual(
    ordering.reorderBlueprints(blueprints, 'b', 1).map((entry) => entry.id),
    ['a', 'b', 'c'],
    'dropping an item on its own slot reshuffled the tray'
  );

  // An unknown id must not scramble the order or drop anyone.
  const untouched = ordering.reorderBlueprints(blueprints, 'not-here', 0);
  assert.deepEqual(untouched.map((entry) => entry.id), ['a', 'b', 'c']);
  assert.equal(untouched.length, 3);

  // Places that arrive non-contiguous come back contiguous, so the next gesture
  // computes against clean slots.
  const messy = [blueprint('a', 5), blueprint('b', 90), blueprint('c', 12)];
  assert.deepEqual(
    ordering.reorderBlueprints(messy, 'b', 0).map((entry) => `${entry.id}:${entry.trayIndex}`),
    ['b:0', 'a:1', 'c:2'],
    'the tray places were not normalised, so gaps accumulate'
  );

  console.log('Reorder: stable on a no-op, total on an unknown id, and always contiguous.');
}

function assertGridInsertionAndReorderStayInAgreement() {
  const blueprints = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => blueprint(id, index));
  const content = {
    trayTop: 120,
    trayLeft: 1000,
    trayWidth: 268,
    count: blueprints.length,
    columns: 2,
    scale: 0.5,
    gap: 12,
  };
  const indexAt = (x, y, scrollTop = 0) => geometry.insertionIndexAt({
    ...content,
    pointerX: content.trayLeft + x,
    pointerY: content.trayTop + y,
    scrollTop,
  });

  assert.deepEqual(
    ordering.reorderBlueprints(blueprints, 'f', indexAt(12, 12)).map((entry) => entry.id),
    ['f', 'a', 'b', 'c', 'd', 'e'],
    'the first grid affordance did not produce the first row-major position',
  );
  assert.deepEqual(
    ordering.reorderBlueprints(blueprints, 'a', indexAt(152, 111)).map((entry) => entry.id),
    ['b', 'c', 'a', 'd', 'e', 'f'],
    'the middle cross-row affordance did not produce the position it showed',
  );
  assert.deepEqual(
    ordering.reorderBlueprints(blueprints, 'a', indexAt(300, 260)).map((entry) => entry.id),
    ['b', 'c', 'd', 'e', 'f', 'a'],
    'the final grid affordance did not move the item to the end',
  );
  assert.deepEqual(
    ordering.reorderBlueprints(blueprints, 'c', indexAt(12, 12, 99)).map((entry) => entry.id),
    ['a', 'b', 'c', 'd', 'e', 'f'],
    'dropping on the same scrolled grid position must remain a no-op',
  );

  console.log('Reorder: first, middle, last, cross-row, and scrolled no-op grid drops match their affordances.');
}

function main() {
  assertTheDropPointDecidesTheGesture();
  assertTheAffordanceMatchesWhatWillHappen();
  assertTheInsertionIndexReadsTheThemeScale();
  assertTheGapBetweenItemsCounts();
  assertTheIndexStaysInsideTheList();
  assertTwoColumnInsertionUsesBothAxesAndScroll();
  assertAReorderProducesTheWholeOrderAtOnce();
  assertMovingUpAndDownBothLandWhereShown();
  assertReorderingIsStableAndTotal();
  assertGridInsertionAndReorderStayInAgreement();

  console.log('Tray ordering validation passed.');
}

main();
