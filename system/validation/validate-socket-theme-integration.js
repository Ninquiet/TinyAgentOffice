'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(ROOT, 'app', 'src');

const APP_COMPONENT = path.join(APP, 'App.tsx');
const AGENT_SLOTS = path.join(APP, 'components', 'AgentSlots.tsx');
const PM_SLOT = path.join(APP, 'components', 'ProjectManagerSlot.tsx');
const SP_SLOT = path.join(APP, 'components', 'SeniorProSlot.tsx');
const THEME_HOOK = path.join(APP, 'hooks', 'useDashboardThemes.ts');
const INDEX_HTML = path.join(ROOT, 'app', 'index.html');
const THEME_SERVICE = path.join(ROOT, 'system', 'dashboard', 'theme-service.js');
const THEME_CSS = path.join(APP, 'themes', 'cyberpunk', 'theme.css');
const SOCKET_CSS = path.join(APP, 'themes', 'cyberpunk', 'components', 'AgentSocket.css');
const SOCKET_REGISTRY = path.join(APP, 'themes', 'socketCompositions.ts');
const SOCKET_CONTRACT = path.join(APP, 'themes', 'socketCompositionTypes.ts');
const DEFAULT_SOCKET = path.join(APP, 'themes', 'default', 'socketComposition.ts');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function assertIncludes(source, needle, message) {
  assert.ok(source.includes(needle), message || `Expected ${needle}`);
}

function assertNoBroadCyberpunkSlotOverrides() {
  const css = read(THEME_CSS);
  assertIncludes(css, "@import './components/AgentSocket.css';", 'cyberpunk theme must import component-owned socket CSS');
  assert.ok(
    !/\[data-theme="cyberpunk"\]\s+\.agent-slot\b/.test(css),
    'Cyberpunk socket visuals must not live as broad .agent-slot overrides in theme.css'
  );
}

function assertSocketCompositionIsMounted() {
  const app = read(APP_COMPONENT);
  assertIncludes(app, 'socketCompositionToStyle', 'App must import and call socketCompositionToStyle');
  assertIncludes(app, 'getThemeSocketComposition', 'App must read socket composition from the theme registry');
  assert.ok(
    /style=\{socketThemeStyle\}/.test(app),
    'App must mount the returned socket CSS variables on the dashboard shell'
  );
}

function assertThemeDefaulting() {
  const service = read(THEME_SERVICE);
  assertIncludes(service, "const DEFAULT_THEME_ID = 'cyberpunk';", 'server default theme must be cyberpunk');

  const hook = read(THEME_HOOK);
  assertIncludes(hook, "FALLBACK_THEME_ID = 'cyberpunk'", 'client initial fallback must be cyberpunk');
  assertIncludes(hook, 'window.localStorage.getItem(THEME_STORAGE_KEY) || FALLBACK_THEME_ID',
    'client must start on cyberpunk only when no preference exists');
  assertIncludes(hook, 'useLayoutEffect', 'theme must be applied before socket geometry is measured');
  assert.ok(
    !hook.includes("theme?.id || 'default'"),
    'theme loading must not temporarily force the classic theme before cyberpunk is available'
  );
  assertIncludes(read(INDEX_HTML), 'data-theme="cyberpunk"', 'the pre-React document must start in cyberpunk');
  assertIncludes(hook, 'response.defaultThemeId',
    'invalid saved preferences must fall back to the server default');
}

function assertCloseDialogUsesCyberpunkContrast() {
  const css = read(THEME_CSS);
  assertIncludes(css, '[data-theme="cyberpunk"] .close-app-dialog,', 'close dialog must use the cyberpunk panel surface');
  assertIncludes(css, '[data-theme="cyberpunk"] .close-app-dialog header,', 'close dialog header must not keep the light warning surface');
  assertIncludes(css, '[data-theme="cyberpunk"] .close-app-dialog-actions button', 'close dialog actions need theme-owned contrast');
}

function assertEveryInstalledThemeDeclaresSocketVariant() {
  const registry = read(SOCKET_REGISTRY);
  assert.ok(!/default:\s*\{\s*\}/.test(registry), 'default installed theme must declare a socket variant');
  assertIncludes(registry, 'defaultSocketComposition', 'default socket composition must be registered');
  assert.ok(fs.existsSync(DEFAULT_SOCKET), 'default socket composition file is missing');
  assertIncludes(read(DEFAULT_SOCKET), "variantId: 'default-classic'", 'default theme must name its own socket variant');
}

