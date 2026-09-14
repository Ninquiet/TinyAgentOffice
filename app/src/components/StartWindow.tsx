import { useEffect, useState } from 'react';
import { getProjects, openProject, type RecentProject } from '../api';
import { getDesktopApi } from '../desktop-api';

interface StartWindowProps {
  onProjectOpened: (projectRoot: string) => void;
}

export function StartWindow({ onProjectOpened }: StartWindowProps) {
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
      </section>
    </main>
  );
}
