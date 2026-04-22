import type { SpectatorAgentSnapshot } from '../../worker/src/contracts/spectator-snapshot.js';

export function sortAgentsForSidebar(agents: SpectatorAgentSnapshot[]): SpectatorAgentSnapshot[] {
  return [...agents].sort((left, right) => {
    const leftPriority = left.state === 'idle' ? 1 : 0;
    const rightPriority = right.state === 'idle' ? 1 : 0;

    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    return left.agent_name.localeCompare(right.agent_name, 'ja');
  });
}