function assertSocketCssUsesTheContract() {
  assert.ok(fs.existsSync(SOCKET_CSS), 'component-owned Cyberpunk socket CSS is missing');
  const css = read(SOCKET_CSS);
  for (const token of [
    '--socket-regular-clip-path',
    '--socket-regular-width',
    '--socket-regular-height',
    '--socket-project-manager-clip-path',
    '--socket-project-manager-width',
    '--socket-project-manager-height',
    '--socket-senior-pro-clip-path',
    '--socket-senior-pro-width',
    '--socket-senior-pro-height',
    '--socket-regular-jaw-background',
    '--socket-state-jaw-color',
    '--socket-state-port-background',
    '--socket-senior-pro-control-inset',
  ]) {
    assertIncludes(css, token, `socket CSS must read ${token}`);
  }
  for (const visual of ['.agent-slot::before', '.agent-slot::after', '.slot-port', '.slot-pin']) {
    assertIncludes(css, visual, `socket CSS must style ${visual}`);
  }
  assert.ok(!css.includes('ERASEME'), 'production socket CSS must not depend on disposable prototypes');
}

function extractRule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `socket CSS is missing ${selector}`);
  return match[1];
}

function assertLuminousJawKeepsPrototypeDetails() {
  const css = read(SOCKET_CSS);
  const cyberpunkComposition = read(path.join(APP, 'themes', 'cyberpunk', 'socketComposition.ts'));
  const socketRule = extractRule(css, '[data-theme="cyberpunk"] .agent-slot');
  const railRule = extractRule(css, '[data-theme="cyberpunk"] .slot-rail');
  const portRule = extractRule(css, '[data-theme="cyberpunk"] .slot-port');
  const pinRule = extractRule(css, '[data-theme="cyberpunk"] .slot-pin');
  const projectManagerRule = extractRule(css, '[data-theme="cyberpunk"] .project-manager-slot');
  const seniorProRule = extractRule(css, '[data-theme="cyberpunk"] .senior-pro-slot');
  const focusRule = extractRule(
    css,
    '[data-theme="cyberpunk"] .agent-slot:hover,\n[data-theme="cyberpunk"] .agent-slot:focus-within'
  );

  assertIncludes(
    socketRule,
    '--socket-state-shadow: var(--socket-empty-shadow, var(--socket-form-shadow));',
    'empty Luminous Jaw sockets must use the prototype shell shadow once'
  );
  assertIncludes(socketRule, 'box-shadow: var(--socket-state-shadow);',
    'Luminous Jaw must not stack a duplicate form shadow');
  assertIncludes(railRule, 'background: rgba(2, 6, 23, 0.86);',
    'Luminous Jaw rails must keep the dark prototype surface');
  assertIncludes(railRule, 'box-shadow: none;',
    'Luminous Jaw rails must not add a glow absent from the prototype');
  assertIncludes(portRule, 'box-shadow: none;',
    'Luminous Jaw port must not add a glow absent from the prototype');
  assertIncludes(pinRule, 'background: linear-gradient(180deg, #fff1a8, #d97706);',
    'Luminous Jaw pins must use the prototype gold gradient');
  assertIncludes(pinRule, 'box-shadow: none;',
    'Luminous Jaw pins must not add a glow absent from the prototype');
  assert.ok(
    !focusRule.includes('--socket-state-jaw-color:'),
    'hover and keyboard focus must preserve the connected/active/attention state color'
  );
  assertIncludes(focusRule, '--socket-state-filter: var(--socket-focus-filter, saturate(1.18) brightness(1.08));',
    'hover and keyboard focus must apply the selected prototype filter');
  assert.ok(
    !css.includes('var(--socket-state-jaw-color) 0 7px, transparent 7px 15px'),
    'Luminous Jaw must not render hard alternating cyan and magenta blocks'
  );
  assertIncludes(
    css,
    'color-mix(in srgb, var(--socket-magenta) 50%, var(--socket-state-jaw-color))',
    'Luminous Jaw must blend smoothly through a midpoint between its state colors'
  );
  assert.ok(
    !cyberpunkComposition.includes('var(--socket-state-jaw-color)'),
    'ancestor-mounted theme values must not depend on a state variable defined only by each socket'
  );
  for (const [name, rule] of [
    ['Project Manager', projectManagerRule],
    ['Senior Pro', seniorProRule],
  ]) {
    assertIncludes(rule, 'var(--socket-luminous-jaw-background)',
      `${name} must fall back to the local luminous jaw layer`);
    assertIncludes(rule, 'var(--socket-luminous-hinge-background)',
      `${name} must fall back to the local luminous hinge layer`);
  }

  assertIncludes(css, 'd: var(--socket-form-outline-path);',
    'Luminous Jaw must draw the exact theme-owned polygon perimeter');
  assertIncludes(css, 'stroke: var(--socket-form-outline-color);',
    'Luminous Jaw must color the whole polygon perimeter consistently');
  assertIncludes(socketRule, 'border: 1px solid var(--socket-form-outline-color);',
    'the clipped shell border must reinforce the same state color as the SVG perimeter');
  assertIncludes(css, 'vector-effect: non-scaling-stroke;',
    'Luminous Jaw must keep its outline thickness across every form factor');
  assert.ok(
    !css.includes('drop-shadow(1px 0 0 var(--socket-form-outline-color))'),
    'Luminous Jaw must not regress to clipped directional shadows for its outline'
  );
}

