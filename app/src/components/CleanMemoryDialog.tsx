interface CleanMemoryDialogProps {
  agentName: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function CleanMemoryDialog({ agentName, busy = false, error = null, onConfirm, onCancel }: CleanMemoryDialogProps) {
  return (
    <div className="blueprint-prompt-overlay" role="presentation">
      <section className="blueprint-prompt" role="dialog" aria-modal="true" aria-label={`Clean ${agentName} memory`}>
        <h2>Clean local agent memory?</h2>
        <p>{`This resets ${agentName}'s memory for this project only. The cartridge settings stay unchanged.`}</p>
        <p>The agent must be stopped before its memory can be cleaned.</p>
        <p>The current memory will be archived so the operation remains recoverable.</p>
        {error ? <p className="blueprint-prompt-error">{error}</p> : null}
        <div className="blueprint-prompt-actions">
          <button className="danger-action" type="button" onClick={onConfirm} disabled={busy}>Clean local memory</button>
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      </section>
    </div>
  );
}
