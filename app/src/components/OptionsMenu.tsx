import type { DashboardTheme } from '../types';

interface OptionsMenuProps {
  open: boolean;
  closing?: boolean;
  themes: DashboardTheme[];
  selectedThemeId: string;
  themeStatus: string;
  onOpen: () => void;
  onClose: () => void;
  onSelectTheme: (themeId: string) => void;
  onCloseApp?: () => void;
}

export function OptionsMenu({
  open,
  closing = false,
  themes,
  selectedThemeId,
  themeStatus,
  onOpen,
  onClose,
  onSelectTheme,
  onCloseApp,
}: OptionsMenuProps) {
  return (
    <>
      <button
        className="options-menu-button"
        type="button"
        aria-label="Open options"
        aria-expanded={open}
        onClick={onOpen}
      >
        <span />
        <span />
        <span />
      </button>
      {open ? (
        <div
          className={`options-overlay ${closing ? 'options-overlay-closing' : ''}`}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <section className={`options-panel ${closing ? 'options-panel-closing' : ''}`} role="dialog" aria-modal="true" aria-label="Options">
            <header>
              <h2>Options</h2>
              <button type="button" onClick={onClose}>Close</button>
            </header>
            <div className="options-panel-body">
              <label className="options-field">
                <span>Theme</span>
                <select value={selectedThemeId} onChange={(event) => onSelectTheme(event.target.value)}>
                  {themes.map((theme) => (
                    <option key={theme.id} value={theme.id}>{theme.name}</option>
                  ))}
                </select>
              </label>
              <p className="options-status">{themeStatus}</p>
              {onCloseApp ? (
                <button className="options-close-app-button" type="button" onClick={onCloseApp}>
                  Close application
                </button>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
