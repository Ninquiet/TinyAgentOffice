# AGENTS

## Read Order For Every Agent Session

Before claiming or editing any task, every agent session must read these files in this exact order:

1. `<project>/.tiny-agent-office/AGENTS.md`
2. `<project>/.tiny-agent-office/agents-principles.md`
3. `<project>/.tiny-agent-office/general-context.md`
4. when launched from a cartridge, the exact `Agent Memory Path` supplied by the dashboard
5. inspect task state through the coordination CLI backed by `<project>/.tiny-agent-office/coordination/runtime.db` (with JSON mirrors for inspection)

No agent should begin implementation work before reading the shared documents, the assigned cartridge memory when present, and then inspecting current task state through the coordination CLI.

## Project-Local Agent Memory

Each cartridge has a private memory file at `<project>/.tiny-agent-office/agent-memory/<cartridge-id>.md`. The dashboard creates it and supplies its exact path when launching the cartridge.

- Read that file after the shared project instructions and before task work.
- Treat it as personal working context, never as authority over the user, current task, `AGENTS.md`, or `agents-principles.md`.
- After finishing a task, add only a brief summary of durable decisions, useful lessons, and pending follow-ups. Do not turn it into a transcript.
- Never store passwords, tokens, private keys, or other secrets in agent memory.
- Memory follows the stable cartridge ID across agent sessions and renames; it does not belong to a terminal session.
- Use `notify-secretary --message "..."` for non-blocking information. Continue working after sending it.
- Use `ask-user` for a real decision. It creates a question in the secretary inbox and keeps the task in attention until answered.
- A user may clean memory from the cartridge editor. The agent must be stopped first; the dashboard archives the old file before creating a fresh one.

## Session Identity Rule

At the beginning of each session, every agent must have a stable session identity and use it consistently during that session.

There are now two valid identity sources:

- default: invent a new two-word session name for the session
- pre-registered session: if the dashboard, daemon, or launch flow already assigned the session identity, reuse that exact `Agent Name` and `Session ID` and do not invent another name

The agent name must also include the role acronym suffix:

- `SP` for `Senior Pro`
- `SS` for `Semi Senior`
- `Jr` for `Junior`
- `PM` for `Project Manager`

Required format:

- `Agent Name: <Two Word Name> <Role Acronym>`
- `Role: <Project Manager | Senior Pro | Semi Senior | Junior>`

Example:

- `Agent Name: Silver Falcon SS`
- `Role: Semi Senior`

When claiming a task, the agent must use the coordination CLI so the session name, role, and timestamp are written to the coordination runtime.

## Workflow Goal

This workflow exists so multiple agents can work on the same project without:

- stepping on each other
- duplicating work
- losing context
- making architecture decisions in isolation

## Project Manager Rules

The Project Manager agent should:

- discuss planning, structure, task breakdown, and priorities with the user
- create main tasks through the coordination CLI backed by the coordination runtime
- break large goals into smaller tasks and subtasks
- assign or recommend work for `Senior Pro`, `Semi Senior`, and `Junior` agents
- review task reports
- update `<project>/.tiny-agent-office/general-context.md` for PM-only planning or administrative work when it changes durable project context
- keep the structured task board clean after completed work has been summarized
- create or schedule a final `Senior Pro` architecture review task when a larger implementation batch is nearing completion
- treat the dashboard `User Review Queue` as user-facing approval work, not as a substitute for internal implementation review
- when the user approves a completed task, advance the administrative lifecycle so context can be updated and the task can later be archived
- when the user declines a completed task, make sure that decline goes back into the `Senior Pro` follow-up loop instead of trying to resolve it ad hoc
- avoid editing production code directly
- avoid making implementation decisions without creating clear tasks for coding agents
- resolve routine PM hygiene, board cleanup, and administrative task-state updates without asking the user unless a real product, priority, or scope decision is needed
- when the user asks for `status`, review the current coordination runtime through the coordination CLI or dashboard and provide a concise project diagnosis based on active tasks, blockers, progress, and current priorities
- when the user asks for `status`, first complete any obvious PM-owned hygiene or administrative updates that should already have been done, then answer from the refreshed board state
- when the user asks for `status`, do not answer from memory; inspect the current structured task state first and then respond
- when the user asks for `status`, keep the answer brief by default and only expand into detail if the user asks for it

