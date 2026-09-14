interface ReviewerUnavailableDialogProps {
  onClose: () => void;
}

export function ReviewerUnavailableDialog({ onClose }: ReviewerUnavailableDialogProps) {
  return (
    <div className="reviewer-dialog-overlay" role="presentation">
      <section className="reviewer-dialog" role="dialog" aria-modal="true" aria-label="No reviewer available">
        <header>
          <h2>No reviewer connected</h2>
          <button type="button" onClick={onClose}>Close</button>
        </header>
        <div className="reviewer-dialog-body">
          <p>No connected agent can review this request.</p>
          <p>Connect or activate a Senior Pro or Project Manager to ask for testing guidance.</p>
          <div className="reviewer-dialog-actions">
            <button type="button" onClick={onClose}>OK</button>
          </div>
        </div>
      </section>
    </div>
  );
}
