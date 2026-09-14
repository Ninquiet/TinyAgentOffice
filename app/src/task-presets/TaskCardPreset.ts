import type { QueueTask } from '../types';

export abstract class TaskCardPreset<PrimaryAction extends string, MenuAction extends string> {
  abstract readonly id: string;
  abstract readonly primaryActions: PrimaryAction[];
  abstract readonly menuActions: MenuAction[];

  abstract statusLabel(task: QueueTask): string;
  abstract roleLabel(task: QueueTask, explicitRoleLabel?: string): string;
}
