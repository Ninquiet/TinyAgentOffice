'use strict';

// The project chooser is the one screen that can render before the dashboard
// theme machinery exists. Its dark presentation must therefore belong to the
// start window itself, and the recent-project list must be the only part that
// scrolls when history is long.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', '..', 'app', 'src');
const CSS = path.join(APP, 'styles', 'start-window.css');
const COMPONENT = path.join(APP, 'components', 'StartWindow.tsx');

function blockFor(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS block for ${selector}`);
  return match[1];
}

function assertStartWindowOwnsItsDarkPalette() {
  const css = fs.readFileSync(CSS, 'utf8');
  const startWindow = blockFor(css, '.start-window');
  const startCard = blockFor(css, '.start-card');

  assert.ok(
    /#[0-9a-f]{6}/i.test(startWindow) && /#030615|#040817|#050816|#07101f/i.test(startWindow),
    'the base start window must declare a dark background, not wait for a dashboard theme selector'
  );
  assert.ok(
    /height\s*:\s*100vh\b/.test(startWindow) && /box-sizing\s*:\s*border-box\b/.test(startWindow),
    'the start window must include its padding inside the viewport instead of creating page-level scroll'
  );
  assert.ok(
    css.includes('html.start-window-active body'),
    'the start window must override the global 950px shell only while the chooser is mounted'
  );
  assert.ok(
    fs.readFileSync(COMPONENT, 'utf8').includes("document.documentElement.classList.add('start-window-active')"),
    'StartWindow must write the start-window-active shell class on mount'
  );
  assert.ok(
    /color\s*:\s*#[0-9a-f]{6}/i.test(startWindow) && !/#0f172a|#172033/i.test(startWindow),
    'the base start window text color must be light, not the old light-theme fallback'
  );
  assert.ok(
    /background\s*:[^;]*rgba\(\s*[0-9]+\s*,\s*[0-9]+\s*,\s*[0-9]+\s*,\s*0\.[0-9]+/i.test(startCard),
    'the base card must use its own dark translucent panel'
  );
  assert.ok(
    !/\[data-theme=['"]cyberpunk['"]\]\s+\.start-/i.test(css),
    'the start window must not depend on the dashboard cyberpunk theme selector'
  );
  assert.ok(
    !/var\(--app-bg,\s*#f3f6f8\)/i.test(css),
    'the start window still falls back to the old white app background'
  );

  console.log('Start window: dark palette is local to the chooser, not inherited from dashboard theme state.');
}

function assertRecentProjectsAreTheOnlyScrollableArea() {
  const css = fs.readFileSync(CSS, 'utf8');
  const startCard = blockFor(css, '.start-card');
  const recentProjects = blockFor(css, '.recent-projects');
  const recentProjectList = blockFor(css, '.recent-project-list');

  assert.ok(
    /max-height\s*:\s*calc\(\s*100vh\s*-/.test(startCard),
    'the card needs a viewport-bound max-height so it cannot grow the window'
  );
  assert.ok(
    /overflow\s*:\s*hidden\b/.test(startCard),
    'the card should clip its own box; scrolling belongs to the recent-project list'
  );
  assert.ok(
    /min-height\s*:\s*0\b/.test(recentProjects),
    'the recent-projects section needs min-height: 0 so its child can shrink and scroll'
  );
  assert.ok(
    /max-height\s*:/.test(recentProjectList),
    'the recent-project list needs an explicit height limit'
  );
  assert.ok(
    /overflow-y\s*:\s*auto\b/.test(recentProjectList),
    'the recent-project list, and only that list, must scroll vertically'
  );
  assert.ok(
    !/overflow-y\s*:\s*auto\b/.test(startCard),
    'the card itself must not scroll; header and controls have to stay fixed'
  );

  console.log('Start window: recent projects are bounded in their own vertical scroller.');
}

function assertKeyboardFocusRemainsVisible() {
  const css = fs.readFileSync(CSS, 'utf8');
  const component = fs.readFileSync(COMPONENT, 'utf8');

  assert.ok(
    /\.recent-project:focus-visible\s*\{[^}]*outline\s*:/s.test(css),
    'recent project buttons need a visible focus outline for keyboard navigation'
  );
  assert.ok(
    /\.start-(?:primary-button|close-button|path-row)[^{]*:focus-visible/s.test(css)
    || /:where\([^)]*start-primary-button[^)]*start-close-button[^)]*start-path-row[^)]*\):focus-visible/s.test(css),
    'fixed chooser controls need visible focus styles too'
  );
  assert.ok(
    component.includes('className="recent-project-list"'),
    'recent buttons must remain inside the bounded list that receives native focus scrolling'
  );

  console.log('Start window: keyboard focus has visible styling inside and outside the recent list.');
}

function assertAuthorCreditIsVisibleAndSafe() {
  const css = fs.readFileSync(CSS, 'utf8');
  const component = fs.readFileSync(COMPONENT, 'utf8');
  const desktopApi = fs.readFileSync(path.join(APP, 'desktop-api.ts'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'preload.cjs'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'main.cjs'), 'utf8');

  assert.ok(component.includes('Creado por Jesus David Angarita'), 'the chooser must display the requested author credit');
  assert.ok(component.includes('https://www.linkedin.com/in/ninquiet/'), 'the author credit must target the requested LinkedIn profile');
  assert.ok(component.includes('aria-label="LinkedIn de Jesus David Angarita"'), 'the LinkedIn icon needs an accessible label');
  assert.ok(/\.start-author-credit\s*\{/.test(css), 'the author credit needs a dedicated layout rule');
  assert.ok(desktopApi.includes('openExternal'), 'the renderer API must expose safe external-link opening');
  assert.ok(preload.includes("ipcRenderer.invoke('desktop:open-external'"), 'the preload must bridge external links through IPC');
  assert.ok(main.includes("ipcMain.handle('desktop:open-external'"), 'the Electron main process must own external navigation');
  assert.ok(main.includes('shell.openExternal'), 'external URLs must open in the system browser');

  console.log('Start window: author credit is visible and LinkedIn opens through the desktop shell.');
}

function main() {
  assertStartWindowOwnsItsDarkPalette();
  assertRecentProjectsAreTheOnlyScrollableArea();
  assertKeyboardFocusRemainsVisible();
  assertAuthorCreditIsVisibleAndSafe();
  console.log('Start window validation passed.');
}

main();
