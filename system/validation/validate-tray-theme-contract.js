'use strict';

// The tray is a themeable element, and that is the point of the slice.
//
// The user plans several themes, so the requirement is not a particular look: it
// is that every visual property is a knob in the theme's `.ts` and nothing is
// decided in the component. Two things make that real rather than aspirational,
// and both are checkable.
//
// **`default: {}` has to work.** A theme that sets nothing must still render a
// correct tray, which is the only way to know the CSS fallbacks are real values
// rather than decoration. If the component ever starts depending on a value the
// empty composition does not have, that dependency is a hardcoded assumption
// wearing a theme's clothes.
//
// **The copy is not a knob.** `Blueprints`, `Unlink them` and `Stop them` are
// product language (Q5). A theme that can rename things gives the product a
// different vocabulary per theme, which is how a product stops having one.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', '..', 'app', 'src');
// Node's TypeScript loader resolves imports as ESM, which needs file
// extensions; Vite does not. So a client module can be required here only when
// its own imports are type-only (those are erased) -- which is true of the
// contract and of a theme's values, and not of the registry, whose import of the
// cyberpunk file is a real one. The registry is three lines and is checked as
// text below rather than left unchecked.
const contract = require(path.join(APP, 'themes', 'trayCompositionTypes.ts'));
const { cyberpunkTrayComposition } = require(path.join(APP, 'themes', 'cyberpunk', 'trayComposition.ts'));
const REGISTRY = path.join(APP, 'themes', 'trayCompositions.ts');

const COMPONENT = path.join(APP, 'components', 'BlueprintTray.tsx');
const CSS = path.join(APP, 'themes', 'cyberpunk', 'components', 'BlueprintTray.css');

// An empty composition must produce no custom properties at all, and must not
// throw. Anything it emits is a value the component invented.
function assertTheEmptyCompositionIsUsable() {
  const registry = fs.readFileSync(REGISTRY, 'utf8');
  assert.ok(
    /default:\s*\{\s*\}/.test(registry),
    'the default theme must be an empty composition; it is what a new theme starts from'
  );
  assert.ok(registry.includes('cyberpunk'), 'the registry no longer wires the cyberpunk tray');

  const style = contract.trayCompositionToStyle('tray', {});
  assert.deepEqual(
    Object.keys(style),
    [],
    'an empty composition produced CSS variables, so some value is being invented rather than defaulted'
  );

  assert.doesNotThrow(() => contract.trayCompositionToStyle('tray', undefined));
  assert.doesNotThrow(() => contract.trayCompositionToStyle('tray', { panel: {} }));

  console.log('Tray theme: an empty composition renders without inventing values.');
}

// The two fields that are not CSS. A theme that omits them must still get a
// usable gesture rather than `undefined` reaching the geometry.
function assertTheNonCssFieldsAlwaysResolve() {
  assert.equal(contract.traySide(undefined), 'right');
  assert.equal(contract.traySide({}), 'right');
  assert.equal(contract.traySide({ panel: {} }), 'right');
  assert.equal(contract.traySide({ panel: { side: 'left' } }), 'left');
  assert.equal(contract.traySide({ panel: { side: 'nonsense' } }), 'right',
    'an unknown side must fall back rather than reach the drag logic');

  assert.equal(contract.blueprintScale(undefined), contract.DEFAULT_BLUEPRINT_SCALE);
  assert.equal(contract.blueprintScale({ content: {} }), contract.DEFAULT_BLUEPRINT_SCALE);
  assert.equal(contract.blueprintScale({ content: { blueprintScale: 0.75 } }), 0.75);
  for (const bad of [0, -1, 'half', null]) {
    assert.equal(
      contract.blueprintScale({ content: { blueprintScale: bad } }),
      contract.DEFAULT_BLUEPRINT_SCALE,
      `a blueprintScale of ${String(bad)} reached the geometry instead of falling back`
    );
  }

  assert.equal(contract.trayColumns(undefined), 1);
  assert.equal(contract.trayColumns({ content: { layout: 'column', columns: 8 } }), 1);
  assert.equal(contract.trayColumns({ content: { layout: 'grid', columns: 2 } }), 2);
  assert.equal(contract.trayColumns({ content: { layout: 'grid', columns: 0 } }), 1);

  console.log('Tray theme: side and scale always resolve to something the geometry can use.');
}

