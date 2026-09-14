import { useState } from 'react';
import { runTaskAction } from '../taskActions';
import type { QueueTask } from '../types';

interface ArchiveTaskButtonProps {
  task: QueueTask;
  onMessage: (message: string) => void;
}

export function ArchiveTaskButton({ task, onMessage }: ArchiveTaskButtonProps) {
  const [open, setOpen] = useState(false);

  function archiveTask() {
    void runTaskAction('/api/tasks/archive-direct', { taskId: task.id }, onMessage);
    setOpen(false);
  }

  return (
    <>
      <button type="button" className="danger-action" onClick={() => setOpen(true)}>
        Archive
      </button>
      {open ? (
        <div className="archive-dialog-overlay" role="presentation">
          <section className="archive-dialog" role="dialog" aria-modal="true" aria-label={`Archive ${task.id}`}>
            <header>
              <h2>Archive Task</h2>
              <button type="button" onClick={() => setOpen(false)}>Close</button>
            </header>
            <div className="archive-dialog-body">
              <strong>{task.id}</strong>
              <p>{task.title}</p>
              <p className="archive-warning">Archive this task without further review?</p>
              <div className="archive-dialog-actions">
                <button type="button" onClick={() => setOpen(false)}>Cancel</button>
                <button type="button" className="danger-action" onClick={archiveTask}>
                  Archive task
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
