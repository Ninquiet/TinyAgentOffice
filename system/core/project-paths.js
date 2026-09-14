'use strict';

const path = require('path');

const OFFICE_DIR_NAME = '.tiny-agent-office';

class ProjectPaths {
  constructor(projectRoot) {
    if (!projectRoot) throw new Error('Project root is required.');
    this.projectRoot = path.resolve(projectRoot);
    this.officeRoot = path.join(this.projectRoot, OFFICE_DIR_NAME);
    this.projectFile = path.join(this.officeRoot, 'project.json');
    this.agentsFile = path.join(this.officeRoot, 'AGENTS.md');
    this.principlesFile = path.join(this.officeRoot, 'agents-principles.md');
    this.generalContextFile = path.join(this.officeRoot, 'general-context.md');
    this.agentMemoryDir = path.join(this.officeRoot, 'agent-memory');
    this.agentMemoryArchiveDir = path.join(this.agentMemoryDir, 'archive');
    this.coordinationDir = path.join(this.officeRoot, 'coordination');
    this.tasksFile = path.join(this.coordinationDir, 'tasks.json');
    this.registryFile = path.join(this.coordinationDir, 'agents.json');
    this.runtimeDbFile = path.join(this.coordinationDir, 'runtime.db');
    this.runsFile = path.join(this.coordinationDir, 'runs.json');
    this.daemonFleetFile = path.join(this.coordinationDir, 'daemon-fleet.json');
    this.runtimeDir = path.join(this.officeRoot, 'runtime');
    this.attachmentsDir = path.join(this.runtimeDir, 'attachments');
    this.logsDir = path.join(this.runtimeDir, 'logs');
    this.docsDir = path.join(this.officeRoot, 'docs');
  }

  relative(filePath) {
    return path.relative(this.projectRoot, filePath).replace(/\\/g, '/');
  }

  resolveProjectPath(filePath) {
    if (!filePath) return filePath;
    return path.isAbsolute(filePath)
      ? path.normalize(filePath)
      : path.resolve(this.projectRoot, filePath);
  }
}

module.exports = {
  OFFICE_DIR_NAME,
  ProjectPaths,
};
