interface CloseApplicationDialogProps {
  busy?: boolean;
  liveAgentCount: number;
  onCancel: () => void;
  onCloseAppOnly: () => void;
  onCloseAppAndAgents: () => void;
}

export function CloseApplicationDialog({
  busy = false,
  liveAgentCount,
  onCancel,
  onCloseAppOnly,
  onCloseAppAndAgents,
}: CloseApplicationDialogProps) {
  // With no live terminals there is nothing to close alongside the app, so the
  // question does not apply and there is only one action.
  //
  // This used to be asked anyway, with "Close app and agents" disabled whenever
  // the count was zero. Clicking it did nothing and said nothing, so the app
  // simply would not close -- and since the count only includes agents with a
  // live terminal, that was every project with no running sessions rather than
  // some rare edge case. A disabled control that explains nothing is
  // indistinguishable from a broken one.
  const hasLiveAgents = liveAgentCount > 0;

  return (
    <div className="close-app-dialog-overlay" role="presentation">
      <section className="close-app-dialog" role="dialog" aria-modal="true" aria-label="Close TinyAgentOffice">
        <header>
          <h2>Close TinyAgentOffice?</h2>
          <button type="button" onClick={onCancel} disabled={busy}>Close</button>
        </header>
        <div className="close-app-dialog-body">
          <p>
            {hasLiveAgents
              ? `${liveAgentCount} live agent session(s) are currently registered.`
              : 'No live agent sessions are currently registered.'}
          </p>
          {hasLiveAgents ? <p>Do you want to close the agent terminals too?</p> : null}
        </div>
        <div className="close-app-dialog-actions">
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          {hasLiveAgents ? (
            <>
              <button type="button" onClick={onCloseAppOnly} disabled={busy}>Close app only</button>
              <button className="danger-action" type="button" onClick={onCloseAppAndAgents} disabled={busy}>
                Close app and agents
              </button>
            </>
          ) : (
            <button type="button" onClick={onCloseAppOnly} disabled={busy}>Close TinyAgentOffice</button>
          )}
        </div>
      </section>
    </div>
  );
}
