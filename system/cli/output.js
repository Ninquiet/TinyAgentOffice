'use strict';

function formatResult(result, json) {
  if (json) return JSON.stringify(result, null, 2);

  if (result.claimable && result.availableWithOverride && result.unavailable && result.nextTodo) {
    const lines = [];
    lines.push(`Role: ${result.role}`);
    lines.push(`Task store: ${result.tasksPath}`);
    lines.push('');

    if (result.claimable.length > 0) {
      lines.push('Claimable tasks:');
      result.claimable.forEach((task, index) => {
        lines.push(`${index + 1}. ${task.id} - ${task.title}`);
        lines.push(`   Status: ${task.status}`);
        lines.push(`   Recommended role: ${task.recommendedRole || '-'}`);
        for (const reason of task.reasons) lines.push(`   Reason: ${reason}`);
      });
    }

    if (result.availableWithOverride.length > 0) {
      if (lines[lines.length - 1] !== '') lines.push('');
      lines.push('Also available with role override:');
      result.availableWithOverride.forEach((task, index) => {
        lines.push(`${index + 1}. ${task.id} - ${task.title}`);
        lines.push(`   Status: ${task.status}`);
        lines.push(`   Recommended role: ${task.recommendedRole || '-'}`);
        for (const reason of task.reasons) lines.push(`   Reason: ${reason}`);
      });
    }

    if (result.claimable.length === 0 && result.availableWithOverride.length === 0) {
      lines.push('No claimable active task is available for this role.');
    }

    if (result.unavailable.length > 0) {
      lines.push('');
      lines.push('Unavailable active tasks:');
      for (const task of result.unavailable) {
        lines.push(`- ${task.id} - ${task.title}`);
        for (const reason of task.reasons) lines.push(`  Reason: ${reason}`);
      }
    }

    if (result.nextTodo.length > 0) {
      lines.push('');
      lines.push('Next-Todo:');
      for (const task of result.nextTodo) {
        lines.push(`- ${task.id} - ${task.title}`);
        for (const reason of task.reasons) lines.push(`  Reason: ${reason}`);
      }
    }

    return lines.join('\n');
  }

  if (result.agents) {
    const lines = [];
    lines.push(`Registry: ${result.registryPath}`);
    lines.push(`Agents: ${result.agents.length}`);
    for (const agent of result.agents) {
      const task = agent.activeTaskId ? ` task=${agent.activeTaskId}` : '';
      const stale = agent.stale ? ' stale=true' : '';
      lines.push(`- ${agent.agentName} ${agent.roleAcronym}: ${agent.status}${task}${stale}`);
      if (agent.note) lines.push(`  Note: ${agent.note}`);
    }
    return lines.join('\n');
  }

  if (result.agent) {
    const lines = [];
    lines.push(`Registry: ${result.registryPath}`);
    lines.push(`${result.message}`);
    lines.push(`- ${result.agent.agentName} ${result.agent.roleAcronym}: ${result.agent.status}`);
    lines.push(`  Session: ${result.agent.sessionId}`);
    if (result.agent.activeTaskId) lines.push(`  Task: ${result.agent.activeTaskId}`);
    if (result.agent.note) lines.push(`  Note: ${result.agent.note}`);
    return lines.join('\n');
  }

  if (result.assigned === false) {
    return result.message;
  }

  if (result.task) {
    const lines = [];
    lines.push(result.message);
    lines.push(`${result.task.id} - ${result.task.title}`);
    lines.push(`Status: ${result.task.status}`);
    if (result.task.recommendedRole) lines.push(`Recommended role: ${result.task.recommendedRole}`);
    return lines.join('\n');
  }

  if (result.message) return result.message;
  return JSON.stringify(result, null, 2);
}

module.exports = {
  formatResult,
};
