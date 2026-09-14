interface AutoModeToggleProps {
  enabled: boolean;
  onToggle: () => void;
}

export function AutoModeToggle({ enabled, onToggle }: AutoModeToggleProps) {
  return (
    <button
      className={`auto-mode-toggle ${enabled ? 'auto-mode-on' : 'auto-mode-off'}`}
      type="button"
      aria-label="Automatic mode"
      aria-pressed={enabled}
      onClick={onToggle}
    >
      <span className="auto-mode-title">Auto mode</span>
      <span className="auto-mode-track">
        <span className="auto-mode-thumb" />
      </span>
      <span className="auto-mode-cyber-panel" aria-hidden="true">
        <span className="auto-mode-cyber-data">A-01</span>
        <span className="auto-mode-cyber-title">
          <span>AUTO</span>
          <span>MODE</span>
        </span>
        <span className="auto-mode-cyber-switch">
          <span className="auto-mode-cyber-rail">
            <span className="auto-mode-cyber-glow" />
            <span className="auto-mode-cyber-thumb">
              <span className="auto-mode-cyber-core" />
            </span>
          </span>
        </span>
        <span className="auto-mode-cyber-status">
          <span className="auto-mode-cyber-status-off">STANDBY</span>
          <span className="auto-mode-cyber-status-on">ACTIVE</span>
        </span>
      </span>
    </button>
  );
}
