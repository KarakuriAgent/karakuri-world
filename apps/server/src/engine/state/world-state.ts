import type { AgentItem, AgentRegistration, AgentState, LoggedInAgent } from '../../types/agent.js';
import type { InfoCommandChoice } from '../../types/choices.js';
import type { NodeId } from '../../types/data-model.js';
import { AgentStateStore, type LoginAgentParams } from './agent-state.js';
import { ConversationStateStore } from './conversation-state.js';
import { RecentServerEventsStore } from './recent-server-events-state.js';
import { ServerEventStateStore } from './server-event-state.js';

export class WorldState {
  readonly conversations = new ConversationStateStore();
  readonly serverEvents = new ServerEventStateStore();
  readonly recentServerEvents = new RecentServerEventsStore();
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

  login(params: LoginAgentParams): LoggedInAgent {
    return this.agents.login(params);
  }

  logout(agentId: string): LoggedInAgent | null {
    return this.agents.logout(agentId);
  }

  getLoggedIn(agentId: string): LoggedInAgent | null {
    return this.agents.getLoggedIn(agentId);
  }

  listLoggedIn(): LoggedInAgent[] {
    return this.agents.listLoggedIn();
  }

  isLoggedIn(agentId: string): boolean {
    return this.agents.isLoggedIn(agentId);
  }

  setState(agentId: string, state: AgentState): LoggedInAgent {
    return this.agents.setState(agentId, state);
  }

  setNode(agentId: string, nodeId: NodeId): LoggedInAgent {
    return this.agents.setNode(agentId, nodeId);
  }

  setPendingConversation(agentId: string, conversationId: string | null): LoggedInAgent {
    return this.agents.setPendingConversation(agentId, conversationId);
  }

  setCurrentConversation(agentId: string, conversationId: string | null): LoggedInAgent {
    return this.agents.setCurrentConversation(agentId, conversationId);
  }

  addPendingServerEvent(agentId: string, serverEventId: string): LoggedInAgent {
    return this.agents.addPendingServerEvent(agentId, serverEventId);
  }

  removePendingServerEvent(agentId: string, serverEventId: string): LoggedInAgent {
    return this.agents.removePendingServerEvent(agentId, serverEventId);
  }

  clearPendingServerEvents(agentId: string): LoggedInAgent {
    return this.agents.clearPendingServerEvents(agentId);
  }

  setActiveServerEvent(agentId: string, serverEventId: string | null): LoggedInAgent {
    return this.agents.setActiveServerEvent(agentId, serverEventId);
  }

  clearActiveServerEvent(agentId: string): LoggedInAgent {
    return this.agents.clearActiveServerEvent(agentId);
  }

  setLastAction(agentId: string, actionId: string | null): LoggedInAgent {
    return this.agents.setLastAction(agentId, actionId);
  }

  setLastRejectedAction(agentId: string, actionId: string | null): LoggedInAgent {
    return this.agents.setLastRejectedAction(agentId, actionId);
  }

  setLastUsedItem(agentId: string, itemId: string | null): LoggedInAgent {
    return this.agents.setLastUsedItem(agentId, itemId);
  }

  addExcludedInfoCommand(agentId: string, command: InfoCommandChoice): void {
    this.agents.addExcludedInfoCommand(agentId, command);
  }

  clearExcludedInfoCommands(agentId: string): void {
    this.agents.clearExcludedInfoCommands(agentId);
  }

  getExcludedInfoCommands(agentId: string): ReadonlySet<InfoCommandChoice> {
    return this.agents.getExcludedInfoCommands(agentId);
  }

  setMoney(agentId: string, money: number): LoggedInAgent {
    return this.agents.setMoney(agentId, money);
  }

  addMoney(agentId: string, delta: number): LoggedInAgent {
    return this.agents.addMoney(agentId, delta);
  }

  setItems(agentId: string, items: AgentItem[]): LoggedInAgent {
    return this.agents.setItems(agentId, items);
  }
}