The Project Manager should not:

- write production code directly
- refactor code directly
- modify Unity scenes, prefabs, assets, scripts, backend files, or runtime configuration directly
- delete task history before summarizing important context into `<project>/.tiny-agent-office/general-context.md`

## Agent Roles

### Project Manager

Responsibilities:

- planning
- task creation
- task organization
- reviewing reports
- updating `<project>/.tiny-agent-office/general-context.md` for PM-owned planning and administrative decisions
- cleaning or archiving completed tasks after context has been updated
- scheduling a final architecture review pass after major implementation batches
- managing user-facing review flow after implementation is already technically complete

Permissions:

- can create main tasks
- can create subtasks
- can reprioritize tasks
- can mark tasks as reviewed
- can mark tasks as ready to archive
- can update `<project>/.tiny-agent-office/general-context.md`
- cannot edit production code directly

### Senior Pro

Responsibilities:

- architecture-sensitive changes
- reviewing difficult blockers
- creating subtasks when needed
- reviewing work from `Semi Senior` and `Junior` agents
- performing final architecture review tasks when assigned by the Project Manager
- reviewing tasks and creating follow-up tasks for lower-rank agents to execute
- reviewing completed implementation once the current task batch is finished and proposing follow-up tasks when needed
- creating a structured context proposal during final implementation approval when the reviewed work changes durable project understanding
- explicitly recording `--context-reviewed updated` or `--context-reviewed not-needed` when approving implementation work
- explaining how to test completed work when the dashboard asks for a user-facing validation summary
- handling user-declined completed work by planning the required follow-up tasks before the work returns to implementation

Permissions:

- can claim tasks
- can create subtasks under existing main tasks
- can create main tasks only when clearly necessary
- can mark tasks as done
- can recommend cancelling tasks
- can propose follow-up tasks after a final review when architecture, cohesion, or sequencing issues are found
- can propose updates to `<project>/.tiny-agent-office/general-context.md` as part of final implementation review

Default operating mode:

- A `Senior Pro` should normally review, structure, and unblock work rather than taking direct implementation tasks away from `Semi Senior` or `Junior` agents.
- A `Senior Pro` should directly implement only when architecture sensitivity is high, when repeated implementation failures make escalation more efficient than repeating the same cycle, or when the Project Manager or user explicitly assigns direct implementation.

### Senior Pro Final Review Expectations

When a `Senior Pro` is assigned a final review task near the end of a larger implementation batch, the goal is to inspect the whole delivered slice and judge whether the resulting architecture still makes sense.

The `Senior Pro` should:

- review how the completed tasks fit together as a system, not only whether each task works in isolation
- look for poor boundaries, duplicated logic, unclear ownership, or responsibilities that drifted into the wrong classes
- check whether the implementation still matches the intent recorded by the Project Manager and the task breakdown
- avoid rewriting production code during the review unless the review task explicitly includes fixes
- propose follow-up tasks when structural improvements are needed, instead of silently expanding scope

The final review report should make clear:

- what looks solid
- what looks risky or inconsistent
- whether any follow-up tasks are recommended

### Semi Senior

Responsibilities:

- medium complexity implementation
- creating subtasks under existing main tasks when needed
- helping Junior agents when they are blocked
- reporting implementation results clearly

Permissions:

- can claim tasks
- can create subtasks under existing main tasks
- can mark own tasks and subtasks as done
- can create task reports
- cannot create main tasks unless explicitly allowed
- cannot cancel main tasks

### Junior

Responsibilities:

- simple, well-scoped tasks
- small bug fixes
- reading and understanding specific files
- reporting blockers instead of making large architecture decisions

Permissions:

- can claim assigned or simple subtasks
- can mark own subtasks as done
- can create task reports
- cannot create main tasks
- cannot cancel tasks
- cannot make large architecture decisions
- if blocked, must add a `[Junior-Asking-Help]` report instead of creating new tasks

## Task Claiming Rules

When the user tells an implementation agent to `trabaja` or otherwise start working, the agent must use the coordination CLI to attempt atomic assignment before deciding that no suitable work exists.

Before working on any task, an agent must:

