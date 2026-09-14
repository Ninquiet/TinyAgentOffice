'use strict';

const fs = require('fs');
const path = require('path');
const { APP_ROOT } = require('./project-workspace');

const RECENT_PROJECTS_PATH = path.join(APP_ROOT, 'runtime', 'recent-projects.json');
const MAX_RECENT_PROJECTS = 12;

function utcNow() {
  return new Date().toISOString();
}

function readRecentProjects() {
  if (!fs.existsSync(RECENT_PROJECTS_PATH)) {
    return { schemaVersion: 1, projects: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(RECENT_PROJECTS_PATH, 'utf8'));
    return {
      schemaVersion: 1,
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
    };
  } catch (_) {
    return { schemaVersion: 1, projects: [] };
  }
}

function writeRecentProjects(store) {
  fs.mkdirSync(path.dirname(RECENT_PROJECTS_PATH), { recursive: true });
  fs.writeFileSync(RECENT_PROJECTS_PATH, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function projectName(projectRoot) {
  return path.basename(path.resolve(projectRoot));
}

function rememberProject(projectRoot) {
  const root = path.resolve(projectRoot);
  const store = readRecentProjects();
  const now = utcNow();
  const projects = [
    {
      root,
      name: projectName(root),
      openedAt: now,
    },
    ...store.projects.filter((entry) => path.resolve(entry.root || '.') !== root),
  ].slice(0, MAX_RECENT_PROJECTS);
  const next = { schemaVersion: 1, updatedAt: now, projects };
  writeRecentProjects(next);
  return next;
}

module.exports = {
  RECENT_PROJECTS_PATH,
  readRecentProjects,
  rememberProject,
};
