import { describe, expect, it } from 'vitest';

import { requireActionableAgent, requireInfoCommandReadyAgent } from '../../../src/domain/agent-guards.js';
import { WorldError } from '../../../src/types/api.js';
import { createTestWorld } from '../../helpers/test-world.js';

describe('agent guards', () => {
  it('allows actionable agents while idle or during an active server announcement', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);

    expect(requireActionableAgent(engine, alice.agent_id).agent_id).toBe(alice.agent_id);

    engine.state.setState(alice.agent_id, 'in_action');
    engine.state.setActiveServerAnnouncement(alice.agent_id, 'server-announcement-1');
    expect(requireActionableAgent(engine, alice.agent_id).agent_id).toBe(alice.agent_id);
  });

  it('rejects non-actionable or already-consumed info requests', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);

    engine.state.setState(alice.agent_id, 'moving');
    expect(() => requireActionableAgent(engine, alice.agent_id, { activityLabel: 'move' })).toThrow(
      expect.objectContaining<Partial<WorldError>>({ code: 'state_conflict' }),
    );

    engine.state.setState(alice.agent_id, 'in_action');
    expect(() => requireInfoCommandReadyAgent(engine, alice.agent_id, 'get_perception')).toThrow(
      expect.objectContaining<Partial<WorldError>>({ code: 'state_conflict' }),
    );

    engine.state.setState(alice.agent_id, 'in_conversation');
    expect(() => requireInfoCommandReadyAgent(engine, alice.agent_id, 'get_perception')).toThrow(
      expect.objectContaining<Partial<WorldError>>({ code: 'state_conflict' }),
    );

    engine.state.setState(alice.agent_id, 'idle');
    engine.state.addExcludedInfoCommand(alice.agent_id, 'get_map');
    expect(() => requireInfoCommandReadyAgent(engine, alice.agent_id, 'get_map')).toThrow(
      expect.objectContaining<Partial<WorldError>>({ code: 'info_already_consumed' }),
    );
  });

  it('rejects info requests while a transfer offer is pending even during a server announcement window', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);
    engine.state.setActiveServerAnnouncement(alice.agent_id, 'server-announcement-1');
    engine.state.setPendingTransfer(alice.agent_id, 'transfer-pending-1');

    expect(() => requireInfoCommandReadyAgent(engine, alice.agent_id, 'get_status')).toThrow(
      expect.objectContaining<Partial<WorldError>>({ code: 'state_conflict' }),
    );
  });

  it('clears the excluded info command set when an agent logs out and re-logs in', async () => {
    const { engine } = createTestWorld();
    const alice = await engine.registerAgent({ discord_bot_id: 'bot-alice' });
    await engine.loginAgent(alice.agent_id);

    engine.state.addExcludedInfoCommand(alice.agent_id, 'get_map');
    engine.state.addExcludedInfoCommand(alice.agent_id, 'get_perception');
    expect(engine.state.getExcludedInfoCommands(alice.agent_id).size).toBe(2);

    await engine.logoutAgent(alice.agent_id);

    await engine.loginAgent(alice.agent_id);
    expect(engine.state.getExcludedInfoCommands(alice.agent_id).size).toBe(0);
  });
});