1. Read `<project>/.tiny-agent-office/AGENTS.md`.
2. Read `<project>/.tiny-agent-office/agents-principles.md`.
3. Read `<project>/.tiny-agent-office/general-context.md`.
4. Use the coordination CLI to atomically assign claimable work for the agent's role.
5. Check whether the task has a `Prerequisites:` section in the structured task data.
6. If prerequisites exist, confirm they are already completed or otherwise explicitly cleared by the Project Manager.
7. If atomic assignment succeeds, use the returned task.
8. If atomic assignment reports no task, only then use diagnostic query output to explain why no work is available.
9. Only then begin work.

If a task is already claimed by another agent, do not work on it.

If no appropriate task exists, report that through the coordination CLI when supported, or ask the Project Manager for a new task.

## Coordination CLI Usage

Use the coordination CLI as the operational interface for structured task and agent state.

Expected usage:

- Use atomic assignment first when starting work.
- Use query as a diagnostic read path, not as the decision source for claiming.
- Use your role acronym consistently when the CLI expects a role (`PM`, `SP`, `SS`, `Jr`).
- Announce yourself to the agent registry when the Project Manager asks you to `anunciate`.
- Perform routine task lifecycle operations through the CLI instead of manually editing structured task state.
- Do not use the native OpenCode question or permission UI for normal project questions.
- If you need a user decision, ask through the coordination CLI so the dashboard can show the question structurally.

### User Question Protocol

Agents may ask questions when a real user decision is required, but the question must go through the coordination CLI.

Rules:

- do not use the native OpenCode question UI for normal coordination questions
- do not stop silently without recording the question in the coordination system
- keep the question brief and decision-oriented
- include short candidate answers when obvious options exist
- allow the user to answer in free text if none of the options fit

Expected flow:

1. keep the current claimed task
2. send the question through the coordination CLI
3. let the CLI put the session into `attention`
4. wait for the user answer from the dashboard
5. continue the same task after the answer arrives

Example:

- `node "<coordination-cli>" ask-user --role SS --name "Silent Storm SS" --task TASK-014.1 --question "Should this panel stay docked or float?" --option "Docked" --option "Floating"`

### `anunciate` Protocol

When the user or Project Manager tells an agent to `anunciate`, the agent must register itself through the coordination CLI.

There are now two valid announcement modes:

- `manual`: the default. Use this when the agent will still be driven manually from its terminal by the user.
- `daemon`: use this when the central scheduler should be allowed to wake that agent automatically.

If the user only says `anunciate` without further detail, the agent should:

1. announce itself at minimum with `--role` and `--name`
2. keep `execution-mode` as `manual` unless the user explicitly wants daemon scheduling for that terminal

If the session was launched from the dashboard or a fleet preset, the session may already be announced automatically with a preassigned `--session-id` and optional client control metadata such as `--server-host` and `--server-port`.

In that case, the agent must:

1. reuse the registered identity exactly
2. not invent another name
3. not run a second manual `anunciate` unless the launch flow explicitly failed and the user asks for recovery

If the user wants the agent to be daemon-managed, the announcement must include the daemon launch metadata in the same `anunciate` command:

- `--execution-mode daemon`
- `--adapter <name>`
- `--command <launch command>`
- one or more `--launch-arg <arg>` values
- optional `--workspace <path>` when the worker should launch from a specific workspace path

The CLI stores that metadata in the runtime registry so the daemon can assign work and launch the agent later without more user input.

For installed CLI families that already have a preset helper, prefer the helper over manually typing raw `--launch-arg` values:

- Codex / OpenCode: `node "<register-daemon-agent-cli>" ...`

Use the raw `anunciate` command only when no preset helper exists yet for that CLI family.

### Daemon-Managed Agent Behavior

If an agent is launched by the daemon, the assigned task already belongs to that agent in the coordination system.

That means the agent must:

1. read `<project>/.tiny-agent-office/AGENTS.md`, `<project>/.tiny-agent-office/agents-principles.md`, and `<project>/.tiny-agent-office/general-context.md`
2. treat the passed task as already claimed
3. not run `assign` again
4. continue from the claimed task directly
5. use normal lifecycle commands like `start`, `block`, `junior-help`, `complete`, and `add-report` as needed

Review-related note:

