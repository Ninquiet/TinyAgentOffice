import { useEffect, useState } from 'react';
import { ArchiveTaskButton } from './ArchiveTaskButton';
import { DeclineTaskButton } from './DeclineTaskButton';
import type { UserTaskPreset } from '../task-presets/UserTaskPreset';
import { runTaskAction } from '../taskActions';
import type { QueueTask } from '../types';

interface ReviewTaskCardProps {
  task: QueueTask;
  preset: UserTaskPreset;
  className?: string;
  roleLabel?: string;
  onHowToTest: (task: QueueTask) => void;
  onDiscussWithSenior: (task: QueueTask) => void;
  onMessage: (message: string) => void;
}

export function ReviewTaskCard({
  task,
  preset,
  className = 'task-sheet-row',
  roleLabel,
  onHowToTest,
  onDiscussWithSenior,
  onMessage,
}: ReviewTaskCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return undefined;

    function closeMenu() {
      setMenuOpen(false);
    }

    const timer = window.setTimeout(() => {
      window.addEventListener('pointerdown', closeMenu);
    }, 0);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', closeMenu);
    };
  }, [menuOpen]);

  return (
    <article className={className}>
      <div>
        <strong>{task.id}</strong>
        <p>{task.title}</p>
        <small>{preset.statusLabel(task)} - {preset.roleLabel(task, roleLabel)}</small>
      </div>
      <div className="task-row-actions">
        {preset.primaryActions.includes('how-to-test') ? (
          <button className="test-help-action" type="button" onClick={() => onHowToTest(task)}>How to test</button>
        ) : null}
        {preset.primaryActions.includes('user-approved') ? (
          <button type="button" onClick={() => runTaskAction('/api/tasks/pm-review', { taskId: task.id }, onMessage)}>User Approved</button>
        ) : null}
        {preset.primaryActions.includes('decline') ? (
          <DeclineTaskButton task={task} onMessage={onMessage} />
        ) : null}
        <div className="task-more-menu" onPointerDown={(event) => event.stopPropagation()}>
          <button
            className="task-more-button"
            type="button"
            aria-label={`More actions for ${task.id}`}
            onClick={() => setMenuOpen((current) => !current)}
          >
            ...
          </button>
          {menuOpen ? (
            <div className="task-more-menu-items">
              {preset.menuActions.includes('discuss-task-sp') ? (
                <button type="button" onClick={() => onDiscussWithSenior(task)}>Discuss task SP</button>
              ) : null}
              {preset.menuActions.includes('archive') ? (
                <ArchiveTaskButton task={task} onMessage={onMessage} />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}
