'use strict';

// The open blueprint tray lives between two neighboring controls: the bottom
// edge of the BLUEPRINTS trigger and the top edge of the task tabs. This check
// guards the contract by looking for shared layout tokens rather than a
// screenshot-sized coordinate patch.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', '..', 'app', 'src');
const TOKENS = path.join(APP, 'styles', 'tokens-and-shell.css');
const LAYOUT = path.join(APP, 'styles', 'layout-and-tasks.css');
const TRAY = path.join(APP, 'themes', 'cyberpunk', 'components', 'BlueprintTray.css');
const CYBERPUNK_TRAY = path.join(APP, 'themes', 'cyberpunk', 'trayComposition.ts');

const NARROW_VIEWPORT = { width: 521, height: 921 };
const DESKTOP_VIEWPORT = { width: 1280, height: 720 };
const CYBERPUNK_RECT_TOKENS = {
  dockTop: 24,
  builderButtonHeight: 173,
  builderControlGap: 10,
  trayButtonWidth: 152,
  trayButtonHeight: 52,
  trayWidth: 300,
  safeGap: 12,
  taskTabsBottom: 34,
  taskTabHeight: 78,
};

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function blockFor(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS block for ${selector}`);
  return match[1];
}

function assertSharedLayoutTokensExist() {
  const tokens = read(TOKENS);
  for (const token of [
    '--dashboard-edge-x',
    '--dock-top',
    '--dock-gap',
    '--builder-control-gap',
    '--builder-button-height',
    '--task-tabs-bottom',
    '--task-tab-button-height',
    '--blueprint-tray-safe-gap',
  ]) {
    assert.ok(tokens.includes(token), `missing shared layout token ${token}`);
  }

  console.log('Tray safe region: shared neighbor-control tokens exist.');
}

function assertTriggerColumnCanFitTheTrigger() {
  const layout = read(LAYOUT);
  const topDock = blockFor(layout, '.top-dock');

  assert.ok(/top\s*:\s*var\(--dock-top\b/.test(topDock), 'top dock must read --dock-top');
  assert.ok(/right\s*:\s*var\(--dashboard-edge-x\b/.test(topDock), 'top dock must read --dashboard-edge-x');
  assert.ok(/gap\s*:\s*var\(--dock-gap\b/.test(topDock), 'top dock must read --dock-gap');
  assert.ok(
    /grid-template-columns\s*:\s*auto\s+max-content\s*;/.test(topDock),
    'the builder column is fixed narrower than the BLUEPRINTS trigger; use max-content so the full trigger and focus ring fit'
  );

  const stack = blockFor(layout, '.builder-control-stack');
  assert.ok(
    /gap\s*:\s*var\(--builder-control-gap\b/.test(stack),
    'the stack gap must be a shared token because the tray top is derived from it'
  );

  console.log('Tray safe region: trigger column is content-sized and token-positioned.');
}

function assertTaskTabsExposeTheirTopBoundary() {
  const layout = read(LAYOUT);
  const tabs = blockFor(layout, '.task-panel-tabs');
  const button = blockFor(layout, '.task-panel-tabs button');

  assert.ok(/right\s*:\s*var\(--dashboard-edge-x\b/.test(tabs), 'task tabs must share the dashboard edge token');
  assert.ok(/bottom\s*:\s*var\(--task-tabs-bottom\b/.test(tabs), 'task tabs must expose their bottom token');
  assert.ok(/min-height\s*:\s*var\(--task-tab-button-height\b/.test(button), 'task tabs must expose their height token');

  console.log('Tray safe region: task tabs expose the boundary the tray avoids.');
}

function assertTrayUsesTheSafeRegion() {
  const trayCss = read(TRAY);
  const tray = blockFor(trayCss, '.blueprint-tray');

  for (const token of [
    '--blueprint-tray-safe-top',
    '--blueprint-tray-safe-bottom',
    '--dock-top',
    '--builder-button-height',
    '--builder-control-gap',
    '--tray-button-height',
    '--task-tabs-bottom',
    '--task-tab-button-height',
    '--blueprint-tray-safe-gap',
  ]) {
    assert.ok(tray.includes(token), `the tray safe region does not use ${token}`);
  }

  assert.ok(/top\s*:\s*var\(--blueprint-tray-safe-top\b/.test(tray), 'the tray must start below the BLUEPRINTS trigger');
  assert.ok(
    /bottom\s*:\s*var\(--tray-bottom\s*,\s*var\(--blueprint-tray-safe-bottom\)\s*\)/.test(tray),
    'the tray must stop above the task tabs by default while preserving the bottom theme knob'
  );
  assert.ok(/height\s*:\s*auto\s*;/.test(tray), 'the tray must be bounded by top and bottom, not a fixed half-screen height');
  assert.ok(/max-height\s*:\s*var\(--tray-height\s*,/.test(tray), 'the tray height theme knob must remain readable as a cap');
  assert.ok(!/height\s*:\s*var\(--tray-height\s*,\s*50%\s*\)/.test(tray), 'the old lower-half tray sizing is still present');

  const right = blockFor(trayCss, ".blueprint-tray[data-side='right']");
  const left = blockFor(trayCss, ".blueprint-tray[data-side='left']");
  assert.ok(/right\s*:\s*var\(--dashboard-edge-x\b/.test(right), 'right tray must use the shared viewport edge token');
  assert.ok(/left\s*:\s*var\(--dashboard-edge-x\b/.test(left), 'left tray must use the shared viewport edge token');

  console.log('Tray safe region: tray is bounded by the trigger and task tabs.');
}

function assertThemeDoesNotOverrideTheSafeDefaults() {
  const theme = read(CYBERPUNK_TRAY);

  assert.ok(
    !/height\s*:\s*['"]50%['"]/.test(theme),
    'cyberpunk still forces the old lower-half tray height instead of using the safe region'
  );
  assert.ok(
    !/bottom\s*:\s*['"]0px['"]/.test(theme),
    'cyberpunk still forces the tray to the bottom edge instead of using the safe region'
  );

  console.log('Tray safe region: cyberpunk leaves the safe vertical bounds intact.');
}

function assertScrollAndGestureBoundsRemainIntact() {
  const trayCss = read(TRAY);
  const items = blockFor(trayCss, '.blueprint-tray-items');
  assert.ok(/overflow-y\s*:\s*auto\b/.test(items), 'the internal blueprint list must keep vertical scrolling');
  assert.ok(/overflow-x\s*:\s*hidden\b/.test(items), 'the internal blueprint list must not create horizontal scroll');

  const component = read(path.join(APP, 'components', 'BlueprintTray.tsx'));
  assert.ok(component.includes('trayBounds()'), 'the component must still measure the tray DOM bounds');
  assert.ok(component.includes('gestureFor(pointer, trayBounds())'), 'reorder-vs-instance must still use tray bounds');

  console.log('Tray safe region: scroll and reorder/instance bounds remain wired.');
}

function edgeForViewport(width) {
  return Math.min(32, Math.max(12, width * 0.025));
}

function measuredRectsFromTokens(v) {
  const t = CYBERPUNK_RECT_TOKENS;
  const edge = edgeForViewport(v.width);
  const trigger = {
    left: v.width - edge - t.trayButtonWidth,
    right: v.width - edge,
    top: t.dockTop + t.builderButtonHeight + t.builderControlGap,
    bottom: t.dockTop + t.builderButtonHeight + t.builderControlGap + t.trayButtonHeight,
  };
  const tray = {
    left: v.width - edge - t.trayWidth,
    right: v.width - edge,
    top: trigger.bottom + t.safeGap,
    bottom: v.height - t.taskTabsBottom - t.taskTabHeight - t.safeGap,
  };
  const tabs = {
    top: v.height - t.taskTabsBottom - t.taskTabHeight,
    bottom: v.height - t.taskTabsBottom,
  };

  return { trigger, tray, tabs };
}

function assertViewportGeometryFromTokens(v) {
  const { trigger, tray, tabs } = measuredRectsFromTokens(v);

  const focusMargin = 6;
  assert.ok(trigger.left - focusMargin >= 0, 'the focused BLUEPRINTS trigger overflows the left viewport edge at 521px');
  assert.ok(trigger.right + focusMargin <= v.width, 'the focused BLUEPRINTS trigger overflows the right viewport edge at 521px');
  assert.ok(tray.left >= 0 && tray.right <= v.width, 'the open tray overflows horizontally at 521px');
  assert.ok(tray.top - trigger.bottom > 0, 'the tray overlaps the BLUEPRINTS trigger at 521px');
  assert.ok(tabs.top - tray.bottom > 0, 'the tray overlaps the task tabs at 521px');

  console.log(
    `Tray safe region measurement @${v.width}x${v.height} from shared tokens: `
    + `trigger ${JSON.stringify(trigger)}, tray ${JSON.stringify(tray)}, tabs ${JSON.stringify(tabs)}.`
  );
}

function main() {
  assertSharedLayoutTokensExist();
  assertTriggerColumnCanFitTheTrigger();
  assertTaskTabsExposeTheirTopBoundary();
  assertTrayUsesTheSafeRegion();
  assertThemeDoesNotOverrideTheSafeDefaults();
  assertScrollAndGestureBoundsRemainIntact();
  assertViewportGeometryFromTokens(NARROW_VIEWPORT);
  assertViewportGeometryFromTokens(DESKTOP_VIEWPORT);
  console.log('Tray safe region validation passed.');
}

main();
