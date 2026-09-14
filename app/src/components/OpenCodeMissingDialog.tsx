import { openOpencodeUpdateTerminal } from '../api';
import type { MaintenanceNotification } from '../types';

interface OpenCodeMissingDialogProps {
  notification: MaintenanceNotification;
  onClose: () => void;
  onMessage: (message: string) => void;
}

export function OpenCodeMissingDialog({ notification, onClose, onMessage }: OpenCodeMissingDialogProps) {
  async function fix() {
    try {
      const result = await openOpencodeUpdateTerminal();
      onMessage(result.message || 'OpenCode install terminal opened.');
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Could not open OpenCode install helper.');
    }
  }

  return (
    <div className="reviewer-dialog-overlay" role="presentation">
      <section className="reviewer-dialog" role="dialog" aria-modal="true" aria-label="OpenCode is not installed">
        <header>
          <h2>{notification.title}</h2>
          <button type="button" onClick={onClose}>Close</button>
        </header>
        <div className="reviewer-dialog-body">
          <p>{notification.body}</p>
          {notification.installCommand ? <p><strong>Recommended command:</strong> <code>{notification.installCommand}</code></p> : null}
          <div className="reviewer-dialog-actions">
            <button type="button" onClick={fix}>{notification.actionLabel || 'Fix'}</button>
            <button type="button" onClick={onClose}>Later</button>
          </div>
        </div>
      </section>
    </div>
  );
}
