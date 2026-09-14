'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const component = fs.readFileSync(path.join(root, 'app', 'src', 'components', 'AutoModeToggle.tsx'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app', 'src', 'themes', 'cyberpunk', 'components', 'AutoModeToggle.css'), 'utf8');

assert.match(component, /aria-label="Automatic mode"/);
assert.match(component, /aria-pressed=\{enabled\}/);
assert.match(component, /auto-mode-cyber-data">A-01/);
assert.match(component, /<span>AUTO<\/span>[\s\S]*<span>MODE<\/span>/);

assert.match(css, /Cyberpunk AutoModeToggle — Prism Relay/);
assert.match(css, /width:\s*94px/);
assert.match(css, /height:\s*112px/);
assert.match(css, /linear-gradient\(135deg, var\(--toggle-cyan\), var\(--toggle-violet\) 48%, var\(--toggle-magenta\)\)/);
assert.match(css, /auto-mode-on \.auto-mode-cyber-thumb[^}]*translateX\(33px\)/s);
assert.match(css, /@keyframes auto-mode-prism-scan/);
assert.match(css, /@keyframes auto-mode-prism-charge/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);

console.log('auto mode Prism Relay validation passed');
