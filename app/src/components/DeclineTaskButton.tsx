import { useState } from 'react';
import { runTaskAction } from '../taskActions';
import type { QueueTask } from '../types';

interface DeclineTaskButtonProps {
  task: QueueTask;
  onMessage: (message: string) => void;
}

export function DeclineTaskButton({ task, onMessage }: DeclineTaskButtonProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  function close() {
    setOpen(false);
    setReason('');
  }

  function declineTask() {
    const trimmed = reason.trim();
    if (!trimmed) {
      onMessage('Decline reason is required.');
      return;
    }
    void runTaskAction('/api/tasks/user-decline', { taskId: task.id, reason: trimmed }, onMessage);
    close();
  }

  return (
    <>
      <button type="button" className="decline-action" onClick={() => setOpen(true)}>
        Decline
      </button>
      {open ? (
        <div className="decline-dialog-overlay" role="presentation">
          <section className="decline-dialog" role="dialog" aria-modal="true" aria-label={`Decline ${task.id}`}>
            <header>
              <h2>Decline Task</h2>
              <button type="button" onClick={close}>Close</button>
            </header>
            <div className="decline-dialog-body">
              <strong>{task.id}</strong>
              <p>{task.title}</p>
              <label>
                <span>Why are you declining this completion?</span>
                <textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Describe what is wrong or missing so Senior Pro can plan the fix."
                />
              </label>
              <div className="decline-dialog-actions">
                <button type="button" onClick={close}>Cancel</button>
                <button type="button" className="danger-action" onClick={declineTask}>
                  Decline task completion
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
