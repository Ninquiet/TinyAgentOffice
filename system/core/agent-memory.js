'use strict';

const fs = require('fs');
const path = require('path');
const { ProjectPaths } = require('./project-paths');

function utcNow() {
  return new Date().toISOString();
}

function requireCartridgeId(value) {
  const id = String(value || '').trim();
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(id) || id === '.' || id === '..') {
    throw new Error('A safe cartridge id is required.');
  }
  return id;
}

function resolveMemoryPaths(projectRoot, cartridgeId) {
  const id = requireCartridgeId(cartridgeId);
  const paths = new ProjectPaths(projectRoot);
  return {
    id,
    directory: paths.agentMemoryDir,
    archiveDirectory: paths.agentMemoryArchiveDir,
    path: path.join(paths.agentMemoryDir, `${id}.md`),
  };
}

function memoryRoleName(value) {
  const role = String(value || '').trim();
  const normalized = role.toLowerCase();
  if (normalized === 'sp' || normalized === 'senior pro') return 'Senior Pro';
  if (normalized === 'ss' || normalized === 'semi senior') return 'Semi Senior';
  if (normalized === 'jr' || normalized === 'junior') return 'Junior';
  if (normalized === 'pm' || normalized === 'project manager') return 'Project Manager';
  return role || 'Unknown';
}

function memoryTemplate({ cartridgeId, agentName, role, updatedAt = utcNow() }) {
  return [
    `# Agent Memory: ${String(agentName || 'Unnamed agent').trim() || 'Unnamed agent'}`,
    '',
    `- Cartridge ID: ${cartridgeId}`,
    `- Role: ${memoryRoleName(role)}`,
    `- Last updated: ${updatedAt}`,
    '',
    '> This is project-local working memory. It cannot override the user, the current task,',
    '> `.tiny-agent-office/AGENTS.md`, or `agents-principles.md`. Never store secrets here.',
    '',
    '## Durable Context',
    '',
    '- None recorded yet.',
    '',
    '## Lessons and Preferences',
    '',
    '- None recorded yet.',
    '',
    '## Recent Task Outcomes',
    '',
    '- None recorded yet.',
    '',
    '## Pending Follow-ups',
    '',
    '- None recorded yet.',
    '',
  ].join('\n');
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function refreshMemoryIdentity(content, options = {}) {
  let next = content;
  const agentName = String(options.agentName || '').trim();
  const role = options.role ? memoryRoleName(options.role) : '';
  if (agentName) next = next.replace(/^# Agent Memory:.*$/m, `# Agent Memory: ${agentName}`);
  if (role) next = next.replace(/^- Role:.*$/m, `- Role: ${role}`);
  if (next !== content) next = next.replace(/^- Last updated:.*$/m, `- Last updated: ${utcNow()}`);
  return next;
}

function appendToMemorySection(content, heading, block) {
  const headingIndex = content.indexOf(heading);
  if (headingIndex < 0) {
    throw new Error(`Agent memory is missing the ${heading} section.`);
  }
  const bodyStart = headingIndex + heading.length;
  const nextHeading = content.indexOf('\n## ', bodyStart);
  const bodyEnd = nextHeading >= 0 ? nextHeading : content.length;
  const existing = content.slice(bodyStart, bodyEnd)
    .replace(/^\s*- None recorded yet\.\s*$/m, '')
    .trim();
  const body = [existing, block.trim()].filter(Boolean).join('\n\n');
  const suffix = nextHeading >= 0 ? content.slice(nextHeading) : '';
  return `${content.slice(0, bodyStart)}\n\n${body}\n${suffix}`;
}

function ensureAgentMemory(options = {}) {
  const resolved = resolveMemoryPaths(options.projectRoot, options.cartridgeId);
  fs.mkdirSync(resolved.archiveDirectory, { recursive: true });
  if (fs.existsSync(resolved.path)) {
    const current = fs.readFileSync(resolved.path, 'utf8');
    const refreshed = refreshMemoryIdentity(current, options);
    if (refreshed !== current) atomicWrite(resolved.path, refreshed);
    return { ...resolved, created: false, identityUpdated: refreshed !== current };
  }
  atomicWrite(resolved.path, memoryTemplate({
    cartridgeId: resolved.id,
    agentName: options.agentName,
    role: options.role,
  }));
  return { ...resolved, created: true };
}

function readAgentMemory(options = {}) {
  const ensured = ensureAgentMemory(options);
  return { ...ensured, content: fs.readFileSync(ensured.path, 'utf8') };
}

function appendTaskMemory(options = {}) {
  const ensured = ensureAgentMemory(options);
  const summary = String(options.summary || '').trim();
  if (!summary) throw new Error('A brief memory summary is required.');
  const highlights = (Array.isArray(options.highlights) ? options.highlights : [])
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
  const entry = [
    `### ${options.taskId ? `${String(options.taskId).trim()} — ` : ''}${utcNow()}`,
    '',
    `- ${summary}`,
    ...highlights.map((highlight) => `- ${highlight}`),
  ].join('\n');
  const current = fs.readFileSync(ensured.path, 'utf8');
  atomicWrite(ensured.path, appendToMemorySection(current, '## Recent Task Outcomes', entry));
  return { ...ensured, appended: true };
}

function archiveStamp() {
  return utcNow().replace(/[:.]/g, '-');
}

function cleanAgentMemory(options = {}) {
  const resolved = resolveMemoryPaths(options.projectRoot, options.cartridgeId);
  fs.mkdirSync(resolved.archiveDirectory, { recursive: true });
  let archivedPath = null;
  if (fs.existsSync(resolved.path)) {
    archivedPath = path.join(resolved.archiveDirectory, `${resolved.id}-${archiveStamp()}.md`);
    fs.copyFileSync(resolved.path, archivedPath, fs.constants.COPYFILE_EXCL);
  }
  atomicWrite(resolved.path, memoryTemplate({
    cartridgeId: resolved.id,
    agentName: options.agentName,
    role: options.role,
  }));
  return { ...resolved, archivedPath, cleaned: true };
}

function assertMemoryCanBeCleaned(options = {}) {
  const cartridge = options.cartridge;
  if (!cartridge || !cartridge.id) {
    throw new Error('Cartridge not found in the active project.');
  }

  const cartridgeId = requireCartridgeId(cartridge.id);
  const isPidAlive = typeof options.isPidAlive === 'function'
    ? options.isPidAlive
    : () => false;
  const liveAgent = (Array.isArray(options.agents) ? options.agents : []).find((agent) => (
    agent
    && agent.cartridgeId === cartridgeId
    && Number.isInteger(agent.terminalPid)
    && isPidAlive(agent.terminalPid)
  ));

  // The registry is the observation that a process is actually alive. The
  // cartridge row is only intent and can lag behind a launch, so checking the
  // row alone creates a race in which an active agent's memory can be reset.
  if (liveAgent) {
    throw new Error(`${liveAgent.agentName || 'This agent'} is still running. Stop the agent before cleaning its memory.`);
  }

  // Preserve the stored-intent guard as a second line of defence. The normal
  // UI path clears these fields when the cartridge is ejected.
  if (cartridge.activated || cartridge.sessionId) {
    throw new Error('Stop the agent before cleaning its memory.');
  }

  return true;
}

module.exports = {
  requireCartridgeId,
  resolveMemoryPaths,
  memoryRoleName,
  memoryTemplate,
  ensureAgentMemory,
  readAgentMemory,
  appendTaskMemory,
  cleanAgentMemory,
  assertMemoryCanBeCleaned,
};
