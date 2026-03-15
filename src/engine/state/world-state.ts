import type { AgentRegistration, AgentState, JoinedAgent } from '../../types/agent.js';
import type { NodeId } from '../../types/data-model.js';
import { AgentStateStore, type JoinAgentParams } from './agent-state.js';
import { ConversationStateStore } from './conversation-state.js';
import { ServerEventStateStore } from './server-event-state.js';

export class WorldState {
  readonly conversations = new ConversationStateStore();
  readonly serverEvents = new ServerEventStateStore();
  private readonly agents: AgentStateStore;

  constructor(initialRegistrations: AgentRegistration[] = []) {
    this.agents = new AgentStateStore(initialRegistrations);
  }

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
}
