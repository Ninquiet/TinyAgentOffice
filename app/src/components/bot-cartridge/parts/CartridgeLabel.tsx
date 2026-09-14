import { displayRole, roleClass, statusLabel } from '../utils';

interface CartridgeLabelProps {
  role: string | undefined;
  name: string;
  model: string;
  status: string;
}

export function CartridgeLabel({ role, name, model, status }: CartridgeLabelProps) {
  const labelRole = displayRole(role);
  return (
    <div className="cartridge-label">
      <span className={`cartridge-role-badge cartridge-role-${roleClass(role)}`}>{labelRole}</span>
      <strong>{name}</strong>
      <small>{model}</small>
      <em>{statusLabel(status)}</em>
    </div>
  );
}
