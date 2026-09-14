import { useState } from 'react';
import { ReviewTaskCard } from './ReviewTaskCard';
import { answerAgentAttention, dismissSecretaryMessage, openOpencodeUpdateTerminal } from '../api';
import { userTaskPreset } from '../task-presets/UserTaskPreset';
import type { MaintenanceNotification, QueueTask, SecretaryInboxItem } from '../types';

export interface AgentAttentionNotification {
  id: string;
  botId: string;
  title: string;
  body: string;
  advice: string;
}

interface SecretaryPanelProps {
  reviewTasks: QueueTask[];
  maintenanceNotifications: MaintenanceNotification[];
  agentAttentionNotifications: AgentAttentionNotification[];
  inboxItems: SecretaryInboxItem[];
  closing?: boolean;
  onClose: () => void;
  onHowToTest: (task: QueueTask) => void;
  onDiscussWithSenior: (task: QueueTask) => void;
  onOpenAgentAttention: (botId: string) => void;
  onChangeAgentModel: (botId: string) => void;
  onMessage: (message: string) => void;
}

export function SecretaryPanel({
  reviewTasks,
  maintenanceNotifications,
  agentAttentionNotifications,
  inboxItems,
  closing = false,
  onClose,
  onHowToTest,
  onDiscussWithSenior,
  onOpenAgentAttention,
  onChangeAgentModel,
  onMessage,
}: SecretaryPanelProps) {
  const hasNotifications = reviewTasks.length > 0 || maintenanceNotifications.length > 0 || agentAttentionNotifications.length > 0 || inboxItems.length > 0;

  async function fixMaintenanceNotification(notification: MaintenanceNotification) {
    try {
      if (notification.type === 'opencode-update' || notification.type === 'opencode-missing') {
        const result = await openOpencodeUpdateTerminal();
        onMessage(result.message || 'OpenCode maintenance terminal opened.');
        return;
      }
      onMessage(`No fix action is available for ${notification.title}.`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Could not run maintenance action.');
    }
  }

  return (
    <div
      className={`secretary-panel-overlay ${closing ? 'secretary-panel-overlay-closing' : ''}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className={`secretary-panel ${closing ? 'secretary-panel-closing' : ''}`} role="dialog" aria-modal="true" aria-label="Secretary notifications">
        <header>
          <h2>Secretary Notifications</h2>
          <button type="button" onClick={onClose}>Close</button>
        </header>

        <div className="secretary-panel-content">
          {!hasNotifications ? (
            <p className="sheet-empty">No live notifications right now.</p>
          ) : (
            <>
              {inboxItems.map((item) => (
                <SecretaryInboxCard key={item.id} item={item} onMessage={onMessage} />
              ))}
              {maintenanceNotifications.map((notification) => (
                <article className="secretary-notification-card secretary-maintenance-card" key={notification.id}>
                  <div>
                    <strong>{notification.title}</strong>
                    <p>{notification.body}</p>
                    <small>{notification.severity} - maintenance</small>
                  </div>
                  <div className="task-row-actions">
                    <button type="button" onClick={() => fixMaintenanceNotification(notification)}>
                      {notification.actionLabel || 'Fix'}
                    </button>
                  </div>
                </article>
              ))}
              {agentAttentionNotifications.map((notification) => (
                <article className="secretary-notification-card secretary-agent-attention-card" key={notification.id}>
                  <div>
                    <strong>{notification.title}</strong>
                    <p>{notification.body}</p>
                    <p>{notification.advice}</p>
                    <small>attention - agent</small>
                  </div>
                  <div className="task-row-actions">
                    <button type="button" onClick={() => onOpenAgentAttention(notification.botId)}>
                      Review
                    </button>
                    <button type="button" onClick={() => onChangeAgentModel(notification.botId)}>
                      Change model
                    </button>
                  </div>
                </article>
              ))}
              {reviewTasks.map((task) => (
                <ReviewTaskCard
                  key={task.id}
                  task={task}
                  preset={userTaskPreset}
                  className="secretary-notification-card"
                  onHowToTest={onHowToTest}
                  onDiscussWithSenior={onDiscussWithSenior}
                  onMessage={onMessage}
                />
              ))}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function SecretaryInboxCard({ item, onMessage }: { item: SecretaryInboxItem; onMessage: (message: string) => void }) {
  const [customAnswer, setCustomAnswer] = useState('');
  const [busy, setBusy] = useState(false);

  function run(action: () => Promise<{ message?: string }>, fallback: string) {
    setBusy(true);
    action()
      .then((result) => onMessage(result.message || fallback))
      .catch((error) => onMessage(error instanceof Error ? error.message : 'Action failed.'))
      .finally(() => setBusy(false));
  }

  function answer(value: string) {
    const text = value.trim();
    if (!text || !item.sessionId) return;
    run(() => answerAgentAttention(item.sessionId as string, text), 'Answer sent.');
  }

  return (
    <article className={`secretary-notification-card secretary-inbox-card secretary-inbox-${item.type}`}>
      <div className="secretary-inbox-body">
        <strong>{item.agentName}</strong>
        <p>{item.body}</p>
        <small>{`${item.role}${item.taskId ? ` · ${item.taskId}` : ''}`}</small>
        {item.type === 'question' ? (
          <div className="secretary-answer-controls">
            <div className="secretary-answer-options">
              {item.options.map((option) => (
                <button type="button" key={option} disabled={busy || !item.sessionId} onClick={() => answer(option)}>{option}</button>
              ))}
            </div>
            <form onSubmit={(event) => { event.preventDefault(); answer(customAnswer); }}>
              <input
                value={customAnswer}
                onChange={(event) => setCustomAnswer(event.target.value)}
                placeholder="Custom answer"
                aria-label={`Custom answer for ${item.agentName}`}
                disabled={busy || !item.sessionId}
              />
              <button type="submit" disabled={busy || !item.sessionId || !customAnswer.trim()}>Send</button>
            </form>
            {!item.sessionId ? <small>The agent session is no longer available.</small> : null}
          </div>
        ) : null}
      </div>
      {item.type === 'message' ? (
        <button
          className="secretary-message-dismiss"
          type="button"
          aria-label={`Dismiss message from ${item.agentName}`}
          disabled={busy}
          onClick={() => run(() => dismissSecretaryMessage(item.id), 'Message dismissed.')}
        >×</button>
      ) : null}
    </article>
  );
}
