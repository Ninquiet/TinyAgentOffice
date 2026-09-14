export function statusLabel(status: string) {
  if (status === 'has-tasks') return 'tasks ready';
  if (status === 'working') return 'working';
  if (status === 'attention') return 'attention';
  if (status === 'stalled') return 'stalled';
  return 'idle';
}

export function displayRole(role: unknown) {
  return typeof role === 'string' && role.trim() ? role.trim() : 'Agent';
}

export function roleClass(role: unknown) {
  return displayRole(role).replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
}
