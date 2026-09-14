'use strict';

const fs = require('fs');
const path = require('path');

const THEMES_DIR = path.resolve(__dirname, '..', '..', 'app', 'src', 'themes');
const DEFAULT_THEME_ID = 'cyberpunk';

function readThemeFile(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Theme file ${path.basename(filePath)} is not an object.`);
  }
  if (!parsed.id || typeof parsed.id !== 'string') {
    throw new Error(`Theme file ${path.basename(filePath)} is missing an id.`);
  }
  if (!parsed.name || typeof parsed.name !== 'string') {
    throw new Error(`Theme ${parsed.id} is missing a name.`);
  }
  if (!parsed.cssVariables || typeof parsed.cssVariables !== 'object' || Array.isArray(parsed.cssVariables)) {
    throw new Error(`Theme ${parsed.id} is missing cssVariables.`);
  }
  return {
    id: parsed.id,
    name: parsed.name,
    description: parsed.description || '',
    cssVariables: Object.fromEntries(
      Object.entries(parsed.cssVariables)
        .filter(([key, value]) => key.startsWith('--') && typeof value === 'string'),
    ),
  };
}

function listThemes() {
  const themes = fs.readdirSync(THEMES_DIR)
    .map((entryName) => path.join(THEMES_DIR, entryName))
    .filter((entryPath) => fs.statSync(entryPath).isDirectory())
    .map((themeDir) => readThemeFile(path.join(themeDir, 'theme.json')))
    .sort((a, b) => {
      if (a.id === DEFAULT_THEME_ID) return -1;
      if (b.id === DEFAULT_THEME_ID) return 1;
      return a.name.localeCompare(b.name);
    });

  if (!themes.some((theme) => theme.id === DEFAULT_THEME_ID)) {
    throw new Error('Default theme is missing.');
  }

  return {
    defaultThemeId: DEFAULT_THEME_ID,
    themes,
  };
}

module.exports = {
  DEFAULT_THEME_ID,
  THEMES_DIR,
  listThemes,
};
