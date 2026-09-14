'use strict';

const fs = require('fs');
const path = require('path');
const { ProjectPaths, OFFICE_DIR_NAME } = require('./project-paths');
const { generalContextTemplate, agentMemoryInstructionsTemplate } = require('./office-templates');

const APP_ROOT = path.resolve(__dirname, '..', '..');

function utcNow() {
  return new Date().toISOString();
}

function readTemplate(fileName, fallback) {
  const filePath = path.join(APP_ROOT, fileName);
  if (!fs.existsSync(filePath)) return fallback;
  return fs.readFileSync(filePath, 'utf8');
}

function writeIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function ensureAgentMemoryInstructions(filePath) {
  const current = fs.readFileSync(filePath, 'utf8');
  if (/^## Project-Local Agent Memory\s*$/m.test(current)) return false;
  const separator = current.endsWith('\n') ? '\n' : '\n\n';
  fs.appendFileSync(filePath, `${separator}${agentMemoryInstructionsTemplate()}\n`, 'utf8');
  return true;
}

function normalizeProjectRoot(projectRoot) {
  return path.resolve(projectRoot || process.env.TAO_PROJECT_ROOT || process.cwd());
}

class ProjectWorkspace {
  constructor(projectRoot) {
    this.projectRoot = normalizeProjectRoot(projectRoot);
    this.paths = new ProjectPaths(this.projectRoot);
  }

  exists() {
    return fs.existsSync(this.paths.projectFile);
  }

  initialize(options = {}) {
    const createdAt = utcNow();
    fs.mkdirSync(this.paths.officeRoot, { recursive: true });
    fs.mkdirSync(this.paths.coordinationDir, { recursive: true });
    fs.mkdirSync(this.paths.agentMemoryArchiveDir, { recursive: true });
    fs.mkdirSync(this.paths.runtimeDir, { recursive: true });
    fs.mkdirSync(this.paths.attachmentsDir, { recursive: true });
    fs.mkdirSync(this.paths.logsDir, { recursive: true });
    fs.mkdirSync(this.paths.docsDir, { recursive: true });

    writeIfMissing(this.paths.projectFile, `${JSON.stringify({
      schemaVersion: 1,
      app: 'TinyAgentOffice',
      projectRoot: this.projectRoot,
      officeDirName: OFFICE_DIR_NAME,
      createdAt,
      updatedAt: createdAt,
    }, null, 2)}\n`);

    writeIfMissing(this.paths.agentsFile, readTemplate('AGENTS.md', [
      '# TinyAgentOffice Agents',
      '',
      'Read this file before taking work. Use the TinyAgentOffice coordination CLI.',
      '',
    ].join('\n')));
    // Existing offices predate cartridge memory. Preserve their project rules
    // and append only the missing managed section instead of replacing the file.
    ensureAgentMemoryInstructions(this.paths.agentsFile);

    writeIfMissing(this.paths.principlesFile, readTemplate('agents-principles.md', [
      '# Agent Principles',
      '',
      '- Use the coordination CLI instead of editing JSON by hand.',
      '- Keep responses brief unless detail is requested.',
      '',
    ].join('\n')));

    // Never seeded by copying a file from the application repository: doing that
    // handed every new project the application's own project memory. The skeleton
    // lives in code, in office-templates.js, and is the same one the dashboard
    // writes when it bootstraps a missing context.
    writeIfMissing(this.paths.generalContextFile, `${generalContextTemplate()}\n`);

    if (options.seedLegacyState) {
      writeIfMissing(this.paths.tasksFile, options.seedLegacyState.tasks || '');
      writeIfMissing(this.paths.registryFile, options.seedLegacyState.registry || '');
    }

    return this;
  }

  runtimeOptions(extra = {}) {
    return {
      ...extra,
      projectRoot: this.projectRoot,
      tasksPath: extra.tasksPath || this.paths.tasksFile,
      registryPath: extra.registryPath || this.paths.registryFile,
      dbPath: extra.dbPath || this.paths.runtimeDbFile,
      runsPath: extra.runsPath || this.paths.runsFile,
    };
  }
}

let activeWorkspace = null;

function configureProjectWorkspace(projectRoot, options = {}) {
  activeWorkspace = new ProjectWorkspace(projectRoot);
  if (options.initialize !== false) activeWorkspace.initialize(options);
  process.env.TAO_PROJECT_ROOT = activeWorkspace.projectRoot;
  return activeWorkspace;
}

function getActiveProjectWorkspace() {
  if (!activeWorkspace) {
    activeWorkspace = new ProjectWorkspace(process.env.TAO_PROJECT_ROOT || process.cwd());
    if (process.env.TAO_AUTO_INIT_PROJECT !== '0') activeWorkspace.initialize();
  }
  return activeWorkspace;
}

module.exports = {
  APP_ROOT,
  ProjectWorkspace,
  configureProjectWorkspace,
  getActiveProjectWorkspace,
  normalizeProjectRoot,
};