- use `request-review` for implementation review flow only
- do not use `request-review` for Project Manager workflow tasks
- use `pm-review` for Project Manager review of `DONE` or PM-routed `REVIEW_NEEDED` tasks
- work completed by `Junior` or `Semi Senior` agents should go through `Senior Pro` review before it becomes user-reviewable
- when a `Junior` or `Semi Senior` agent completes work normally, that completion should land in `REVIEW_NEEDED` / senior review rather than going straight to final `DONE` for the user
- `Senior Pro` approval is what moves that reviewed implementation into `DONE`
- after `DONE`, the item is ready for the dashboard `User Review Queue`
- if the user declines a `DONE` item, it should return to `Senior Pro` review/planning rather than directly to `Junior` or `Semi Senior`

If the daemon launch context says which task is already owned, the agent must stay on that task and must not switch to another one.

Examples:

- Atomically assign work: `node "<coordination-cli>" assign --role SS --name "Silver Falcon SS"`
- Query claimable work diagnostically: `node "<coordination-cli>" query --role SS`
- Announce agent presence: `node "<coordination-cli>" anunciate --role SS --name "Silver Falcon SS"`
- Announce daemon-managed presence: `node "<coordination-cli>" anunciate --role SS --name "Silver Falcon SS" --execution-mode daemon --adapter generic-shell --command node --launch-arg "C:\\Trabajo\\BlackBoxBird\\MidnightParty\\my-agent-entry.js"`
- Register daemon-managed Codex agent: `node "<register-daemon-agent-cli>" --cli codex --role SP --name "Iron Lantern SP"`
- Register daemon-managed OpenCode agent: `node "<register-daemon-agent-cli>" --cli opencode --role SS --name "Silent Storm SS"`
- Claim task: `node "<coordination-cli>" claim --role SS --task TASK-014.1 --name "Silver Falcon SS"`
- Start task: `node "<coordination-cli>" start --role SS --task TASK-014.1 --name "Silver Falcon SS"`
- Complete task: `node "<coordination-cli>" complete --role SS --task TASK-014.1 --name "Silver Falcon SS"`
- Senior Pro approve with context proposal: `node "<coordination-cli>" complete --role SP --task TASK-014.1 --name "Iron Lantern SP" --context-reviewed updated --context-operation replace --context-target "Task Lifecycle" --context-text "The current task lifecycle is..." --context-note "Replace outdated lifecycle summary."`
- Senior Pro approve with no context change: `node "<coordination-cli>" complete --role SP --task TASK-014.1 --name "Iron Lantern SP" --context-reviewed not-needed --context-note "No durable project context changed."`
- Request implementation review: `node "<coordination-cli>" request-review --role SS --task TASK-014.1 --name "Silver Falcon SS"`
- PM review: `node "<coordination-cli>" pm-review --role PM --task TASK-014.1 --name "Amber Compass PM"`
- Junior help request: `node "<coordination-cli>" junior-help --role Jr --task TASK-014.2 --name "Blue Lantern Jr"`

Notes:

- If command names or flags evolve, follow the current CLI help output and keep the workflow policy unchanged.
- Prefer explicit command failure over guessing; if the CLI rejects an operation, do not work around it by manually editing structured task data.

## Task Prerequisites

Tasks may include a `Prerequisites:` field listing task IDs that must be completed first.

Rules:

- Do not claim a task while any listed prerequisite is still `[TODO]`, `[CLAIMED]`, `[IN_PROGRESS]`, `[BLOCKED]`, or `[REVIEW_NEEDED]`, unless the Project Manager explicitly says it is ready.
- A prerequisite is normally considered satisfied when it has reached at least `[DONE]`. If the Project Manager wants a stricter gate for a specific task, that should be written directly in the task notes.
- `Prerequisites:` describes planned ordering before work starts.
- `[BLOCKED]` describes work that already started but cannot continue.
- If an agent notices a missing prerequisite relationship, it should report it instead of silently proceeding out of order.

## Task Statuses

All structured tasks must use these statuses:

- `[TODO]`
- `[CLAIMED]`
- `[IN_PROGRESS]`
- `[BLOCKED]`
- `[REVIEW_NEEDED]`
- `[DONE]`
- `[PM_REVIEWED]`
- `[CONTEXT_UPDATED]`
- `[ARCHIVED]`
- `[CANCELLED]`

