'use strict';

// The drag geometry has to agree with the size things are drawn at.
//
// `blueprintScale` is a theme knob. Half size is the current intent for the tray
// and another theme may choose otherwise, so every number the geometry uses has
// to come from the scale rather than from a constant.
//
// The failure this prevents is quiet in the worst way. Scale the pixels with CSS
// and leave the maths on full-size constants, and the connector is computed in
// the wrong place, the snap radius is twice what it looks like, and the drop
// lands offset -- all at once, all consistent with each other, so nothing looks
// obviously broken. It gets reported as "dragging feels wrong in the new theme",
// which is about as far from "a number in a theme file" as a bug report gets.
//
// So the test is a round trip at two scales: put a cartridge on a slot port and
// require that the connector lands exactly on the port, whatever the scale.

const assert = require('assert');
const geometry = require('../../app/src/cartridges/geometry.ts');

const SCALES = [1, 0.5, 0.75, 2];
const ROLES = ['PM', 'SP', 'SS', 'Jr'];

// The property that matters: place the cartridge for a port, and its connector is
// on that port. If the two functions disagree at any scale, the drop is offset by
// exactly that disagreement.
function assertPlacementAndConnectorAgreeAtEveryScale() {
  const port = { x: 640, y: 360 };

  for (const scale of SCALES) {
    for (const role of ROLES) {
      const placed = geometry.botPositionForPortCenter({ x: 0, y: 0, role }, port, scale);
      const connector = geometry.connectorPoint({ ...placed, role }, scale);

      // PM is lifted when seated, so its connector ends up above the port by
      // exactly the lift. SP is inserted sideways, so its connector sits short of
      // the port by the insert depth. Both offsets have to scale too -- that is
      // the whole point of asserting them rather than just asserting "close".
      const expectedY = role === 'PM'
        ? port.y - geometry.metricsAt(scale).pmVisualLift
        : port.y;
      const expectedX = role === 'SP'
        ? port.x - geometry.metricsAt(scale).spInsertDepth
        : port.x;

      assert.ok(
        Math.abs(connector.x - expectedX) < 0.001 && Math.abs(connector.y - expectedY) < 0.001,
        `at scale ${scale}, a seated ${role} connector lands at `
        + `(${connector.x}, ${connector.y}) instead of (${expectedX}, ${expectedY})`
      );
    }
  }

  console.log(`Geometry: placement and connector agree for ${ROLES.length} roles at ${SCALES.length} scales.`);
}

// The same drop, at half size, must reach the same logical conclusion. This is
// the test the plan asks for: run the geometry at two scales and require the
// drop to land in the same logical place.
function assertTheSameGestureSnapsAtEveryScale() {
  const port = { x: 500, y: 300 };

  for (const scale of SCALES) {
    const m = geometry.metricsAt(scale);

    // A cartridge seated on the port is trivially in range.
    const seated = geometry.botPositionForPortCenter({ x: 0, y: 0, role: 'SS' }, port, scale);
    assert.ok(
      geometry.isWithinSnapRange(geometry.connectorPoint({ ...seated, role: 'SS' }, scale), port, scale),
      `at scale ${scale} a cartridge sitting on the port is not within snap range of it`
    );

    // Just inside the snap radius snaps; just outside does not. Both are measured
    // in the scaled radius, which is the point.
    const justInside = { x: port.x + m.snapDistance * 0.9, y: port.y };
    const justOutside = { x: port.x + m.snapDistance * 1.1, y: port.y };
    assert.ok(geometry.isWithinSnapRange(justInside, port, scale), `at scale ${scale}, inside the radius did not snap`);
    assert.ok(!geometry.isWithinSnapRange(justOutside, port, scale), `at scale ${scale}, outside the radius snapped`);
  }

  console.log('Geometry: the snap radius scales with the cartridge, so the gesture feels the same.');
}

// The check that would have caught scaling with CSS alone: at half size the
// numbers must actually be half. If any of them is still full size, the geometry
// is computing against a cartridge that is not the one on screen.
function assertEveryMetricScales() {
  const full = geometry.metricsAt(1);
  const half = geometry.metricsAt(0.5);

  const unscaled = Object.keys(full).filter((key) => {
    if (key === 'scale') return false;
    return Math.abs(half[key] - full[key] / 2) > 0.001;
  });

  assert.deepEqual(
    unscaled,
    [],
    `these did not scale, so they are measuring a cartridge that is not on screen: ${unscaled.join(', ')}`
  );

  // And the metric list must not be empty or this passes for the wrong reason.
  assert.ok(Object.keys(full).length >= 8, 'the metrics went missing; this check is measuring nothing');

  console.log(`Geometry: all ${Object.keys(full).length - 1} metrics scale together.`);
}

function assertClampKeepsAScaledCartridgeOnScreen() {
  const viewport = { width: 1280, height: 720 };

  for (const scale of SCALES) {
    const m = geometry.metricsAt(scale);
    const clamped = geometry.clampBotPosition({ x: 99999, y: 99999 }, viewport, scale);

    assert.ok(
      clamped.x + m.width <= viewport.width + 0.001,
      `at scale ${scale} a clamped cartridge hangs off the right edge`
    );
    assert.ok(
      clamped.y + m.height <= viewport.height + 0.001,
      `at scale ${scale} a clamped cartridge hangs off the bottom edge`
    );

    // A smaller cartridge can legitimately sit further right than a big one. If
    // clamping ignored scale, both would stop at the same place.
    if (scale < 1) {
      const atFullSize = geometry.clampBotPosition({ x: 99999, y: 99999 }, viewport, 1);
      assert.ok(
        clamped.x > atFullSize.x,
        `at scale ${scale} clamping stopped where a full-size cartridge would, so it ignores scale`
      );
    }
  }

  console.log('Geometry: clamping uses the size the cartridge is actually drawn at.');
}

// A theme with no scale set, or a nonsense one, must behave like full size rather
// than collapsing the board to a point.
function assertAMissingScaleIsFullSize() {
  const expected = geometry.metricsAt(1);
  for (const bad of [undefined, null, 0, -1, NaN, 'half']) {
    assert.deepEqual(
      geometry.metricsAt(bad),
      expected,
      `a scale of ${String(bad)} did not fall back to full size`
    );
  }

  console.log('Geometry: a missing or nonsense scale falls back to full size.');
}

function main() {
  assertPlacementAndConnectorAgreeAtEveryScale();
  assertTheSameGestureSnapsAtEveryScale();
  assertEveryMetricScales();
  assertClampKeepsAScaledCartridgeOnScreen();
  assertAMissingScaleIsFullSize();

  console.log('Cartridge geometry validation passed.');
}

main();
