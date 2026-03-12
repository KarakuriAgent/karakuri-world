import type { AgentRegistration, AgentState, JoinedAgent } from '../../types/agent.js';
import type { NodeId } from '../../types/data-model.js';

export interface JoinAgentParams {
  agent_id: string;
  node_id: NodeId;
  discord_channel_id: string;
}

export class AgentStateStore {
  private readonly registrations = new Map<string, AgentRegistration>();
  private readonly registrationsByApiKey = new Map<string, AgentRegistration>();
  private readonly joinedAgents = new Map<string, JoinedAgent>();

  register(registration: AgentRegistration): AgentRegistration {
    this.registrations.set(registration.agent_id, registration);
    this.registrationsByApiKey.set(registration.api_key, registration);
    return registration;
  }

  delete(agentId: string): AgentRegistration | null {
    const registration = this.registrations.get(agentId);
    if (!registration) {
      return null;
    }

    this.registrations.delete(agentId);
    this.registrationsByApiKey.delete(registration.api_key);
    this.joinedAgents.delete(agentId);
    return registration;
  }

  getByApiKey(apiKey: string): AgentRegistration | null {
    return this.registrationsByApiKey.get(apiKey) ?? null;
  }

  getById(agentId: string): AgentRegistration | null {
    return this.registrations.get(agentId) ?? null;
  }

  list(): AgentRegistration[] {
    return [...this.registrations.values()].sort(
      (left, right) => left.agent_name.localeCompare(right.agent_name) || left.agent_id.localeCompare(right.agent_id),
    );
  }

  join(params: JoinAgentParams): JoinedAgent {
    const registration = this.getById(params.agent_id);
    if (!registration) {
      throw new Error(`Unknown agent: ${params.agent_id}`);
    }

    const joinedAgent: JoinedAgent = {
      agent_id: registration.agent_id,
      agent_name: registration.agent_name,
      node_id: params.node_id,
      state: 'idle',
      discord_channel_id: params.discord_channel_id,
      pending_conversation_id: null,
      pending_server_event_ids: [],
    };

    this.joinedAgents.set(registration.agent_id, joinedAgent);
    return joinedAgent;
  }

  leave(agentId: string): JoinedAgent | null {
    const joinedAgent = this.joinedAgents.get(agentId) ?? null;
    if (joinedAgent) {
      this.joinedAgents.delete(agentId);
    }
    return joinedAgent;
  }

  getJoined(agentId: string): JoinedAgent | null {
    return this.joinedAgents.get(agentId) ?? null;
  }

  listJoined(): JoinedAgent[] {
    return [...this.joinedAgents.values()].sort(
      (left, right) => left.agent_name.localeCompare(right.agent_name) || left.agent_id.localeCompare(right.agent_id),
    );
  }

  isJoined(agentId: string): boolean {
    return this.joinedAgents.has(agentId);
  }

  setState(agentId: string, state: AgentState): JoinedAgent {
    const joinedAgent = this.mustGetJoined(agentId);
    joinedAgent.state = state;
    return joinedAgent;
  }

  setNode(agentId: string, nodeId: NodeId): JoinedAgent {
    const joinedAgent = this.mustGetJoined(agentId);
    joinedAgent.node_id = nodeId;
    return joinedAgent;
  }

  setPendingConversation(agentId: string, conversationId: string | null): JoinedAgent {
    const joinedAgent = this.mustGetJoined(agentId);
    joinedAgent.pending_conversation_id = conversationId;
    return joinedAgent;
  }

  addPendingServerEvent(agentId: string, serverEventId: string): JoinedAgent {
    const joinedAgent = this.mustGetJoined(agentId);
    if (!joinedAgent.pending_server_event_ids.includes(serverEventId)) {
      joinedAgent.pending_server_event_ids.push(serverEventId);
      joinedAgent.pending_server_event_ids.sort();
    }
    return joinedAgent;
  }

  removePendingServerEvent(agentId: string, serverEventId: string): JoinedAgent {
    const joinedAgent = this.mustGetJoined(agentId);
    joinedAgent.pending_server_event_ids = joinedAgent.pending_server_event_ids.filter((id) => id !== serverEventId);
    return joinedAgent;
  }

  clearPendingServerEvents(agentId: string): JoinedAgent {
    const joinedAgent = this.mustGetJoined(agentId);
    joinedAgent.pending_server_event_ids = [];
    return joinedAgent;
  }

  private mustGetJoined(agentId: string): JoinedAgent {
    const joinedAgent = this.getJoined(agentId);
    if (!joinedAgent) {
      throw new Error(`Agent is not joined: ${agentId}`);
    }
    return joinedAgent;
  }
}
