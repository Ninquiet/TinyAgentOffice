import { postJson } from '../api';
import { useDashboardStore } from '../store';
import type { QueueTask } from '../types';

interface QueueTableProps {
  title?: string;
  rows: QueueTask[];
  empty: string;
  kind?: 'nextTodo' | 'userReview' | 'seniorReview' | 'plain';
}

function TaskActions({ task, kind }: { task: QueueTask; kind: QueueTableProps['kind'] }) {
  const setLastMessage = useDashboardStore((state) => state.setLastMessage);

  async function action(url: string, payload: unknown) {
    try {
      const result = await postJson<{ message?: string }>(url, payload);
      if (result.message) setLastMessage(result.message);
    } catch (error) {
      setLastMessage(error instanceof Error ? error.message : 'Action failed.');
    }
  }

  if (kind === 'nextTodo') {
    return (
      <div className="row-actions">
        <button onClick={() => action('/api/tasks/explain-task', { taskId: task.id })}>Explain</button>
        <button onClick={() => action('/api/tasks/promote', { id: task.id })}>Promote</button>
        <button className="danger" onClick={() => action('/api/tasks/next-todo/remove', { id: task.id })}>Remove</button>
      </div>
    );
  }

  if (kind === 'userReview') {
    return (
      <div className="row-actions">
        <button onClick={() => action('/api/tasks/explain-test', { taskId: task.id })}>How to test</button>
        <button onClick={() => action('/api/tasks/pm-review', { taskId: task.id })}>User Approved</button>
      </div>
    );
  }

  return null;
}

export function QueueTable({ rows, empty, kind = 'plain' }: QueueTableProps) {
  if (rows.length === 0) return <div className="empty">{empty}</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Task</th>
            <th>Role</th>
            <th>Priority</th>
            <th>Status</th>
            <th>Why visible</th>
            {kind !== 'plain' ? <th>Action</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((task) => (
            <tr key={task.id}>
              <td><strong>{task.id}</strong><br />{task.title}</td>
              <td>{task.recommendedRole || '-'}</td>
              <td>{task.priority || '-'}</td>
              <td>{task.status}</td>
              <td>{task.reason || task.source || ''}</td>
              {kind !== 'plain' ? <td><TaskActions task={task} kind={kind} /></td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
