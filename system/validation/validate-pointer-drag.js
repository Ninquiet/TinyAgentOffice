'use strict';

const assert = require('assert');
const { createPointerDragController, CLICK_DRAG_THRESHOLD } = require('../../app/src/drag/pointerDrag.ts');

function fakeTarget() {
  const captured = new Set();
  return {
    captured,
    setPointerCapture(id) {
      captured.add(id);
    },
    releasePointerCapture(id) {
      captured.delete(id);
    },
    hasPointerCapture(id) {
      return captured.has(id);
    },
  };
}

function event(target, x, y, pointerId = 1) {
  return { currentTarget: target, pointerId, clientX: x, clientY: y };
}

function assertCapturesAndUsesThreshold() {
  const target = fakeTarget();
  const calls = [];
  const drag = createPointerDragController({
    onDragStart: (id) => calls.push(['start', id]),
    onDragMove: (id, point) => calls.push(['move', id, point]),
    onDrop: (id, point) => calls.push(['drop', id, point]),
    onClick: (id) => calls.push(['click', id]),
  });

  drag.begin(event(target, 10, 10), 'bp-1');
  assert.equal(target.hasPointerCapture(1), true, 'drag did not capture the pointer on pointerdown');

  drag.move(event(target, 10 + CLICK_DRAG_THRESHOLD, 10));
  assert.deepEqual(calls, [], 'moving at the click threshold already counted as a drag');

  drag.move(event(target, 10 + CLICK_DRAG_THRESHOLD + 1, 10));
  assert.equal(calls[0][0], 'start', 'drag start did not fire when the threshold was crossed');
  assert.equal(calls[1][0], 'move', 'drag move did not fire after the threshold was crossed');

  drag.finish(event(target, 24, 10));
  assert.equal(target.hasPointerCapture(1), false, 'drag did not release pointer capture on finish');
  assert.equal(calls.at(-1)[0], 'drop', 'a real drag did not end as a drop');

  console.log('Pointer drag: capture, threshold, move and drop are shared mechanics.');
}

function assertMovesRequireCapture() {
  const target = fakeTarget();
  const calls = [];
  const drag = createPointerDragController({
    onDragMove: () => calls.push('move'),
  });

  drag.begin(event(target, 0, 0), 'bp-1');
  target.releasePointerCapture(1);
  drag.move(event(target, 100, 0));

  assert.deepEqual(calls, [], 'drag moved after pointer capture was lost');

  console.log('Pointer drag: move is ignored after capture is lost.');
}

function assertCancelFinishesNormally() {
  const target = fakeTarget();
  const calls = [];
  const drag = createPointerDragController({
    onDragMove: () => calls.push('move'),
    onDrop: () => calls.push('drop'),
    onClick: () => calls.push('click'),
  });

  drag.begin(event(target, 0, 0), 'bp-1');
  drag.move(event(target, 20, 0));
  drag.finish(event(target, 24, 0));

  assert.deepEqual(calls, ['move', 'drop'], 'pointercancel-style finish did not close the drag normally');

  const clickTarget = fakeTarget();
  const clickCalls = [];
  const clickDrag = createPointerDragController({
    onDrop: () => clickCalls.push('drop'),
    onClick: () => clickCalls.push('click'),
  });
  clickDrag.begin(event(clickTarget, 0, 0), 'bp-2');
  clickDrag.finish(event(clickTarget, 1, 1));
  assert.deepEqual(clickCalls, ['click'], 'a click without threshold movement was treated as a drag');

  console.log('Pointer drag: cancel/up finish normally, and clicks stay clicks.');
}

function main() {
  assertCapturesAndUsesThreshold();
  assertMovesRequireCapture();
  assertCancelFinishesNormally();
  console.log('Pointer drag validation passed.');
}

main();
