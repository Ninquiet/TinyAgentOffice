import { useState } from 'react';

export type TaskPanelKind = 'active' | 'next' | null;
type DashboardScreen = 'secretary' | 'builder' | 'activeTasks' | 'todoTasks' | 'options' | null;

const SECRETARY_CLOSE_MS = 200;
const TASK_PANEL_CLOSE_MS = 180;
const BUILDER_CLOSE_MS = 180;
const OPTIONS_CLOSE_MS = 180;

export function useDashboardWindows() {
  const [activeScreen, setActiveScreen] = useState<DashboardScreen>(null);
  const [closingScreen, setClosingScreen] = useState<DashboardScreen>(null);

  function openSecretary() {
    setClosingScreen(null);
    setActiveScreen('secretary');
  }

  function closeSecretary() {
    if (activeScreen !== 'secretary') return;
    setClosingScreen('secretary');
    window.setTimeout(() => {
      setActiveScreen((current) => (current === 'secretary' ? null : current));
      setClosingScreen((current) => (current === 'secretary' ? null : current));
    }, SECRETARY_CLOSE_MS);
  }

  function openTaskPanel(panel: Exclude<TaskPanelKind, null>) {
    setClosingScreen(null);
    setActiveScreen(panel === 'active' ? 'activeTasks' : 'todoTasks');
  }

  function closeTaskPanel() {
    const taskPanelOpen = activeScreen === 'activeTasks' || activeScreen === 'todoTasks';
    if (!taskPanelOpen) return;
    const screen = activeScreen;
    setClosingScreen(screen);
    window.setTimeout(() => {
      setActiveScreen((current) => (current === screen ? null : current));
      setClosingScreen((current) => (current === screen ? null : current));
    }, TASK_PANEL_CLOSE_MS);
  }

  function openBuilder() {
    setClosingScreen(null);
    setActiveScreen('builder');
  }

  function closeBuilder() {
    if (activeScreen !== 'builder') return;
    setClosingScreen('builder');
    window.setTimeout(() => {
      setActiveScreen((current) => (current === 'builder' ? null : current));
      setClosingScreen((current) => (current === 'builder' ? null : current));
    }, BUILDER_CLOSE_MS);
  }

  function openOptions() {
    setClosingScreen(null);
    setActiveScreen('options');
  }

  function closeOptions() {
    if (activeScreen !== 'options') return;
    setClosingScreen('options');
    window.setTimeout(() => {
      setActiveScreen((current) => (current === 'options' ? null : current));
      setClosingScreen((current) => (current === 'options' ? null : current));
    }, OPTIONS_CLOSE_MS);
  }

  function focusMainWindow() {
    if (activeScreen === 'secretary') closeSecretary();
    else if (activeScreen === 'activeTasks' || activeScreen === 'todoTasks') closeTaskPanel();
    else if (activeScreen === 'builder') closeBuilder();
    else if (activeScreen === 'options') closeOptions();
  }

  const taskPanelOpen: TaskPanelKind = activeScreen === 'activeTasks'
    ? 'active'
    : activeScreen === 'todoTasks'
      ? 'next'
      : null;

  return {
    activeScreen,
    secretaryOpen: activeScreen === 'secretary',
    secretaryClosing: closingScreen === 'secretary',
    builderOpen: activeScreen === 'builder',
    builderClosing: closingScreen === 'builder',
    optionsOpen: activeScreen === 'options',
    optionsClosing: closingScreen === 'options',
    taskPanelOpen,
    taskPanelClosing: closingScreen === 'activeTasks' || closingScreen === 'todoTasks',
    openSecretary,
    closeSecretary,
    openBuilder,
    closeBuilder,
    openOptions,
    closeOptions,
    openTaskPanel,
    closeTaskPanel,
    focusMainWindow,
  };
}
