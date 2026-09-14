import { presetKey, useDashboardStore } from '../store';
import { AgentCard } from './AgentCard';
import type { FleetPreset } from '../types';

function AgentSlot({ preset }: { preset: FleetPreset }) {
  const key = presetKey(preset.name, preset.role);
  const sessionKey = useDashboardStore((state) => state.agentKeyByPresetKey[key]);
  const session = useDashboardStore((state) => (sessionKey ? state.agentsById[sessionKey] : undefined));
  return <AgentCard preset={preset} session={session} />;
}

export function AgentGrid() {
  const presets = useDashboardStore((state) => state.fleetPresets);

  if (presets.length === 0) {
    return <div className="empty">No daemon presets saved.</div>;
  }

  return (
    <div className="agent-grid">
      {presets.map((preset) => (
        <AgentSlot key={`${preset.name}:${preset.role}`} preset={preset} />
      ))}
    </div>
  );
}