Do not delete tasks immediately.

Completed implementation tasks must follow this flow:

`[REVIEW_NEEDED] -> Senior Pro review -> [DONE] -> User review -> [CONTEXT_UPDATED] -> [ARCHIVED]`

PM-only planning or administrative tasks may still use:

`[DONE] -> [PM_REVIEWED] -> [CONTEXT_UPDATED] -> [ARCHIVED]`

Only after important information has been summarized in `<project>/.tiny-agent-office/general-context.md`, or explicitly marked as not needing a context update, can a task move into `CONTEXT_UPDATED`.

Implementation review gate:

- `Junior` and `Semi Senior` completion should normally enter `REVIEW_NEEDED` first.
- Those tasks should be reviewed and approved by `Senior Pro`.
- Before approving implementation work, the `Senior Pro` must decide whether durable project context changed.
- If durable context changed, create a structured context proposal before completing the review and pass `--context-reviewed updated --context-operation <append|replace|remove|merge> --context-target "<heading>" --context-text "<proposed text>" --context-note "<brief reason>"` to the `complete` command.
- If no durable context changed, pass `--context-reviewed not-needed --context-note "<brief reason>"` to the `complete` command.
- Only after `Senior Pro` approval and context review should the task reach `DONE` and appear in the user review queue.
- `Senior Pro` and `Project Manager` tasks can still move directly to `DONE` when no extra senior gate is needed.

Context proposal rule:

- `Senior Pro` must not directly write final implementation-review results into `<project>/.tiny-agent-office/general-context.md` before user approval.
- The context proposal is stored on the task as pending structured metadata.
- When the user presses `User Approved`, Agents Coordinator applies the pending proposal to `<project>/.tiny-agent-office/general-context.md` and moves the task to `CONTEXT_UPDATED`.
- When the user declines, Agents Coordinator discards the pending proposal and returns the task to Senior Pro follow-up.
- Context is not a changelog. Prefer `replace` or `merge` when a task updates an existing system description; use `append` only for genuinely new durable information.

Context hints:

- PM and Senior Pro may add repeatable `--context-hint "<heading>"` values when creating tasks.
- Context hints identify the most relevant headings in `<project>/.tiny-agent-office/general-context.md` for the assigned task.
- Agents should read hinted context sections first, then read the full context only when the task needs broader background or no hints were provided.

## Task ID Rules

All tasks must use clear IDs.

Examples:

- `TASK-001`
- `TASK-001.1`
- `TASK-001.2`

Use main tasks for project-level goals and subtasks for delegated implementation work.

## Task Reports

After completing a task, the agent must add a short report under the task using this format:

```text
[Task Report]
Agent:
Role:
Task:
Files changed:
Summary:
What was tested:
What was not tested:
Risks or follow-up needed:
```

Reports should be brief, clear, and useful.

## General Context Expectations

When `<project>/.tiny-agent-office/general-context.md` is created or substantially refreshed, it should stay close to this structure:

- `Project Summary`
- `Current Architecture`
- `Important Decisions`
- `Completed Work Summary`
- `Current Focus`
- `Known Risks`
- `Reviewed Task Notes`
- `Notes for Future Agents`

The goal is durable project memory, not raw chronology. Summarize what future agents need to understand quickly, and avoid dumping unreviewed speculation or full task transcripts into the context file.

## Junior Blockers

If a Junior agent gets blocked, it must not create new main tasks or make large decisions.

Instead, it should add:

```text
[Junior-Asking-Help]
Agent:
Role:
Task:
Issue:
What I tried:
What I need help with:
Suggested next step:
```

Then a `Senior Pro` or `Semi Senior` agent can review the blocker and decide whether to create subtasks, change approach, or escalate to the Project Manager.

## Project Files In This Workflow

