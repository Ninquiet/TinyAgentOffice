import { useMemo, useState } from 'react';
import { requestTaskExplanation, runTaskAction } from '../taskActions';
import type { TaskPanelKind } from '../hooks/useDashboardWindows';
import type { AgentSession, DashboardPayload, QueueTask } from '../types';
import { getThemeButtonsComposition } from '../themes/buttonCompositions';
import { buttonCompositionToStyle } from '../themes/buttonCompositionTypes';

interface TaskSlidePanelsProps {
  dashboard: DashboardPayload;
  projectManagerBusy: boolean;
  openPanel: TaskPanelKind;
  closing: boolean;
  onOpenPanel: (panel: Exclude<TaskPanelKind, null>) => void;
  onClosePanel: () => void;
  onMessage: (message: string) => void;
  onPromoteNextTodo?: (task: QueueTask) => void;
  themeId: string;
}

function workerForTask(taskId: string, agents: AgentSession[] = []) {
  return agents.find((agent) => agent.activeTaskId === taskId);
}

function taskStatusLabel(task: QueueTask, kind: 'active' | 'next' | 'review' | 'waiting' | 'superseded') {
  if (kind === 'review' && task.status === 'DONE') return 'Waiting for your approval or decline';
  if (kind === 'review' && task.status === 'REVIEW_NEEDED') return 'Needs User Decision';
  if (kind === 'waiting') return task.reason || 'Waiting for follow-up work';
  if (kind === 'superseded') return task.reason || 'Superseded by follow-up';
  if (task.status === 'REVIEW_NEEDED' && task.claimableRole) return `Waiting for ${task.claimableRole} review`;
  if (task.status === 'TODO' && task.claimableRole) return `Waiting for ${task.claimableRole}`;
  return task.status;
}

function taskRoleLabel(task: QueueTask, kind: 'active' | 'next' | 'review' | 'waiting' | 'superseded') {
  if (kind === 'waiting' || kind === 'superseded') return task.followUpTaskId ? `Follow-up: ${task.followUpTaskId}` : 'Follow-up pending';
  if (task.claimableRole && task.claimableRole !== task.recommendedRole) {
    return `Originally: ${task.recommendedRole || 'No role'}`;
  }
  return task.recommendedRole || task.claimableRole || 'No role';
}

function ExplainButton({
  task,
  projectManagerBusy,
  onMessage,
  label = 'Explain',
}: {
  task: QueueTask;
  projectManagerBusy: boolean;
  onMessage: (message: string) => void;
  label?: string;
}) {
  return (
    <button
      className={label === 'How to test' ? 'test-help-action' : undefined}
      type="button"
      onClick={() => {
        requestTaskExplanation(task.id, projectManagerBusy, onMessage);
      }}
    >
      {label}
    </button>
  );
}

function TaskRow({
  task,
  dashboard,
  kind,
  projectManagerBusy,
  onMessage,
  onPromoteNextTodo,
  onDeleteRequest,
}: {
  task: QueueTask;
  dashboard: DashboardPayload;
  kind: 'active' | 'next' | 'waiting' | 'superseded';
  projectManagerBusy: boolean;
  onMessage: (message: string) => void;
  onPromoteNextTodo?: (task: QueueTask) => void;
  onDeleteRequest?: (task: QueueTask) => void;
}) {
  const worker = workerForTask(task.id, dashboard.agents || []);
  return (
    <article className="task-sheet-row">
      <div>
        <strong>{task.id}</strong>
        <p>{task.title}</p>
        <small>{taskStatusLabel(task, kind)} - {taskRoleLabel(task, kind)} - {worker ? worker.agentName : 'No worker'}</small>
      </div>
      <div className="task-row-actions">
        {kind === 'waiting' || kind === 'superseded' ? null : (
          <ExplainButton
            task={task}
            projectManagerBusy={projectManagerBusy}
            onMessage={onMessage}
            label="Explain"
          />
        )}
        {kind === 'next' ? (
          <>
            <button
              type="button"
              onClick={() => {
                void runTaskAction('/api/tasks/promote', { id: task.id }, onMessage)
                  .then((result) => {
                    if (result) onPromoteNextTodo?.(task);
                  });
              }}
            >
              Promote
            </button>
            <button className="danger-task-action" type="button" onClick={() => runTaskAction('/api/tasks/next-todo/remove', { id: task.id }, onMessage)}>Remove</button>
          </>
        ) : null}
        {kind === 'active' ? (
          <>
            <button className="todo-task-action" type="button" onClick={() => runTaskAction('/api/tasks/active/move-to-next', { id: task.id }, onMessage)}>Move to Todo</button>
            <button className="danger-task-action" type="button" onClick={() => onDeleteRequest?.(task)}>Delete</button>
          </>
        ) : null}
      </div>
    </article>
  );
}

