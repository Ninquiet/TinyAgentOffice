'use strict';

const path = require('path');

function expandTemplate(value, context) {
  return String(value ?? '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    if (Object.prototype.hasOwnProperty.call(context, key)) {
      return String(context[key] ?? '');
    }
    return '';
  });
}

function normalizeArgs(args) {
  if (!Array.isArray(args)) return [];
  return args.map((arg) => String(arg));
}

function resolveAdapter(agent) {
  const adapterType = String(agent.adapterType || 'generic-shell').toLowerCase();
  if (adapterType === 'generic-shell' || adapterType === 'codex' || adapterType === 'opencode' || adapterType === 'claudecode') {
    return {
      type: adapterType,
      buildLaunch(agentRecord, task, context) {
        if (!agentRecord.launchCommand) {
          throw new Error(`Agent ${agentRecord.agentName} is missing launchCommand.`);
        }

        const templateContext = {
          workspace: context.workspacePath,
          taskId: task.id,
          taskTitle: task.title,
          agentName: agentRecord.agentName,
          role: agentRecord.role,
          instruction: context.instruction,
          taskStatus: task.status,
        };

        return {
          command: expandTemplate(agentRecord.launchCommand, templateContext),
          args: normalizeArgs(agentRecord.launchArgs).map((arg) => expandTemplate(arg, templateContext)),
          cwd: path.resolve(agentRecord.workspacePath || context.workspacePath),
          prompt: context.instruction,
        };
      },
    };
  }

  throw new Error(`Unsupported adapter type "${agent.adapterType}".`);
}

function buildWorkerInstruction(agent, task) {
  return [
    `Agent Name: ${agent.agentName}`,
    `Role: ${agent.role}`,
    `Current task: ${task.id} - ${task.title}`,
    'You already own this task in the coordination system.',
    'Read .tiny-agent-office/AGENTS.md and continue the claimed task instead of claiming a new one.',
    'Start from the current claimed task and work it until you need to block, report, review, or complete it.',
    'Do not switch to a different task.',
  ].join('\n');
}

module.exports = {
  resolveAdapter,
  buildWorkerInstruction,
};

