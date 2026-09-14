import type { AgentStatus } from '../types';

export function StatusBadge({ status }: { status: AgentStatus | string }) {
  return <span className={`status-badge status-${status}`}>{status}</span>;
}
