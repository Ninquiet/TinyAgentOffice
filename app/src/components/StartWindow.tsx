import { useEffect, useState } from 'react';
import { getProjects, openProject, type RecentProject } from '../api';
import { getDesktopApi } from '../desktop-api';

interface StartWindowProps {
  onProjectOpened: (projectRoot: string) => void;
}

export function StartWindow({ onProjectOpened }: StartWindowProps) {
  const linkedInUrl = 'https://www.linkedin.com/in/ninquiet/';
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [manualPath, setManualPath] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const desktopApi = getDesktopApi();

  useEffect(() => {
    document.documentElement.classList.add('start-window-active');
    return () => {
      document.documentElement.classList.remove('start-window-active');
    };
  }, []);

  useEffect(() => {
    getProjects()
      .then((response) => setRecentProjects(response.recentProjects || []))
      .catch((error) => setMessage(error instanceof Error ? error.message : 'Could not load recent projects.'));
  }, []);

  async function openProjectRoot(projectRoot: string) {
    const root = projectRoot.trim();
    if (!root) {
      setMessage('Choose a project folder first.');
      return;
    }

    setBusy(true);
    setMessage('Opening project...');
    try {
      const result = await openProject(root);
      setRecentProjects(result.recentProjects || []);
      onProjectOpened(result.project.root);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not open project.');
    } finally {
      setBusy(false);
    }
  }

  async function chooseFolder() {
    if (!desktopApi?.chooseProjectFolder) {
      setMessage('Folder picker is only available in the desktop app. Paste a path below.');
      return;
    }
    const folder = await desktopApi.chooseProjectFolder();
    if (folder) {
      setManualPath(folder);
      await openProjectRoot(folder);
    }
  }

  async function openLinkedIn() {
    if (desktopApi?.openExternal) {
      await desktopApi.openExternal(linkedInUrl);
      return;
    }
    window.open(linkedInUrl, '_blank', 'noopener,noreferrer');
  }

  return (
    <main className="start-window" aria-label="TinyAgentOffice start window">
      <section className="start-card">
        <header className="start-header">
          <div>
            <p className="start-kicker">TinyAgentOffice</p>
            <h1>Choose a project</h1>
          </div>
          {desktopApi?.isDesktop ? (
            <button type="button" className="start-close-button" onClick={() => void desktopApi.closeApp()}>
              Close
            </button>
          ) : null}
        </header>

        <div className="start-actions">
          <button type="button" className="start-primary-button" disabled={busy} onClick={chooseFolder}>
            Choose Folder
          </button>
          <div className="start-path-row">
            <input
              value={manualPath}
              onChange={(event) => setManualPath(event.target.value)}
              placeholder="Project folder path"
              onKeyDown={(event) => {
                if (event.key === 'Enter') void openProjectRoot(manualPath);
              }}
            />
            <button type="button" disabled={busy || !manualPath.trim()} onClick={() => void openProjectRoot(manualPath)}>
              Open
            </button>
          </div>
        </div>

        <section className="recent-projects" aria-label="Recent projects">
          <h2>Recent projects</h2>
          {recentProjects.length === 0 ? (
            <p>No recent projects yet.</p>
          ) : (
            <div className="recent-project-list">
              {recentProjects.map((project) => (
                <button
                  type="button"
                  key={project.root}
                  className="recent-project"
                  disabled={busy}
                  onClick={() => void openProjectRoot(project.root)}
                >
                  <strong>{project.name}</strong>
                  <span>{project.root}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        {message ? <p className="start-message">{message}</p> : null}

        <footer className="start-author-credit">
          <span>Creado por Jesus David Angarita</span>
          <button type="button" onClick={() => void openLinkedIn()} aria-label="LinkedIn de Jesus David Angarita">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5.1 3.5a2.1 2.1 0 1 1 0 4.2 2.1 2.1 0 0 1 0-4.2ZM3.3 9.2h3.6v11.3H3.3V9.2Zm5.8 0h3.4v1.5h.1c.5-.9 1.7-1.9 3.5-1.9 3.7 0 4.4 2.4 4.4 5.6v6.1h-3.6v-5.4c0-1.3 0-3-1.9-3s-2.2 1.4-2.2 2.9v5.5H9.1V9.2Z" />
            </svg>
          </button>
        </footer>
      </section>
    </main>
  );
}
