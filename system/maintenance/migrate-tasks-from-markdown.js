'use strict';

const fs = require('fs');
const path = require('path');

const { APP_ROOT } = require('../core/project-workspace');

const WORKSPACE_ROOT = APP_ROOT;
const TASK_HEADING_RE = /^(#{3,4})\s+(TASK-\S+|NEXT-\S+)\s+\[([A-Z_]+)\]\s+(.+)$/;
const FIELD_RE = /^\s*([^:]+):\s*(.*)$/;
const VALID_SECTIONS = new Set(['active', 'nextTodo', 'history']);

function readLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
}

function detectSection(line, currentSection) {
  if (/^##\s+Active Tasks\s*$/i.test(line)) return 'active';
  if (/^##\s+Next-Todo\s*$/i.test(line)) return 'nextTodo';
  if (/^##\s+Recent Batch History\s*$/i.test(line)) return 'history';
  if (/^##\s+Coordination History\s*$/i.test(line)) return 'history';
  if (/^##\s+/.test(line) && VALID_SECTIONS.has(currentSection)) return 'other';
  return currentSection;
}

function collectBlocks(lines) {
  const blocks = [];
  let section = 'preamble';
  let activeMainTaskId = null;
  let historyMainTaskId = null;

  for (let i = 0; i < lines.length; i++) {
    section = detectSection(lines[i], section);

    const match = lines[i].match(TASK_HEADING_RE);
    if (!match || !VALID_SECTIONS.has(section)) continue;

    const level = match[1].length;
    const id = match[2];
    const status = match[3];
    const title = match[4].trim();
    const startLine = i + 1;

    const body = [];
    let j = i + 1;
    while (j < lines.length) {
      if (TASK_HEADING_RE.test(lines[j])) break;
      if (/^##\s+/.test(lines[j])) break;
      body.push(lines[j]);
      j++;
    }

    let parentId = null;
    if (level === 3) {
      if (section === 'history') {
        historyMainTaskId = id;
      } else {
        activeMainTaskId = id;
      }
    } else if (level === 4) {
      parentId = section === 'history' ? historyMainTaskId : activeMainTaskId;
    }

    blocks.push({
      id,
      parentId,
      type: level === 4 ? 'subtask' : 'task',
      status,
      title,
      section,
      startLine,
      rawBody: body.join('\n').trimEnd(),
      body,
    });

    i = j - 1;
  }

  return blocks;
}

function firstBacktickValue(line) {
  const match = line.match(/`([^`]+)`/);
  return match ? match[1].trim() : null;
}

function allBacktickValues(line) {
  return Array.from(line.matchAll(/`([^`]+)`/g), (m) => m[1].trim());
}

function extractSimpleField(lines, label) {
  const prefix = `${label}:`;
  const line = lines.find((entry) => entry.trim().toLowerCase().startsWith(prefix.toLowerCase()));
  if (!line) return null;
  return line.slice(line.indexOf(':') + 1).trim() || null;
}

function collectBulletSection(lines, labels) {
  const normalizedLabels = labels.map((label) => label.toLowerCase());
  const start = lines.findIndex((line) => {
    const clean = line.trim().toLowerCase();
    return normalizedLabels.some((label) => clean === `${label}:`);
  });

  if (start === -1) return [];

  const items = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const clean = line.trim();

    if (!clean) {
      if (items.length > 0) break;
      continue;
    }

    if (/^[A-Z][A-Za-z -]+:\s*$/.test(clean) && items.length > 0) break;
    if (/^\[Task Report\]/.test(clean)) break;
    if (/^#{3,4}\s+/.test(clean)) break;

    const bullet = clean.match(/^-\s+(.*)$/);
    if (bullet) {
      items.push(bullet[1].trim());
    } else if (items.length > 0) {
      break;
    }
  }

  return items;
}

function parseReports(lines) {
  const reports = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '[Task Report]') continue;

    const reportLines = [];
    let j = i + 1;
    while (j < lines.length) {
      const clean = lines[j].trim();
      if (clean === '[Task Report]') break;
      if (/^#{3,4}\s+/.test(clean)) break;
      reportLines.push(lines[j]);
      j++;
    }

    reports.push(parseReport(reportLines));
    i = j - 1;
  }

  return reports;
}

function parseReport(lines) {
  const report = {
    agentName: null,
    role: null,
    taskId: null,
    filesChanged: [],
    summary: '',
    tested: '',
    notTested: '',
    risksOrFollowUp: '',
    rawText: lines.join('\n').trim(),
  };

  const fieldMap = new Map([
    ['agent', 'agentName'],
    ['role', 'role'],
    ['task', 'taskId'],
    ['files changed', 'filesChanged'],
    ['summary', 'summary'],
    ['what was tested', 'tested'],
    ['what was not tested', 'notTested'],
    ['risks or follow-up needed', 'risksOrFollowUp'],
  ]);

  let activeKey = null;
  for (const line of lines) {
    const match = line.match(FIELD_RE);
    const candidateKey = match ? fieldMap.get(match[1].trim().toLowerCase()) : null;

    if (candidateKey) {
      activeKey = candidateKey;
      const value = match[2].trim();
      if (candidateKey === 'filesChanged') {
        report.filesChanged = parseFilesChanged(value);
      } else {
        report[candidateKey] = value;
      }
      continue;
    }

    if (!activeKey) continue;
    const value = line.trim();
    if (!value) continue;

    if (activeKey === 'filesChanged') {
      report.filesChanged.push(...parseFilesChanged(value));
    } else {
      report[activeKey] = report[activeKey]
        ? `${report[activeKey]}\n${value}`
        : value;
    }
  }

  return report;
}

function parseFilesChanged(value) {
  if (!value || /^none$/i.test(value)) return [];

  const backtickValues = allBacktickValues(value);
  if (backtickValues.length > 0) return backtickValues;

  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseClaim(lines) {
  const claimedBy = extractSimpleField(lines, 'Claimed by');
  if (!claimedBy) return null;

  return {
    agentName: claimedBy.replace(/\s*\([^)]*\)\s*$/, '').trim(),
    role: extractSimpleField(lines, 'Role'),
    claimedAt: extractSimpleField(lines, 'Timestamp'),
  };
}

function parseCompleted(lines) {
  const completedBy = extractSimpleField(lines, 'Completed by');
  if (!completedBy) return null;

  return {
    agentName: completedBy.replace(/\s*\([^)]*\)\s*$/, '').trim(),
    completedAt: extractSimpleField(lines, 'Completed timestamp'),
  };
}

function parseTask(block, order, children) {
  const recommendedRoleLine = block.body.find((line) => /^Recommended role:/i.test(line.trim()));
  const suggestedOwnerLine = block.body.find((line) => /^Suggested owner:/i.test(line.trim()));
  const prerequisitesLine = block.body.find((line) => /^Prerequisites:/i.test(line.trim()));

  const completed = parseCompleted(block.body);

  return {
    id: block.id,
    parentId: block.parentId,
    type: block.type,
    section: block.section,
    status: block.status,
    title: block.title,
    recommendedRole: recommendedRoleLine ? firstBacktickValue(recommendedRoleLine) : null,
    priority: extractSimpleField(block.body, 'Priority'),
    suggestedOwnerRole: suggestedOwnerLine ? firstBacktickValue(suggestedOwnerLine) : null,
    goal: collectBulletSection(block.body, ['Goal']),
    scope: collectBulletSection(block.body, ['Scope', 'Scope guidance']),
    prerequisites: prerequisitesLine ? allBacktickValues(prerequisitesLine) : [],
    claim: parseClaim(block.body),
    completedBy: completed ? completed.agentName : null,
    completedAt: completed ? completed.completedAt : null,
    reports: parseReports(block.body),
    notes: [],
    children,
    source: extractSimpleField(block.body, 'Source'),
    order,
    markdown: {
      startLine: block.startLine,
      rawBody: block.rawBody,
    },
  };
}

function buildStore(blocks) {
  const childrenByParent = new Map();
  for (const block of blocks) {
    if (!block.parentId) continue;
    if (!childrenByParent.has(block.parentId)) childrenByParent.set(block.parentId, []);
    childrenByParent.get(block.parentId).push(block.id);
  }

  const tasks = [];
  const nextTodo = [];
  const history = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const task = parseTask(block, (i + 1) * 10, childrenByParent.get(block.id) || []);

    if (block.section === 'active') {
      tasks.push(task);
    } else if (block.section === 'nextTodo') {
      nextTodo.push(task);
    } else if (block.section === 'history') {
      history.push(task);
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      format: 'agents-tasks.md',
      path: 'agents-tasks.md',
      migration: 'Agents_Coordinator/system/migrate-tasks-from-markdown.js',
    },
    tasks,
    nextTodo,
    history,
  };
}

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function parseArgs(argv) {
  const options = {
    tasksPath: 'agents-tasks.md',
    outPath: 'Agents_Coordinator/coordination/tasks.json',
    check: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tasks' && i + 1 < argv.length) {
      options.tasksPath = argv[++i];
    } else if (arg === '--out' && i + 1 < argv.length) {
      options.outPath = argv[++i];
    } else if (arg === '--check') {
      options.check = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function resolveFromWorkspace(filePath) {
  if (!filePath) return filePath;
  return path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(WORKSPACE_ROOT, filePath);
}

function printHelp() {
  console.log('Usage: node Agents_Coordinator/system/migrate-tasks-from-markdown.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --tasks <path>   Source Markdown board. Default: agents-tasks.md');
  console.log('  --out <path>     Output JSON store. Default: Agents_Coordinator/coordination/tasks.json');
  console.log('  --check          Parse and validate without writing output');
  console.log('  --help, -h       Show this help');
}

function validateStore(store) {
  const issues = [];
  const seen = new Set();

  for (const collectionName of ['tasks', 'nextTodo', 'history']) {
    for (const task of store[collectionName]) {
      if (seen.has(task.id)) {
        issues.push(`Duplicate task id across migrated store: ${task.id}`);
      }
      seen.add(task.id);

      for (const prereq of task.prerequisites) {
        if (!seen.has(prereq) && !store.tasks.some((entry) => entry.id === prereq) && !store.history.some((entry) => entry.id === prereq)) {
          issues.push(`${task.id} references missing prerequisite ${prereq}`);
        }
      }
    }
  }

  return issues;
}

function migrateFromMarkdown(sourcePath, outPath) {
  const lines = readLines(sourcePath);
  const blocks = collectBlocks(lines);
  const store = buildStore(blocks);
  const issues = validateStore(store);
  return { store, issues };
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const sourcePath = resolveFromWorkspace(options.tasksPath);
    const outPath = resolveFromWorkspace(options.outPath);
    const { store, issues } = migrateFromMarkdown(sourcePath, outPath);

    if (issues.length > 0) {
      console.error('Migration validation failed:');
      for (const issue of issues) console.error(`- ${issue}`);
      process.exit(1);
    }

    if (!options.check) {
      atomicWriteJson(outPath, store);
    }

    console.log(`Migrated ${store.tasks.length} active tasks, ${store.nextTodo.length} next-todo items, ${store.history.length} history tasks.`);
    if (options.check) console.log('Check completed without writing output.');
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  readLines,
  collectBlocks,
  buildStore,
  validateStore,
  migrateFromMarkdown,
  atomicWriteJson,
  parseArgs,
  main,
};

