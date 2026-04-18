import { describe, expect, it } from 'vitest';

import { createFixtureSnapshot } from './fixtures/snapshot.js';
import type { SpectatorSnapshot } from '../../worker/src/contracts/spectator-snapshot.js';
import {
  buildAgentRenderTargets,
  buildSelectionRingModels,
  findSelectedGroupNodeId,
} from '../components/map/agent-render-model.js';

function createGroupedSnapshot(): SpectatorSnapshot {
  const snapshot = createFixtureSnapshot();

  return {
    ...snapshot,
    agents: [
      {
        agent_id: 'zeta',
        agent_name: 'Zeta',
        node_id: '1-2',
        state: 'idle',
        status_emoji: '💤',
      },
      {
        agent_id: 'alpha',
        agent_name: 'Alpha',
        node_id: '1-2',
        state: 'moving',
        status_emoji: '🚶',
      },
      {
        agent_id: 'charlie',
        agent_name: 'Charlie',
        node_id: '1-2',
        state: 'in_action',
        status_emoji: '🛠️',
      },
      {
        agent_id: 'bravo',
        agent_name: 'Bravo',
        node_id: '1-2',
        state: 'in_conversation',
        status_emoji: '💬',
      },
      snapshot.agents[1]!,
    ],
  };
}

describe('agent render model', () => {
  it('builds single-agent targets with avatar fallback metadata', () => {
    const snapshot = createFixtureSnapshot();
    const targets = buildAgentRenderTargets(snapshot, 'alice');
    const aliceTarget = targets.find((target) => target.kind === 'single' && target.agent.agentId === 'alice');

    expect(aliceTarget).toMatchObject({
      kind: 'single',
      agent: {
        agentId: 'alice',
        avatarUrl: 'https://example.com/alice.png',
        fallbackLabel: 'A',
        isSelected: true,
      },
    });
  });

  it('builds grouped targets with up to three visible avatars and keeps the selected agent visible', () => {
    const targets = buildAgentRenderTargets(createGroupedSnapshot(), 'zeta');
    const groupTarget = targets.find(
      (target): target is Extract<(typeof targets)[number], { kind: 'group' }> =>
        target.kind === 'group' && target.nodeId === '1-2',
    );

    expect(groupTarget).toMatchObject({
      kind: 'group',
      count: 4,
    });
    expect(groupTarget?.visibleAvatars).toHaveLength(3);
    expect(groupTarget?.visibleAvatars.map((avatar) => avatar.agentId)).toEqual(['alpha', 'bravo', 'zeta']);
    expect(groupTarget?.visibleAvatars.at(-1)?.isSelected).toBe(true);
  });

  it('builds a selection ring for only the selected agent inside a group and exposes the selected group node', () => {
    const targets = buildAgentRenderTargets(createGroupedSnapshot(), 'charlie');
    const rings = buildSelectionRingModels(targets);

    expect(findSelectedGroupNodeId(targets, 'charlie')).toBe('1-2');
    expect(rings).toHaveLength(1);
    expect(rings[0]?.agentId).toBe('charlie');
  });
});