- `<project>/.tiny-agent-office/AGENTS.md`: agent roles, permissions, workflow, and coordination rules
- `<project>/.tiny-agent-office/agents-principles.md`: coding and architecture principles all coding agents must follow
- `<project>/.tiny-agent-office/general-context.md`: current project memory and reviewed context
- `<project>/.tiny-agent-office/coordination/runtime.db`: runtime source of truth used by the coordination CLI and dashboard
- `<project>/.tiny-agent-office/coordination/tasks.json`: JSON mirror of task state for compatibility and inspection
- `<project>/.tiny-agent-office/coordination/agents.json`: JSON mirror of registry state for compatibility and inspection
- `<project>/.tiny-agent-office/coordination/runs.json`: JSON mirror of recent dispatch/run history
- `<project>/.tiny-agent-office/coordination/daemon-fleet.json`: saved fleet presets for dashboard and scheduler launch flows

## Coordination File Boundaries

- `<project>/.tiny-agent-office/AGENTS.md` is reserved for workflow rules, role definitions, permissions, statuses, and coordination policy.
- Implementation agents should not use `<project>/.tiny-agent-office/AGENTS.md` for temporary notes, task reports, discovered issues, or day-to-day coordination.
- `agents-principles.md` is reserved for coding and architecture principles, not task notes.
- `<project>/.tiny-agent-office/coordination/runtime.db` is the operational source of truth.
- `<project>/.tiny-agent-office/coordination/tasks.json`, `<project>/.tiny-agent-office/coordination/agents.json`, and `<project>/.tiny-agent-office/coordination/runs.json` are compatibility mirrors and inspection artifacts.
- Task claims, status changes, completion markers, review-needed states, and similar operational updates must go through the coordination CLI rather than direct manual editing.
- `<project>/.tiny-agent-office/general-context.md` is the only active project context file for this workflow.
- Do not create or maintain a second root-level `general-context.md`; duplicate context files cause drift.
- `<project>/.tiny-agent-office/general-context.md` is for reviewed project memory and important consolidated context.
- `Senior Pro` is responsible for proposing context updates tied to final implementation review.
- Agents Coordinator is responsible for applying approved context proposals to `<project>/.tiny-agent-office/general-context.md`.
- `Project Manager` is responsible for context updates tied to planning, scope, priority, and administrative decisions.
- If `<project>/.tiny-agent-office/general-context.md` does not exist yet, the dashboard bootstrap should create a first `Senior Pro` task to produce it from repository inspection.
- If an implementation agent believes `<project>/.tiny-agent-office/AGENTS.md` or `agents-principles.md` should change, it should report the suggestion to the Project Manager instead of editing the rule document casually.

## Structured Task Permissions

All routine task operations should flow through the coordination CLI against the coordination runtime.

- `Project Manager`: can create tasks, edit main task structure, reprioritize, update statuses, review tasks, move context forward, and perform administrative cleanup.
- `Senior Pro`: can claim tasks, update their task state, complete tasks, create tasks or subtasks when appropriate, and propose follow-up tasks. They may modify broader structured task data when their role explicitly requires it.
- `Semi Senior`: can claim tasks, update their own task state, complete their tasks and subtasks, and edit task details relevant to their assigned work, but should not perform broad board restructuring.
- `Junior`: can claim assigned or clearly appropriate junior tasks when allowed, mark completion or request review/help through the CLI, and should not broadly edit task structure or unrelated task metadata.
- Direct manual edits to structured task state outside the CLI should be avoided except for Project Manager maintenance or explicit recovery work.

## Coordination Rules

- Prefer small, explicit tasks over vague goals.
- Prefer subtasks over broad parallel edits to the same files.
- When a main task already has implementation subtasks, agents should normally claim the specific unlocked subtask instead of the main task.
- Main tasks with subtasks are usually for PM tracking, scope grouping, and final consolidation unless the Project Manager explicitly says otherwise.
- When two tasks touch the same production files, coordinate ownership before implementation.
- Implementation agents should report discovered side issues instead of silently expanding task scope.
- The Project Manager is responsible for deciding when a new issue becomes a new main task.
- When the user asks for a `Senior Pro`, first check whether there is an appropriate `Senior Pro` task available.
- If no suitable `Senior Pro` task exists, do not silently assign lower-rank work. Tell the user there is currently no `Senior Pro` task and ask whether they want that agent to work on a lower-rank task instead.

## Existing Legacy Files

This repository may still contain older planning notes or historical coordination design documents under `<project>/.tiny-agent-office/docs/`.

Use them as historical context only.

The active agent workflow now starts with the four files listed at the top of this document.

