import type { TelemetryPayload } from '../types';

interface TelemetryPaletteProps {
  open: boolean;
  busy: boolean;
  telemetry: TelemetryPayload | null;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onReset: () => void;
}

function formatDate(value?: string | null) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function TelemetryPalette({
  open,
  busy,
  telemetry,
  error,
  onClose,
  onRefresh,
  onReset,
}: TelemetryPaletteProps) {
  if (!open) return null;

  return (
    <div className="telemetry-palette-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="telemetry-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Telemetry"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="telemetry-palette-header">
          <div>
            <h2>Telemetry</h2>
            <p>Since reset: {formatDate(telemetry?.resetAt)}</p>
          </div>
          <button type="button" className="telemetry-icon-button" onClick={onClose} aria-label="Close telemetry">
            x
          </button>
        </header>

        {error ? <p className="telemetry-error">{error}</p> : null}

        <div className="telemetry-totals" aria-label="Totals">
          <span><strong>{telemetry?.totals.dispatches ?? 0}</strong> dispatches</span>
          <span><strong>{telemetry?.totals.completions ?? 0}</strong> completions</span>
          <span><strong>{telemetry?.totals.reviews ?? 0}</strong> reviews</span>
          <span><strong>{telemetry?.totals.duplicateDispatches ?? 0}</strong> duplicates</span>
        </div>

        <div className="telemetry-role-list">
          {(telemetry?.roles || []).map((role) => (
            <article className="telemetry-role-row" key={role.role}>
              <div>
                <strong>{role.role}</strong>
                <small>Last: {formatDate(role.lastActivityAt)}</small>
              </div>
              <dl>
                <div><dt>Prompts</dt><dd>{role.prompts}</dd></div>
                <div><dt>Done</dt><dd>{role.completions}</dd></div>
                <div><dt>Reviews</dt><dd>{role.reviews}</dd></div>
                <div><dt>Reports</dt><dd>{role.reports}</dd></div>
                <div><dt>Dupes</dt><dd>{role.duplicateDispatches}</dd></div>
              </dl>
            </article>
          ))}
        </div>

        {telemetry?.anomalies?.length ? (
          <div className="telemetry-anomalies">
            <h3>Anomalies</h3>
            {telemetry.anomalies.slice(0, 6).map((item, index) => (
              <p key={`${item.kind}-${item.taskId || index}-${item.at || index}`}>{item.message}</p>
            ))}
          </div>
        ) : null}

        <footer className="telemetry-palette-actions">
          <button type="button" onClick={onRefresh} disabled={busy}>Refresh</button>
          <button type="button" className="danger-action" onClick={onReset} disabled={busy}>Clear Metrics</button>
        </footer>
      </section>
    </div>
  );
}
