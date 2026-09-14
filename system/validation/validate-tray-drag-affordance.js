'use strict';

// The tray cartridge is half-size in the tray, but it must still behave like a
// cartridge: the whole visible object is the hit target, it advertises grab /
// grabbing, and the point the user grabbed stays under the pointer while the
// instance preview travels.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', '..', 'app', 'src');
const COMPONENT = path.join(APP, 'components', 'BlueprintTray.tsx');
const APP_COMPONENT = path.join(APP, 'App.tsx');
const CSS = path.join(APP, 'themes', 'cyberpunk', 'components', 'BlueprintTray.css');

const BASE = { width: 224, height: 174 };
const HALF_SCALE = 0.5;

function blockFor(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS block for ${selector}`);
  return match[1];
}

function usesScaledDimension(block, dimension) {
  return new RegExp(`${dimension}\\s*:\\s*calc\\(\\s*${BASE[dimension]}px\\s*\\*\\s*var\\(--tray-blueprint-scale`).test(block);
}

function usesScaleTransform(block) {
  return /transform\s*:[^;]*scale\(\s*var\(--tray-blueprint-scale/.test(block);
}

function assertTrayHitboxMatchesVisibleSurface() {
  const css = fs.readFileSync(CSS, 'utf8');
  const item = blockFor(css, '.blueprint-tray-items > *');

  const layoutWidth = usesScaledDimension(item, 'width') ? BASE.width * HALF_SCALE : BASE.width;
  const layoutHeight = usesScaledDimension(item, 'height') ? BASE.height * HALF_SCALE : BASE.height;
  const transformScale = usesScaleTransform(item) ? HALF_SCALE : 1;
  const visibleWidth = layoutWidth * transformScale;
  const visibleHeight = layoutHeight * transformScale;

  console.log(
    `Tray drag affordance measurement @0.5: hitbox ${layoutWidth}x${layoutHeight}, `
    + `visible ${visibleWidth}x${visibleHeight}.`
  );

  assert.equal(
    visibleWidth,
    layoutWidth,
    'the tray item is scaled after its hitbox is already scaled, so visible width and hitbox width diverge'
  );
  assert.equal(
    visibleHeight,
    layoutHeight,
    'the tray item is scaled after its hitbox is already scaled, so visible height and hitbox height diverge'
  );
  assert.equal(layoutWidth, BASE.width * HALF_SCALE, 'the tray half-scale hitbox must be 112px wide');
  assert.equal(layoutHeight, BASE.height * HALF_SCALE, 'the tray half-scale hitbox must be 87px tall');

  console.log('Tray drag affordance: visible tray cartridge and hitbox match at half scale.');
}

function assertCursorCoversTheTrayCartridge() {
  const css = fs.readFileSync(CSS, 'utf8');
  const component = fs.readFileSync(COMPONENT, 'utf8');
  const item = blockFor(css, '.blueprint-tray-items > *');
  assert.ok(/cursor\s*:\s*grab\b/.test(item), 'the tray item hitbox must advertise cursor: grab');

  const dragging = blockFor(css, ".blueprint-tray-items > [data-dragging='true']");
  assert.ok(/cursor\s*:\s*grabbing\b/.test(dragging), 'the dragged tray item must switch to cursor: grabbing');

  const preview = blockFor(css, '.blueprint-drag-preview');
  assert.ok(/cursor\s*:\s*grabbing\b/.test(preview), 'the visible drag preview must advertise cursor: grabbing');
  assert.ok(
    component.includes("document.documentElement.style.cursor = 'grabbing'"),
    'the tray must force a grabbing cursor during drag because the preview is pointer-events:none'
  );

  console.log('Tray drag affordance: grab/grabbing cursors are declared on the tray surface.');
}

function assertPreviewKeepsTheGrabOffset() {
  const css = fs.readFileSync(CSS, 'utf8');
  const component = fs.readFileSync(COMPONENT, 'utf8');
  const preview = blockFor(css, '.blueprint-drag-preview');

  assert.ok(
    !/translate\(\s*-50%\s*,\s*-50%\s*\)/.test(preview),
    'the drag preview is centered on the pointer; the grabbed point must stay under the pointer instead'
  );
  assert.ok(
    component.includes('dragGrabOffset'),
    'the tray must remember the pointer offset inside the cartridge from pointerdown'
  );
  assert.ok(
    /left:\s*pointer\.x\s*-\s*dragGrabOffset/.test(component),
    'the drag preview left position must subtract the stored grab offset'
  );
  assert.ok(
    /top:\s*pointer\.y\s*-\s*dragGrabOffset/.test(component),
    'the drag preview top position must subtract the stored grab offset'
  );

  const click = { x: 28, y: 19 };
  const pointer = { x: 500, y: 260 };
  const previewTopLeft = { x: pointer.x - click.x, y: pointer.y - click.y };
  assert.deepEqual(
    { x: previewTopLeft.x + click.x, y: previewTopLeft.y + click.y },
    pointer,
    'offset math should keep the original grabbed point exactly under the pointer'
  );

  console.log('Tray drag affordance: drag preview preserves the grabbed point.');
}

function assertDraggedBlueprintTravelsBeforeLeavingTheTray() {
  const component = fs.readFileSync(COMPONENT, 'utf8');

  assert.ok(
    !/draggingBlueprint\s*&&\s*gesture\s*===\s*['"]instance['"]\s*&&\s*pointer/.test(component),
    'the visible cartridge appears only after the gesture becomes instance; it must travel with the mouse during reorder too'
  );

  console.log('Tray drag affordance: the dragged blueprint travels before it leaves the tray.');
}

function assertDroppedBlueprintGrowsWhereItWasReleased() {
  const css = fs.readFileSync(CSS, 'utf8');
  const component = fs.readFileSync(COMPONENT, 'utf8');

  assert.ok(
    component.includes('settlingPreview'),
    'dropping out of the tray must keep a transient preview alive while the real instance is written'
  );
  assert.ok(
    component.includes('ghostSourceId'),
    'the tray ghost must stay on during the settling preview, so the item does not flash back to normal'
  );
  assert.ok(
    component.includes('data-settling'),
    'the dropped preview must expose settling state for the grow animation'
  );
  assert.ok(
    /onInstance\?\.\(\s*blueprintId,\s*\{\s*x:\s*dropLeft,\s*y:\s*dropTop\s*\}\s*\)/s.test(component),
    'the spawned instance must use the preview top-left position, not the raw pointer point'
  );
  assert.ok(
    /@keyframes\s+blueprint-drop-grow/.test(css),
    'the dropped tray preview needs a grow animation so the spawn reads as one continuous release'
  );
  assert.ok(
    /\.blueprint-drag-preview\[data-settling=['"]true['"]\]\s+\.bot-cartridge-preview\s*\{[^}]*animation\s*:\s*blueprint-drop-grow/s.test(css),
    'the grow animation must be attached only to the dropped preview state'
  );
  assert.ok(
    component.includes('settlingGrowDone'),
    'the dropped preview needs to track when the grow animation has finished'
  );
  assert.ok(
    component.includes('usedBlueprintIds?.has(settlingPreview.blueprint.id)'),
    'the dropped preview must stay alive until the spawned instance is visible in usedBlueprintIds'
  );
  assert.ok(
    !/setTimeout\(\s*\(\)\s*=>\s*\{\s*setSettlingPreview\(null\)/s.test(component),
    'a fixed timeout can reveal the normal tray item before the async spawned instance appears'
  );

  console.log('Tray drag affordance: dropped blueprints grow into their spawned instance.');
}

function assertDroppedCartridgeShrinksIntoItsReservedCell() {
  const css = fs.readFileSync(CSS, 'utf8');
  const component = fs.readFileSync(COMPONENT, 'utf8');
  const app = fs.readFileSync(APP_COMPONENT, 'utf8');

  assert.ok(
    component.includes('incomingBlueprint'),
    'the tray needs an explicit incoming blueprint contract while a cartridge is being consumed'
  );
  assert.ok(
    component.includes('data-blueprint-intake-target'),
    'the incoming blueprint must reserve its final grid cell before the flight starts'
  );
  assert.ok(
    component.includes('intakeTargetRef') && component.includes('getBoundingClientRect()'),
    'the flight destination must be measured from the real rendered grid cell'
  );
  assert.ok(
    component.includes("scrollIntoView({ block: 'nearest' })"),
    'an appended blueprint must scroll into view before its destination is measured'
  );
  assert.ok(
    component.includes('blueprint-intake-preview'),
    'the source cartridge needs a fixed flight preview outside the tray clipping region'
  );
  assert.ok(
    app.includes('setBlueprintIntake') && app.includes('sourceCartridgeId'),
    'App must keep the consumed cartridge visually represented until the tray owns the animation'
  );
  assert.ok(
    app.includes('cartridgeSync.consumeDrag(bot.id)'),
    'a tray drop must consume the local drag without committing its last board position again'
  );
  const trayDecision = app.indexOf("const panel = document.getElementById('blueprint-tray')");
  const normalDropEnd = app.indexOf('cartridgeSync.endDrag()', trayDecision);
  const slotSearch = app.indexOf('setBots((current) => {', trayDecision);
  assert.ok(
    trayDecision >= 0 && normalDropEnd > trayDecision && normalDropEnd < slotSearch,
    'the normal placement commit must happen only after the tray-drop branch has returned'
  );
  assert.ok(
    /@keyframes\s+blueprint-intake-settle/.test(css),
    'the cartridge-to-tray path needs its own settle animation'
  );
  assert.ok(
    /@keyframes\s+blueprint-intake-settle\s*\{[\s\S]*?from\s*\{[\s\S]*?scale\(1\)[\s\S]*?to\s*\{[\s\S]*?scale\(var\(--tray-blueprint-scale/s.test(css),
    'the intake animation must shrink from full cartridge size to the theme tray scale'
  );

  console.log('Tray drag affordance: dropped cartridges shrink into a measured tray cell.');
}

function main() {
  assertTrayHitboxMatchesVisibleSurface();
  assertCursorCoversTheTrayCartridge();
  assertPreviewKeepsTheGrabOffset();
  assertDraggedBlueprintTravelsBeforeLeavingTheTray();
  assertDroppedBlueprintGrowsWhereItWasReleased();
  assertDroppedCartridgeShrinksIntoItsReservedCell();
  console.log('Tray drag affordance validation passed.');
}

main();
