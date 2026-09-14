'use strict';

const fs = require('fs');
const path = require('path');
const { APP_ROOT, getActiveProjectWorkspace } = require('../core/project-workspace');

// Deriving this one level too high is what created a stray .tiny-agent-office
// in the directory above the repository.
const ROOT = APP_ROOT;
const GENERAL_CONTEXT_PATH = path.join(ROOT, '.tiny-agent-office', 'general-context.md');

function generalContextPath() {
  return getActiveProjectWorkspace().paths.generalContextFile;
}

function utcNow() {
  return new Date().toISOString();
}

function normalizeHeading(value) {
  return String(value || '')
    .trim()
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function headingPattern(line) {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  if (!match) return null;
  return {
    level: match[1].length,
    title: match[2].trim(),
  };
}

function findSection(content, target) {
  const normalizedTarget = normalizeHeading(target);
  const lines = String(content || '').split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const heading = headingPattern(lines[index]);
    if (!heading || normalizeHeading(heading.title) !== normalizedTarget) continue;

    let end = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      const nextHeading = headingPattern(lines[next]);
      if (nextHeading && nextHeading.level <= heading.level) {
        end = next;
        break;
      }
    }

    return {
      lines,
      start: index,
      contentStart: index + 1,
      end,
      heading,
    };
  }

  return null;
}

function cleanProposalText(text) {
  return String(text || '').trim();
}

function replaceRange(lines, start, end, replacementLines) {
  return [
    ...lines.slice(0, start),
    ...replacementLines,
    ...lines.slice(end),
  ].join('\n').replace(/\s+$/u, '\n');
}

function applyProposalToContent(content, proposal) {
  const operation = String(proposal.operation || '').trim().toLowerCase();
  if (operation === 'no-change') {
    return {
      content,
      changed: false,
      summary: 'No context update was needed.',
    };
  }

  const target = String(proposal.target || '').trim();
  if (!target) throw new Error('Context proposal target is required.');

  const section = findSection(content, target);
  if (!section) {
    throw new Error(`Context section "${target}" was not found.`);
  }

  const text = cleanProposalText(proposal.text);
  if (operation !== 'remove' && !text) {
    throw new Error('Context proposal text is required.');
  }

  if (operation === 'replace') {
    const replacementLines = [
      section.lines[section.start],
      '',
      ...text.split(/\r?\n/),
      '',
    ];
    return {
      content: replaceRange(section.lines, section.start, section.end, replacementLines),
      changed: true,
      summary: `Replaced context section "${section.heading.title}".`,
    };
  }

  if (operation === 'append' || operation === 'merge') {
    const currentBlock = section.lines.slice(section.start, section.end).join('\n');
    if (currentBlock.includes(text)) {
      return {
        content,
        changed: false,
        summary: `Context section "${section.heading.title}" already contains the proposed text.`,
      };
    }

    const hasTrailingBlank = section.end > 0 && String(section.lines[section.end - 1] || '').trim() === '';
    const insertion = hasTrailingBlank
      ? [
        ...text.split(/\r?\n/),
        '',
      ]
      : [
        '',
        ...text.split(/\r?\n/),
        '',
      ];
    return {
      content: replaceRange(section.lines, section.end, section.end, insertion),
      changed: true,
      summary: `${operation === 'merge' ? 'Merged into' : 'Appended to'} context section "${section.heading.title}".`,
    };
  }

  if (operation === 'remove') {
    return {
      content: replaceRange(section.lines, section.start, section.end, []),
      changed: true,
      summary: `Removed context section "${section.heading.title}".`,
    };
  }

  throw new Error(`Unsupported context proposal operation "${proposal.operation}".`);
}

function buildContextProposal(options = {}, agent = {}) {
  const reviewed = String(options.contextReviewed || '').trim().toLowerCase();
  if (!reviewed) return null;
  if (reviewed !== 'updated' && reviewed !== 'not-needed') {
    throw new Error('--context-reviewed must be "updated" or "not-needed".');
  }

  const now = utcNow();
  if (reviewed === 'not-needed') {
    return {
      state: 'no-change',
      operation: 'no-change',
      reason: options.contextNote || 'No durable project context changed.',
      proposedBy: agent.name || options.name || null,
      proposedByRole: agent.role || null,
      createdAt: now,
    };
  }

  const operation = String(options.contextOperation || 'append').trim().toLowerCase();
  if (!['append', 'replace', 'remove', 'merge'].includes(operation)) {
    throw new Error('--context-operation must be append, replace, remove, or merge.');
  }

  return {
    state: 'pending',
    operation,
    target: options.contextTarget || 'Reviewed Task Notes',
    text: options.contextText || options.contextNote || '',
    reason: options.contextNote || '',
    proposedBy: agent.name || options.name || null,
    proposedByRole: agent.role || null,
    createdAt: now,
  };
}

function proposalResolved(proposal) {
  return Boolean(proposal && (
    proposal.state === 'pending'
    || proposal.state === 'no-change'
    || proposal.state === 'applied'
  ));
}

function applyContextProposal(task, options = {}) {
  const proposal = task && task.contextProposal;
  if (!proposal) {
    return {
      applied: false,
      changed: false,
      summary: 'No context proposal exists.',
    };
  }

  if (proposal.state === 'applied') {
    return {
      applied: true,
      changed: false,
      summary: 'Context proposal was already applied.',
    };
  }

  if (proposal.state === 'no-change') {
    proposal.state = 'applied';
    proposal.appliedAt = utcNow();
    proposal.appliedBy = options.appliedBy || 'Agents Coordinator';
    return {
      applied: true,
      changed: false,
      summary: proposal.reason || 'No context update was needed.',
    };
  }

  if (proposal.state !== 'pending') {
    throw new Error(`Context proposal is ${proposal.state || 'missing state'}, not pending.`);
  }

  const contextPath = options.contextPath || generalContextPath();
  const before = fs.readFileSync(contextPath, 'utf8');
  const result = applyProposalToContent(before, proposal);
  if (result.changed) {
    fs.writeFileSync(contextPath, result.content, 'utf8');
  }

  proposal.state = 'applied';
  proposal.appliedAt = utcNow();
  proposal.appliedBy = options.appliedBy || 'Agents Coordinator';
  proposal.appliedSummary = result.summary;

  return {
    applied: true,
    changed: result.changed,
    summary: result.summary,
    contextPath,
  };
}

function discardContextProposal(task, options = {}) {
  const proposal = task && task.contextProposal;
  if (!proposal || proposal.state === 'applied') return false;
  proposal.state = 'discarded';
  proposal.discardedAt = utcNow();
  proposal.discardedBy = options.discardedBy || 'Agents Coordinator';
  proposal.discardReason = options.reason || '';
  return true;
}

module.exports = {
  GENERAL_CONTEXT_PATH,
  generalContextPath,
  applyContextProposal,
  applyProposalToContent,
  buildContextProposal,
  discardContextProposal,
  findSection,
  proposalResolved,
};
