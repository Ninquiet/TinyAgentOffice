import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { getDashboardThemes } from '../api';
import type { DashboardTheme, DashboardThemesResponse } from '../types';

const THEME_STORAGE_KEY = 'agents-coordinator:new-ui:theme';
const FALLBACK_THEME_ID = 'cyberpunk';

function applyTheme(theme: DashboardTheme) {
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  for (const [key, value] of Object.entries(theme.cssVariables || {})) {
    root.style.setProperty(key, value);
  }
}

function initialThemeId() {
  const themeId = window.localStorage.getItem(THEME_STORAGE_KEY) || FALLBACK_THEME_ID;
  document.documentElement.dataset.theme = themeId;
  return themeId;
}

export function useDashboardThemes() {
  const [themeState, setThemeState] = useState<DashboardThemesResponse>({
    defaultThemeId: FALLBACK_THEME_ID,
    themes: [],
  });
  const [selectedThemeId, setSelectedThemeId] = useState(initialThemeId);
  const [status, setStatus] = useState('Loading themes...');

  useEffect(() => {
    let cancelled = false;
    getDashboardThemes()
      .then((response) => {
        if (cancelled) return;
        setThemeState(response);
        const exists = response.themes.some((theme) => theme.id === selectedThemeId);
        if (!exists) {
          setSelectedThemeId(response.defaultThemeId);
          window.localStorage.setItem(THEME_STORAGE_KEY, response.defaultThemeId);
        }
        setStatus(`${response.themes.length} theme(s) loaded.`);
      })
      .catch((error) => {
        if (!cancelled) setStatus(error instanceof Error ? error.message : 'Could not load themes.');
      });
    return () => {
      cancelled = true;
    };
  }, [selectedThemeId]);

  const selectedTheme = useMemo(
    () => themeState.themes.find((theme) => theme.id === selectedThemeId)
      || themeState.themes.find((theme) => theme.id === themeState.defaultThemeId),
    [selectedThemeId, themeState],
  );

  // Theme geometry must exist before cartridge layout effects measure sockets.
  // A passive effect briefly exposed the classic theme and persisted positions
  // measured against that transient layout.
  useLayoutEffect(() => {
    if (selectedTheme) applyTheme(selectedTheme);
  }, [selectedTheme]);

  function selectTheme(themeId: string) {
    setSelectedThemeId(themeId);
    window.localStorage.setItem(THEME_STORAGE_KEY, themeId);
  }

  return {
    themes: themeState.themes,
    selectedThemeId: selectedTheme?.id || selectedThemeId,
    status,
    selectTheme,
  };
}
