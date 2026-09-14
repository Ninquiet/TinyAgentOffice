const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function assertFourSidedOutline(source, colorToken, label) {
  for (const offset of ['1px 0', '-1px 0', '0 1px', '0 -1px']) {
    assert.ok(
      source.includes(`drop-shadow(${offset} 0 ${colorToken})`),
      `${label} is missing its ${offset} clipped-edge outline`
    );
  }
}

const socketCss = read('app/src/themes/cyberpunk/components/AgentSocket.css');
const socketComposition = read('app/src/themes/cyberpunk/socketComposition.ts');
const agentSlots = read('app/src/components/AgentSlots.tsx');
const projectManagerSlot = read('app/src/components/ProjectManagerSlot.tsx');
const seniorProSlot = read('app/src/components/SeniorProSlot.tsx');
const autoModeCss = read('app/src/themes/cyberpunk/components/AutoModeToggle.css');
const trayCss = read('app/src/themes/cyberpunk/components/BlueprintTray.css');
const themeCss = read('app/src/themes/cyberpunk/theme.css');

for (const [source, label] of [
  [agentSlots, 'regular agent sockets'],
  [projectManagerSlot, 'Project Manager socket'],
  [seniorProSlot, 'Senior Pro socket'],
]) {
  assert.ok(source.includes('<SocketOutline />'), `${label} must render the shared polygon outline`);
}
assert.ok(
  socketCss.includes('d: var(--socket-form-outline-path)'),
  'Cyberpunk sockets must draw their complete perimeter from the theme-owned polygon path'
);
assert.ok(
  socketCss.includes('stroke: var(--socket-form-outline-color)'),
  'Cyberpunk socket perimeter must use the state-aware outline color'
);
assert.equal(
  (socketComposition.match(/outlinePath:\s*'path\("M /g) || []).length,
  3,
  'Cyberpunk must define a closed outline path for every socket form factor'
);
assert.ok(
  socketComposition.includes("clipPath: 'polygon(18px 0, calc(100% - 58px) 0, calc(100% - 42px) 15px, 100% 15px, 100% 66%, calc(100% - 30px) 100%, 30px 100%, 0 66%, 0 18px)'"),
  'Horizontal sockets must use a symmetric lower trapezoid without a hooked corner'
);
assert.equal(
  (socketComposition.match(/clipPath:\s*'polygon\(0 0, 100% 0, calc\(100% - 16px\) 100%, 16px 100%\)'/g) || []).length,
  3,
  'Every luminous lower jaw must taper symmetrically instead of protruding on the right'
);
assert.ok(
  socketComposition.includes("clipPath: 'polygon(16px 0, calc(100% - 16px) 0, 100% 16px, 100% calc(100% - 20px), calc(100% - 14px) 100%, 14px 100%, 0 calc(100% - 20px), 0 16px)'"),
  'Senior Pro socket must use short symmetric chamfers instead of a pointed lower wedge'
);
assert.ok(
  socketCss.includes('--socket-form-outline-color: var(--socket-state-jaw-color);'),
  'Socket outlines must use the current slot state color without a white wash'
);
assert.ok(
  autoModeCss.includes('linear-gradient(135deg, var(--toggle-cyan), var(--toggle-violet) 48%, var(--toggle-magenta))'),
  'Auto Mode panel must render its complete polygon perimeter as a prism gradient frame'
);
assert.ok(
  autoModeCss.includes('[data-theme="cyberpunk"] .auto-mode-cyber-panel::before'),
  'Auto Mode panel must inset its dark surface so the polygon frame remains visible at every corner'
);
assert.ok(
  trayCss.includes('[data-theme="cyberpunk"] .blueprint-tray-button::before'),
  'Cyberpunk Blueprints button must render an inset surface inside its polygon frame'
);
assert.ok(
  trayCss.includes('linear-gradient(115deg, #22e8ff 0%, #7c6cff 48%, #ff3ad7 100%)'),
  'Cyberpunk Blueprints button must use the shared cyan-to-magenta luminous language'
);
assert.ok(
  !trayCss.includes('drop-shadow(1px 0 0 var(--tray-button-border-color'),
  'Blueprints button must not use clipped directional shadows as its outline'
);
assertFourSidedOutline(themeCss, 'var(--builder-preview-outline)', 'Builder preview');

console.log('Cyberpunk polygon outline validation passed.');
