import type { QueueTask } from '../types';
import { TaskCardPreset } from './TaskCardPreset';

export type UserTaskPrimaryAction = 'how-to-test' | 'user-approved' | 'decline';
export type UserTaskMenuAction = 'discuss-task-sp' | 'archive';

export class UserTaskPreset extends TaskCardPreset<UserTaskPrimaryAction, UserTaskMenuAction> {
  readonly id = 'user-task';

  readonly primaryActions: UserTaskPrimaryAction[] = [
    'how-to-test',
    'user-approved',
    'decline',
  ];

  readonly menuActions: UserTaskMenuAction[] = [
    'discuss-task-sp',
    'archive',
  ];

  statusLabel(task: QueueTask) {
    if (task.status === 'DONE') return 'Waiting for your approval or decline';
    if (task.status === 'REVIEW_NEEDED' && task.claimableRole) return `Waiting for ${task.claimableRole} review`;
    return task.status;
  }

  roleLabel(task: QueueTask, explicitRoleLabel?: string) {
    return explicitRoleLabel || task.recommendedRole || task.claimableRole || 'No role';
  }
}

export const userTaskPreset = new UserTaskPreset();
