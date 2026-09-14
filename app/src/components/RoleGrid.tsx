import { useDashboardStore } from '../store';
import { StatusBadge } from './StatusBadge';

export function RoleGrid() {
  const roles = useDashboardStore((state) => state.roles);
  return (
    <div className="role-grid">
      {roles.map((role) => (
        <article className="role-card" key={role.role}>
          <h3>{role.role}</h3>
          <StatusBadge status={role.label} />
          <p>{role.detail}</p>
        </article>
      ))}
    </div>
  );
}
