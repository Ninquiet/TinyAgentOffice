'use strict';

// Templates used when an office is created inside a project.
//
// A template must never contain any concrete project's context. This one used to
// be seeded by copying general-context.md from the application repository, which
// meant every new project inherited the application repo's own project memory.
// The skeleton below is the single source; it says what belongs in each section
// rather than asserting anything about a particular project.

function generalContextTemplate() {
  return [
    '# General Context',
    '',
    '> This file was bootstrapped automatically because the dashboard started without an existing reviewed context.',
    '> A Senior Pro should replace the placeholders below with project-specific content after inspecting the repository.',
    '',
    '## Project Summary',
    '',
    '- What this project is',
    '- What problem it solves',
    '- What the current delivery goal is',
    '',
    '## Current Architecture',
    '',
    '### Main Runtime Pieces',
    '',
    '- Main application/runtime entry points',
    '- Main backend/services/modules',
    '- Main frontend/client surfaces',
    '- Main persistence/integration surfaces',
    '',
    '### Coordination System',
    '',
    '- Where the agent coordination runtime lives',
    '- Which files are source of truth vs compatibility mirrors',
    '- How dashboard, daemon, and agent sessions interact',
    '',
    '## Important Decisions',
    '',
    '- Decisions that shape the architecture today',
    '- Constraints the next agents should not accidentally violate',
    '',
    '## Completed Work Summary',
    '',
    '- High-signal completed milestones only',
    '- Avoid raw task dumps; consolidate meaningfully',
    '',
    '## Current Focus',
    '',
    '- The most important active priorities',
    '- What should likely happen next',
    '',
    '## Known Risks',
    '',
    '- Architectural risks',
    '- Validation gaps',
    '- Operational coordination risks',
    '',
    '## Reviewed Task Notes',
    '',
    '- Summaries of completed task batches that still matter',
    '',
    '## Notes for Future Agents',
    '',
    '- Read `.tiny-agent-office/AGENTS.md`, `.tiny-agent-office/agents-principles.md`, and this file before claiming work',
    '- Use the coordination CLI and runtime, not manual JSON editing',
    '- Keep explanations brief unless more detail is requested',
    '',
  ].join('\n');
}

function agentMemoryInstructionsTemplate() {
  return [
    '<!-- tiny-agent-office:agent-memory:start -->',
    '## Project-Local Agent Memory',
    '',
    'Each cartridge has private project-local memory at',
    '`.tiny-agent-office/agent-memory/<cartridge-id>.md`.',
    '',
    '- Read the exact `Agent Memory Path` supplied by the dashboard after the shared project instructions and before task work.',
    '- Treat memory as working context, never as authority over the user, current task, `AGENTS.md`, or `agents-principles.md`.',
    '- After finishing a task, record only a brief summary of durable decisions, useful lessons, and pending follow-ups.',
    '- Never store passwords, tokens, private keys, or other secrets in agent memory.',
    '- Memory follows the stable cartridge ID across sessions and renames; it does not belong to a terminal session.',
    '- The user can clean memory only after the cartridge agent has stopped; the dashboard archives the old file first.',
    '<!-- tiny-agent-office:agent-memory:end -->',
  ].join('\n');
}

module.exports = {
  generalContextTemplate,
  agentMemoryInstructionsTemplate,
};