export function TaskSlidePanels({
  dashboard,
  projectManagerBusy,
  openPanel,
  closing,
  onOpenPanel,
  onClosePanel,
  onMessage,
  onPromoteNextTodo,
  themeId,
}: TaskSlidePanelsProps) {
  const [deleteTarget, setDeleteTarget] = useState<QueueTask | null>(null);
  const active = useMemo(() => dashboard.activeTaskQueue || [], [dashboard.activeTaskQueue]);
  const next = dashboard.nextTodo || [];
  const waitingFollowUps = dashboard.followUpWaitQueue || [];
  const supersededReviews = dashboard.supersededReviewQueue || [];
  const hasActivePanelRows = waitingFollowUps.length > 0 || supersededReviews.length > 0 || active.length > 0;
  const activePanelLabel = openPanel === 'active' ? 'Active Tasks' : 'Todo Tasks';
  const buttonComposition = getThemeButtonsComposition(themeId);

  function panelIcon(panel: Exclude<TaskPanelKind, null>) {
    return <span className={`task-panel-icon task-panel-icon-${panel}`} aria-hidden="true" />;
  }

  function panelTabLabel(firstLine: string, secondLine: string) {
    return (
      <span className="task-panel-tab-label">
        <span>{firstLine}</span>
        <span>{secondLine}</span>
      </span>
    );
  }

  return (
    <>
      <div className="task-panel-tabs" aria-label="Task panels">
        <button
          type="button"
          data-task-panel-tab="active"
          style={buttonCompositionToStyle('task-tab', buttonComposition.activeTasks)}
          onClick={() => onOpenPanel('active')}
        >
          {panelTabLabel('Active', 'Tasks')}
        </button>
        <button
          type="button"
          data-task-panel-tab="next"
          style={buttonCompositionToStyle('task-tab', buttonComposition.todoTasks)}
          onClick={() => onOpenPanel('next')}
        >
          {panelTabLabel('Todo', 'Tasks')}
        </button>
      </div>

      {openPanel ? (
        <div
          className={`task-panel-overlay ${closing ? 'task-panel-overlay-closing' : ''}`}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClosePanel();
          }}
        >
          <section className={`task-slide-sheet ${closing ? 'task-slide-sheet-closing' : ''}`} role="dialog" aria-modal="true" aria-label={openPanel === 'active' ? 'Active tasks' : 'Todo tasks'}>
            <button className="task-sheet-handle" type="button" onClick={onClosePanel}>
              {panelIcon(openPanel)}
              <span>{activePanelLabel}</span>
            </button>
            <header>
              <h2>{panelIcon(openPanel)}{activePanelLabel}</h2>
              <button type="button" onClick={onClosePanel}>Close</button>
            </header>

            {openPanel === 'active' ? (
              <div className="task-sheet-content">
                {waitingFollowUps.length > 0 ? (
                  <section className="task-waiting-band">
                    <h3>Waiting on Follow-ups</h3>
                    {waitingFollowUps.map((task) => (
                      <TaskRow key={task.id} task={task} dashboard={dashboard} kind="waiting" projectManagerBusy={projectManagerBusy} onMessage={onMessage} />
                    ))}
                  </section>
                ) : null}
                {supersededReviews.length > 0 ? (
                  <section className="task-superseded-band">
                    <h3>Superseded by Follow-ups</h3>
                    {supersededReviews.map((task) => (
                      <TaskRow key={task.id} task={task} dashboard={dashboard} kind="superseded" projectManagerBusy={projectManagerBusy} onMessage={onMessage} />
                    ))}
                  </section>
                ) : null}
                {!hasActivePanelRows ? <p className="sheet-empty">No active tasks found.</p> : active.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    dashboard={dashboard}
                    kind="active"
                    projectManagerBusy={projectManagerBusy}
                    onMessage={onMessage}
                    onPromoteNextTodo={onPromoteNextTodo}
                    onDeleteRequest={setDeleteTarget}
                  />
                ))}
              </div>
            ) : (
              <div className="task-sheet-content">
                {next.length === 0 ? <p className="sheet-empty">No todo tasks found.</p> : next.map((task) => (
                  <TaskRow key={task.id} task={task} dashboard={dashboard} kind="next" projectManagerBusy={projectManagerBusy} onMessage={onMessage} onPromoteNextTodo={onPromoteNextTodo} />
                ))}
              </div>
            )}
          </section>
        </div>
      ) : null}

      {deleteTarget ? (
        <div className="archive-dialog-overlay" role="presentation">
          <section className="archive-dialog" role="dialog" aria-modal="true" aria-label={`Delete ${deleteTarget.id}`}>
            <header>
              <h2>Delete active task</h2>
              <button type="button" onClick={() => setDeleteTarget(null)}>Close</button>
            </header>
            <div className="archive-dialog-body">
              <p><strong>{deleteTarget.id}</strong></p>
              <p>{deleteTarget.title}</p>
              <p className="archive-warning">Are you sure you want to delete this task from Active Tasks?</p>
              <div className="archive-dialog-actions">
                <button type="button" onClick={() => setDeleteTarget(null)}>Cancel</button>
                <button
                  type="button"
                  className="danger-action"
                  onClick={() => {
                    void runTaskAction('/api/tasks/active/delete', { id: deleteTarget.id }, onMessage)
                      .then(() => setDeleteTarget(null));
                  }}
                >
                  Delete task
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