// The cyberpunk theme is a starting point, but it has to actually exercise the
// contract -- a composition that sets nothing would make the whole slice look
// done while proving nothing.
function assertCyberpunkUsesTheContract() {
  const cyberpunk = cyberpunkTrayComposition;
  const style = contract.trayCompositionToStyle('tray', cyberpunk);

  assert.ok(
    Object.keys(style).length >= 15,
    `cyberpunk set only ${Object.keys(style).length} tray variables; the contract is not being exercised`
  );
  assert.ok(cyberpunk.panel && cyberpunk.panel.side, 'cyberpunk must state which edge the tray enters from');
  assert.ok(cyberpunk.content && cyberpunk.content.blueprintScale, 'cyberpunk must state its blueprint scale');
  assert.ok(cyberpunk.animation && cyberpunk.animation.duration, 'the animation must be a knob, not a constant');

  console.log(`Tray theme: cyberpunk sets ${Object.keys(style).length} variables through the contract.`);
}

// Every variable the CSS reads must be one the contract can produce, and the
// other way round. A `--tray-*` in the stylesheet that nothing sets is a knob
// that does nothing; one the contract sets that no rule reads is the same.
function assertTheCssAndTheContractAgree() {
  const css = fs.readFileSync(CSS, 'utf8');
  const readByCss = new Set(
    [...css.matchAll(/var\(\s*--tray-([a-z0-9-]+)/g)].map((match) => match[1])
  );

  // Every knob the contract can emit, with everything set.
  const everything = contract.trayCompositionToStyle('tray', {
    panel: {
      width: '1px', height: '1px', bottom: '1px', background: 'x', backgroundImage: 'x',
      borderColor: 'x', edgeWidth: '1px', edgeColor: 'x', shadow: 'x', radius: '1px',
      padding: '1px', zIndex: '1',
    },
    animation: { duration: '1ms', easing: 'linear' },
    button: {
      x: '1px', y: '1px', width: '1px', height: '1px', background: 'x', borderColor: 'x',
      borderWidth: '1px', color: 'x', clipPath: 'x', radius: '1px', fontSize: '1px',
      letterSpacing: '1px', glyphSize: '1px', countBackground: 'x', countColor: 'x',
    },
    content: {
      layout: 'grid',
      blueprintScale: 0.5,
      columns: 2,
      gap: '1px',
      paddingTop: '1px',
      ghostOpacity: 0.5,
      ghostGrayscale: 0.5,
      gapSize: '1px',
    },
  });
  const emitted = new Set(Object.keys(everything).map((name) => name.replace('--tray-', '')));

  const deadKnobs = [...emitted].filter((name) => !readByCss.has(name)).sort();
  const unsetVars = [...readByCss].filter((name) => !emitted.has(name)).sort();

  assert.deepEqual(
    deadKnobs,
    [],
    `the contract emits these and no CSS rule reads them, so they are knobs that do nothing: ${deadKnobs.join(', ')}`
  );
  assert.deepEqual(
    unsetVars,
    [],
    `the CSS reads these and the contract cannot set them, so a theme cannot reach them: ${unsetVars.join(', ')}`
  );
  assert.ok(readByCss.size >= 15, 'the stylesheet reads almost no theme variables; this check is measuring nothing');

  console.log(`Tray theme: ${readByCss.size} variables, every one settable by a theme and read by a rule.`);
}

// Every `var(--tray-*)` in the stylesheet needs a fallback, because the default
// theme sets none of them. A variable with no fallback renders as nothing, and
// "nothing" for a width is an invisible tray.
function assertEveryCssVariableHasAFallback() {
  const css = fs.readFileSync(CSS, 'utf8');
  const withoutFallback = [...css.matchAll(/var\(\s*(--tray-[a-z0-9-]+)\s*\)/g)].map((match) => match[1]);

  assert.deepEqual(
    withoutFallback,
    [],
    'these have no fallback, so the default theme renders them as nothing: ' + withoutFallback.join(', ')
  );

  console.log('Tray theme: every variable has a fallback, so the default theme still draws a tray.');
}

// The copy stays out of the theme. This is the check that keeps a knob from
// being added for it later without a conversation.
function assertTheCopyIsNotAThemeKnob() {
  const types = fs.readFileSync(path.join(APP, 'themes', 'trayCompositionTypes.ts'), 'utf8');
  const forbidden = ['label?', 'title?', 'text?', 'emptyText?', 'caption?'];
  const found = forbidden.filter((name) => types.includes(name));
  assert.deepEqual(
    found,
    [],
    `the tray contract has a copy field (${found.join(', ')}). Product language is decided once, `
    + 'not per theme, or the product ends up with a different vocabulary in each one.'
  );

  // And the component must hold the words itself.
  const component = fs.readFileSync(COMPONENT, 'utf8');
  assert.ok(component.includes("'Blueprints'"), 'the tray label must live in the component, not a theme');
  assert.ok(
    !/glyph:\s*'[A-Za-z]/.test(fs.readFileSync(path.join(APP, 'themes', 'cyberpunk', 'trayComposition.ts'), 'utf8')),
    'the theme glyph is decorative; a letter there is copy in disguise'
  );

  console.log('Tray theme: the copy lives in the component, and no theme can rename it.');
}

// Q7 was revised: the persistent in-use mark is the ghost itself, not a second
// accent mechanism. Two signals for one fact drift apart, so guard against the
// old knobs returning.
function assertInUseAccentKnobsAreGone() {
  const types = fs.readFileSync(path.join(APP, 'themes', 'trayCompositionTypes.ts'), 'utf8');
  const theme = fs.readFileSync(path.join(APP, 'themes', 'cyberpunk', 'trayComposition.ts'), 'utf8');
  const component = fs.readFileSync(COMPONENT, 'utf8');

  for (const field of ['inUseAccentColor', 'inUseAccentSize', 'inUseGlow']) {
    assert.ok(!types.includes(field), `the tray theme contract still exposes ${field}`);
    assert.ok(!theme.includes(field), `the cyberpunk tray theme still sets ${field}`);
  }

  assert.ok(!component.includes('data-in-use'), 'the tray still exposes a second in-use state instead of using the ghost');
  assert.ok(component.includes('data-ghost'), 'the tray no longer exposes the ghost state');
  assert.ok(component.includes('ghostsFor'), 'the tray is not using the shared ghost predicate');
  assert.ok(
    component.includes('isGhost && hasInstance'),
    'hover lines must hang off grey ghosts with real instances, not every used blueprint or transient drag ghost'
  );

  console.log('Tray theme: the persistent in-use mark is the ghost, with no accent knobs.');
}

function assertGhostsStillReceivePointerEvents() {
  const css = fs.readFileSync(CSS, 'utf8');
  const ghostBlocks = [...css.matchAll(/\.blueprint-tray-items\s*>\s*\[data-ghost=['"]true['"]\]\s*\{([^}]*)\}/g)]
    .map((match) => match[1]);

  assert.ok(ghostBlocks.length > 0, 'no ghost style block was found; this check is measuring nothing');
  const disabled = ghostBlocks.filter((block) => /pointer-events\s*:\s*none\b/.test(block));
  assert.deepEqual(
    disabled,
    [],
    'a ghost disabled pointer events, so persistent tray ghosts cannot be dragged, reordered, or hovered'
  );

  console.log('Tray theme: ghosts remain interactive; refusal belongs to logic, not CSS.');
}

function main() {
  assertTheEmptyCompositionIsUsable();
  assertTheNonCssFieldsAlwaysResolve();
  assertCyberpunkUsesTheContract();
  assertTheCssAndTheContractAgree();
  assertEveryCssVariableHasAFallback();
  assertTheCopyIsNotAThemeKnob();
  assertInUseAccentKnobsAreGone();
  assertGhostsStillReceivePointerEvents();

  console.log('Tray theme contract validation passed.');
}

main();
