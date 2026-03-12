import type { AgentRegistration, AgentState, JoinedAgent } from '../../types/agent.js';
import type { NodeId, ServerConfig } from '../../types/data-model.js';
import type { WorldSnapshot } from '../../types/snapshot.js';
import type { ConversationData } from '../../types/conversation.js';
import type { ServerEventInstance } from '../../types/server-event.js';
import { AgentStateStore, type JoinAgentParams } from './agent-state.js';
import { ConversationStateStore } from './conversation-state.js';
import { ServerEventStateStore } from './server-event-state.js';

export class WorldState {
  readonly conversations = new ConversationStateStore();
  readonly serverEvents = new ServerEventStateStore();
  private readonly agents = new AgentStateStore();

  constructor(private readonly config: ServerConfig) {}

  register(registration: AgentRegistration): AgentRegistration {
    return this.agents.register(registration);
  }

  delete(agentId: string): AgentRegistration | null {
    return this.agents.delete(agentId);
  }

  getByApiKey(apiKey: string): AgentRegistration | null {
    return this.agents.getByApiKey(apiKey);
  }

  getById(agentId: string): AgentRegistration | null {
    return this.agents.getById(agentId);
  }

  list(): AgentRegistration[] {
    return this.agents.list();
  }

  join(params: JoinAgentParams): JoinedAgent {
    return this.agents.join(params);
  }

  leave(agentId: string): JoinedAgent | null {
    return this.agents.leave(agentId);
  }

  getJoined(agentId: string): JoinedAgent | null {
    return this.agents.getJoined(agentId);
  }

  listJoined(): JoinedAgent[] {
    return this.agents.listJoined();
  }

  isJoined(agentId: string): boolean {
    return this.agents.isJoined(agentId);
  }

  setState(agentId: string, state: AgentState): JoinedAgent {
    return this.agents.setState(agentId, state);
  }

  setNode(agentId: string, nodeId: NodeId): JoinedAgent {
    return this.agents.setNode(agentId, nodeId);
  }

  setPendingConversation(agentId: string, conversationId: string | null): JoinedAgent {
    return this.agents.setPendingConversation(agentId, conversationId);
  }

  addPendingServerEvent(agentId: string, serverEventId: string): JoinedAgent {
    return this.agents.addPendingServerEvent(agentId, serverEventId);
  }

  removePendingServerEvent(agentId: string, serverEventId: string): JoinedAgent {
    return this.agents.removePendingServerEvent(agentId, serverEventId);
  }

  clearPendingServerEvents(agentId: string): JoinedAgent {
    return this.agents.clearPendingServerEvents(agentId);
  }

  getSnapshot(): WorldSnapshot {
    return {
      world: {
        name: this.config.world.name,
        description: this.config.world.description,
      },
      map: {
        rows: this.config.map.rows,
        cols: this.config.map.cols,
      },
      agents: this.listJoined().map((agent) => ({
        agent_id: agent.agent_id,
        agent_name: agent.agent_name,
        node_id: agent.node_id,
        state: agent.state,
        discord_channel_id: agent.discord_channel_id,
      })),
      conversations: this.conversations.list().map((conversation: ConversationData) => ({
        conversation_id: conversation.conversation_id,
        status: conversation.status,
        initiator_agent_id: conversation.initiator_agent_id,
        target_agent_id: conversation.target_agent_id,
        current_turn: conversation.current_turn,
        current_speaker_agent_id: conversation.current_speaker_agent_id,
        closing_reason: conversation.closing_reason,
      })),
      server_events: this.serverEvents.list().map((serverEvent: ServerEventInstance) => ({
        server_event_id: serverEvent.server_event_id,
        event_id: serverEvent.event_id,
        name: serverEvent.name,
        description: serverEvent.description,
        choices: serverEvent.choices,
        delivered_agent_ids: serverEvent.delivered_agent_ids,
        pending_agent_ids: serverEvent.pending_agent_ids,
      })),
      generated_at: Date.now(),
    };
  }
}