function assertSocketMarkupAndStatesSurvive() {
  for (const [name, file] of [
    ['regular', AGENT_SLOTS],
    ['project manager', PM_SLOT],
    ['senior pro', SP_SLOT],
  ]) {
    const source = read(file);
    assertIncludes(source, 'slot-port', `${name} socket must preserve .slot-port for drag/drop geometry`);
    assertIncludes(source, 'data-slot-state', `${name} socket must expose a theme-readable state`);
    assertIncludes(source, 'agent-slot-attention', `${name} socket must expose attention state`);
    assertIncludes(source, 'hasClaimableTasks', `${name} socket must produce attention from existing data`);
  }

  assertIncludes(read(PM_SLOT), 'pm-new-task-button', 'Project Manager New Task button must remain');
  assertIncludes(read(SP_SLOT), 'senior-pro-slot', 'Senior Pro vertical socket class must remain');
}

function assertContractCanEmitEveryCssVariable() {
  const contract = require(SOCKET_CONTRACT);
  const full = contract.socketCompositionToStyle('socket', {
    regular: {
      width: '1px',
      height: '1px',
      clipPath: 'x',
      outlinePath: 'path("M 0 0 Z")',
      background: 'x',
      borderColor: 'x',
      shadow: 'x',
      jaw: { x: '1px', y: '1px', height: '1px', background: 'x', clipPath: 'x', shadow: 'x' },
      hinge: { y: '1px', width: '1px', background: 'x', shadow: 'x' },
      port: { width: '1px', height: '1px', radius: '0', borderColor: 'x' },
    },
    projectManager: {
      width: '1px',
      height: '1px',
      clipPath: 'x',
      outlinePath: 'path("M 0 0 Z")',
      background: 'x',
      borderColor: 'x',
      shadow: 'x',
      jaw: { x: '1px', y: '1px', height: '1px', background: 'x', clipPath: 'x', shadow: 'x' },
      hinge: { y: '1px', width: '1px', background: 'x', shadow: 'x' },
      port: { width: '1px', height: '1px', radius: '0', borderColor: 'x' },
    },
    seniorPro: {
      width: '1px',
      height: '1px',
      clipPath: 'x',
      outlinePath: 'path("M 0 0 Z")',
      background: 'x',
      borderColor: 'x',
      shadow: 'x',
      controlInset: '1px',
      controlJustify: 'end',
      controlWidth: '1px',
      controlMinWidth: '1px',
      controlPadding: '1px',
      controlFontSize: '1px',
      jaw: { x: '1px', y: '1px', height: '1px', background: 'x', clipPath: 'x', shadow: 'x' },
      hinge: { y: '1px', width: '1px', background: 'x', shadow: 'x' },
      port: { width: '1px', height: '1px', radius: '0', borderColor: 'x' },
    },
    empty: { jawColor: 'x', railColor: 'x', portBackground: 'x', shadow: 'x', filter: 'x' },
    connected: { jawColor: 'x', railColor: 'x', portBackground: 'x', shadow: 'x', filter: 'x' },
    active: { jawColor: 'x', railColor: 'x', portBackground: 'x', shadow: 'x', filter: 'x' },
    attention: { jawColor: 'x', railColor: 'x', portBackground: 'x', shadow: 'x', filter: 'x' },
    focus: { jawColor: 'x', railColor: 'x', shadow: 'x', filter: 'x' },
  });

  const css = read(SOCKET_CSS);
  const readByCss = new Set([...css.matchAll(/var\(\s*(--socket-[a-z0-9-]+)/g)].map((match) => match[1]));
  const emitted = new Set(Object.keys(full));
  const unsetVars = [...readByCss].filter((name) => (
    !emitted.has(name)
    && !name.startsWith('--socket-form-')
    && !name.startsWith('--socket-state-')
    && !name.startsWith('--socket-luminous-')
    && name !== '--socket-magenta'
  )).sort();

  assert.deepEqual(unsetVars, [], `socket CSS reads variables the contract cannot emit: ${unsetVars.join(', ')}`);
  assert.ok(readByCss.size >= 20, 'socket CSS reads too few contract variables; this check is measuring nothing');
}

function main() {
  assertSocketCompositionIsMounted();
  assertThemeDefaulting();
  assertCloseDialogUsesCyberpunkContrast();
  assertEveryInstalledThemeDeclaresSocketVariant();
  assertNoBroadCyberpunkSlotOverrides();
  assertSocketCssUsesTheContract();
  assertLuminousJawKeepsPrototypeDetails();
  assertSocketMarkupAndStatesSurvive();
  assertContractCanEmitEveryCssVariable();

  console.log('Socket theme integration validation passed.');
}

main();
