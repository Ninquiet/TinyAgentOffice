import { postJson } from './api';

export async function runTaskAction(url: string, payload: unknown, onMessage: (message: string) => void) {
  try {
    const result = await postJson<{ message?: string }>(url, payload);
    onMessage(result.message || 'Action completed.');
    return result;
  } catch (error) {
    onMessage(error instanceof Error ? error.message : 'Action failed.');
    return null;
  }
}

export function requestTaskExplanation(
  taskId: string,
  projectManagerBusy: boolean,
  onMessage: (message: string) => void,
) {
  if (projectManagerBusy) {
    onMessage('Project Manager is busy.');
    return;
  }
  void runTaskAction('/api/tasks/explain-task', { taskId }, onMessage);
}

export function requestHowToTest(
  taskId: string,
  reviewerAvailable: boolean,
  projectManagerBusy: boolean,
  onReviewerUnavailable: () => void,
  onMessage: (message: string) => void,
) {
  if (!reviewerAvailable) {
    onReviewerUnavailable();
    return;
  }
  if (projectManagerBusy) {
    onMessage('Project Manager is busy.');
    return;
  }
  void runTaskAction('/api/tasks/explain-test', { taskId }, onMessage);
}
