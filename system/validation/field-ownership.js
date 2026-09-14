'use strict';

// Who is allowed to write each field that crosses a boundary.
//
// Two of the five integration bugs in this refactor were "how many modules write
// this field": `runtimeState` had none for idle agents, so the scheduler waited
// forever for a value nobody produced, and the OpenCode session id had two
// sources that drifted apart. Both shapes are mechanically detectable, the same
// way modules deriving their own APP_ROOT are.
//
// Rules for editing this file:
//
// - A field with one writer stays that way unless there is a reason written down
//   here. "It was convenient" is not a reason.
// - A field with several writers lists every one of them explicitly. That freezes
//   the current set: existing writers keep working, a NEW file writing the field
//   fails the build and has to justify itself here first.
// - Exceptions are declared with their reason. An undeclared exception is what
//   this file exists to prevent.
//
// The repository history records the boundary failures that motivated these
// ownership constraints.

const OWNERSHIP = [
  {
    field: 'runtimeState',
    writers: [
      'system/runtime/runtime-store.js',
      'system/dashboard/server.js',
    ],
    reason: [
      'The state machine\'s verdict, published to the registry so the daemon --',
      'a separate process that cannot read the in-memory store -- can schedule.',
      'The activity watchdog used to write it too, and only for agents that',
      'already owned a task, so idle agents never got a value and nothing could',
      'ever be dispatched. The registry writer is publishAgentRuntimeStates and',
      'it is the only one.',
      '',
      'Declared exception: applyOpencodeFacts in the dashboard writes the same',
      'name onto the DERIVED VIEW MODEL, which is a different object built fresh',
      'on every render. It is not the registry field, and the value comes from',
      'the session facts rather than being invented.',
      '',
      'Known limitation this creates: the scan is textual, so it can no longer',
      'catch a genuine registry write appearing in server.js. That is the cost of',
      'the view model reusing the name. If registry writes ever move around,',
      'rename the view field rather than widening this entry further.',
    ].join(' '),
  },
  {
    field: 'lastRuntimeEventAt',
    writers: ['system/runtime/runtime-store.js'],
    reason: 'Written with runtimeState and meaningless apart from it.',
  },
  {
    field: 'opencodeSessionId',
    writers: [
      'system/runtime/runtime-store.js',
      'system/daemon/daemon-fleet.js',
      'system/dashboard/server.js',
    ],
    reason: [
      'Declared exception, three writers on purpose. The live value comes from the',
      'event broker and the registry caches it; publishAgentRuntimeStates converges',
      'the cache on the resolved id. The other two write it at moments the world',
      'tick has not run yet: daemon-fleet when a cartridge is launched (in the',
      'daemon process, which has no tick), and the dashboard when a manual message',
      'first resolves a session. All three write the same value from the same',
      'source. Readers must go through opencode.resolveSessionId, never the field',
      'directly, or the drift this caused comes back.',
    ].join(' '),
  },
  {
    field: 'stalledSinceAt',
    writers: ['system/opencode/activity-watchdog.js'],
    reason: 'The watchdog owns the release decision and the mark that leads to it.',
  },
  {
    field: 'activityState',
    writers: ['system/opencode/activity-watchdog.js'],
    reason: [
      'Whether an agent is working or stalled, and now the only answer to that:',
      'the dashboard renders this field instead of recomputing a second verdict',
      'from message timestamps. It had two producers that disagreed -- the screen',
      'showed STALLED for an hour and a half on an agent the registry called',
      'working, and the half that could act on it was the half that saw nothing',
      'wrong. If a second writer is ever needed, the question to answer first is',
      'which one the user is looking at.',
    ].join(' '),
  },
  {
    field: 'attempt',
    writers: ['system/opencode/activity-watchdog.js'],
    reason: [
      'Which run at a task this is. Advanced only when the watchdog gives a task',
      'back, and read by the dispatcher to key the prompt ledger, so a genuine',
      'retry is not mistaken for a duplicate of the prompt that failed. A second',
      'writer would silently re-issue prompts the ledger is meant to stop.',
    ].join(' '),
  },
  {
    field: 'activeTaskId',
    writers: [
      'system/runtime/runtime-reconcile.js',
      'system/runtime/coordination-core.js',
      'system/dispatch/session-dispatch.js',
      'system/cli/registry-commands.js',
      'system/cli/task-commands.js',
      'system/opencode/activity-watchdog.js',
      'system/dashboard/server.js',
    ],
    reason: [
      'Task ownership, and the highest-risk field in the system by writer count:',
      'about thirty assignments across seven files. Most are the coordination layer',
      'clearing stale ownership, which is legitimate. This list is a freeze, not an',
      'endorsement -- it stops the set growing silently. If a task-ownership bug',
      'appears, map these writers before guessing.',
    ].join(' '),
  },
  {
    field: 'attentionRequired',
    writers: [
      'system/dashboard/server.js',
      'system/runtime/runtime-reconcile.js',
      'system/opencode/activity-watchdog.js',
      'system/dispatch/session-dispatch.js',
    ],
    reason: 'Frozen set. Several layers can raise attention; none may be added quietly.',
  },
  {
    field: 'operationalStatus',
    writers: [
      'system/dashboard/server.js',
      'system/runtime/runtime-reconcile.js',
      'system/opencode/activity-watchdog.js',
      'system/dispatch/session-dispatch.js',
    ],
    reason: 'Frozen set, same reasoning as attentionRequired.',
  },
];

module.exports = {
  OWNERSHIP,
};
