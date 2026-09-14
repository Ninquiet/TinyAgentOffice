import { useEffect, useState } from 'react';
import { connectDashboardSocket, getDashboardSnapshot } from '../api';
import type { DashboardEvent, DashboardPayload, QueueTask } from '../types';

export function useDashboardData() {
  const [payload, setPayload] = useState<DashboardPayload>({});
  const [message, setMessage] = useState('');

  function promoteNextTodoLocally(task: QueueTask) {
    setPayload((current) => {
      const nextTodo = current.nextTodo || [];
      if (!nextTodo.some((entry) => entry.id === task.id)) return current;

      const activeTaskQueue = current.activeTaskQueue || [];
      const promotedTask = {
        ...task,
        section: 'active',
        status: 'TODO',
        claimableRole: task.claimableRole || task.recommendedRole,
        reason: task.reason || `Waiting for ${task.claimableRole || task.recommendedRole || 'worker'}`,
      };

      return {
        ...current,
        nextTodo: nextTodo.filter((entry) => entry.id !== task.id),
        activeTaskQueue: activeTaskQueue.some((entry) => entry.id === task.id)
          ? activeTaskQueue
          : [...activeTaskQueue, promotedTask],
      };
    });
  }

  useEffect(() => {
    getDashboardSnapshot()
      .then(setPayload)
      .catch((error) => setMessage(error instanceof Error ? error.message : 'Could not load dashboard state.'));

    return connectDashboardSocket((event: DashboardEvent) => {
      if (event.type === 'dashboard.snapshot') {
        setPayload(event.payload);
      } else if (event.type === 'agents.changed') {
        setPayload((current) => ({ ...current, agents: event.payload }));
      } else if (event.type === 'agent.upserted') {
        setPayload((current) => {
          const agents = [...(current.agents || [])];
          const idx = agents.findIndex((agent) => (
            (agent.sessionId && agent.sessionId === event.payload.agent.sessionId)
            || (!agent.sessionId && agent.agentName === event.payload.agent.agentName && agent.role === event.payload.agent.role)
          ));
          if (idx === -1) agents.push(event.payload.agent);
          else agents[idx] = event.payload.agent;
          return { ...current, agents };
        });
      } else if (event.type === 'agent.removed') {
        setPayload((current) => ({
          ...current,
          agents: (current.agents || []).filter((agent) => (
            agent.sessionId !== event.payload.key && `${agent.agentName}:${agent.roleAcronym || agent.role}` !== event.payload.key
          )),
        }));
      } else if (event.type === 'roles.changed') {
        setPayload((current) => ({ ...current, roles: event.payload }));
      } else if (event.type === 'queue.changed') {
        setPayload((current) => ({ ...current, [event.payload.queue]: event.payload.rows }));
      } else if (event.type === 'queues.changed') {
        setPayload((current) => ({ ...current, ...event.payload }));
      } else if (event.type === 'fleet.changed') {
        setPayload((current) => ({ ...current, fleetConfig: event.payload }));
      } else if (event.type === 'daemon.changed') {
        setPayload((current) => ({ ...current, daemonStatus: event.payload }));
      } else if (event.type === 'alerts.changed') {
        setPayload((current) => ({ ...current, alerts: event.payload }));
      } else if (event.type === 'maintenance.changed') {
        setPayload((current) => ({ ...current, maintenanceNotifications: event.payload }));
      } else if (event.type === 'secretary.changed') {
        setPayload((current) => ({ ...current, secretaryInbox: event.payload }));
      } else if (event.type === 'cartridges.changed') {
        setPayload((current) => ({ ...current, cartridges: event.payload }));
      } else if (event.type === 'blueprints.changed') {
        setPayload((current) => ({ ...current, blueprints: event.payload }));
      } else if (event.type === 'summary.changed') {
        setPayload((current) => ({ ...current, summary: event.payload }));
      } else if (event.type === 'dashboard.error') {
        setMessage(event.payload.error);
      }
    }, setMessage);
  }, []);

  return { payload, message, setMessage, promoteNextTodoLocally };
}
