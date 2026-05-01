import type { AgentItem, AgentRegistration, AgentState, LoggedInAgent } from '../../types/agent.js';
import type { InfoCommandChoice } from '../../types/choices.js';
import type { NodeId } from '../../types/data-model.js';

export interface LoginAgentParams {
  agent_id: string;
  node_id: NodeId;
  discord_channel_id: string;
  money: number;
  items: AgentItem[];
}

export class AgentStateStore {
  private readonly registrations = new Map<string, AgentRegistration>();
  private readonly registrationsByApiKey = new Map<string, AgentRegistration>();
  private readonly loggedInAgents = new Map<string, LoggedInAgent>();
  private readonly excludedInfoCommandsByAgent = new Map<string, Set<InfoCommandChoice>>();

  constructor(initialRegistrations: AgentRegistration[] = []) {
    for (const registration of initialRegistrations) {
      this.register(registration);
    }
  }

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
    this.loggedInAgents.delete(agentId);
    this.excludedInfoCommandsByAgent.delete(agentId);
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

  login(params: LoginAgentParams): LoggedInAgent {
    const registration = this.getById(params.agent_id);
    if (!registration) {
      throw new Error(`Unknown agent: ${params.agent_id}`);
    }

    const loggedInAgent: LoggedInAgent = {
      agent_id: registration.agent_id,
      agent_name: registration.agent_name,
      node_id: params.node_id,
      state: 'idle',
      discord_channel_id: params.discord_channel_id,
      pending_conversation_id: null,
      current_conversation_id: null,
      active_transfer_id: null,
      pending_transfer_id: null,
      pending_server_announcement_ids: [],
      active_server_announcement_id: null,
      last_action_id: null,
      last_rejected_action_id: null,
      last_used_item_id: null,
      money: params.money,
      items: [...params.items],
    };

    this.loggedInAgents.set(registration.agent_id, loggedInAgent);
    return loggedInAgent;
  }

  logout(agentId: string): LoggedInAgent | null {
    const loggedInAgent = this.loggedInAgents.get(agentId) ?? null;
    if (loggedInAgent) {
      this.loggedInAgents.delete(agentId);
      this.excludedInfoCommandsByAgent.delete(agentId);
    }
    return loggedInAgent;
  }

  getLoggedIn(agentId: string): LoggedInAgent | null {
    return this.loggedInAgents.get(agentId) ?? null;
  }

  listLoggedIn(): LoggedInAgent[] {
    return [...this.loggedInAgents.values()].sort(
      (left, right) => left.agent_name.localeCompare(right.agent_name) || left.agent_id.localeCompare(right.agent_id),
    );
  }

  isLoggedIn(agentId: string): boolean {
    return this.loggedInAgents.has(agentId);
  }

  setState(agentId: string, state: AgentState): LoggedInAgent {
    const loggedInAgent = this.mustGetLoggedIn(agentId);
    loggedInAgent.state = state;
    return loggedInAgent;
  }

  setNode(agentId: string, nodeId: NodeId): LoggedInAgent {
    const loggedInAgent = this.mustGetLoggedIn(agentId);
    loggedInAgent.node_id = nodeId;
    return loggedInAgent;
  }

  setPendingConversation(agentId: string, conversationId: string | null): LoggedInAgent {
    const loggedInAgent = this.mustGetLoggedIn(agentId);
    loggedInAgent.pending_conversation_id = conversationId;
    return loggedInAgent;
  }

  setCurrentConversation(agentId: string, conversationId: string | null): LoggedInAgent {
    const loggedInAgent = this.mustGetLoggedIn(agentId);
    loggedInAgent.current_conversation_id = conversationId;
    return loggedInAgent;
  }

  setActiveTransfer(agentId: string, transferId: string | null): LoggedInAgent {
    const loggedInAgent = this.mustGetLoggedIn(agentId);
    loggedInAgent.active_transfer_id = transferId;
    return loggedInAgent;
  }

  setPendingTransfer(agentId: string, transferId: string | null): LoggedInAgent {
    const loggedInAgent = this.mustGetLoggedIn(agentId);
    loggedInAgent.pending_transfer_id = transferId;
    return loggedInAgent;
  }

  addPendingServerAnnouncement(agentId: string, serverAnnouncementId: string): LoggedInAgent {
    const loggedInAgent = this.mustGetLoggedIn(agentId);
    if (!loggedInAgent.pending_server_announcement_ids.includes(serverAnnouncementId)) {
      loggedInAgent.pending_server_announcement_ids.push(serverAnnouncementId);
    }
    return loggedInAgent;
  }

  removePendingServerAnnouncement(agentId: string, serverAnnouncementId: string): LoggedInAgent {
    const loggedInAgent = this.mustGetLoggedIn(agentId);
    loggedInAgent.pending_server_announcement_ids = loggedInAgent.pending_server_announcement_ids.filter((id) => id !== serverAnnouncementId);
    return loggedInAgent;
  }

  clearPendingServerAnnouncements(agentId: string): LoggedInAgent {
    const loggedInAgent = this.mustGetLoggedIn(agentId);
    loggedInAgent.pending_server_announcement_ids = [];
    return loggedInAgent;
  }

  setActiveServerAnnouncement(agentId: string, serverAnnouncementId: string | null): LoggedInAgent {
    const loggedInAgent = this.mustGetLoggedIn(agentId);
    loggedInAgent.active_server_announcement_id = serverAnnouncementId;
    return loggedInAgent;
  }

  clearActiveServerAnnouncement(agentId: string): LoggedInAgent {
    return this.setActiveServerAnnouncement(agentId, null);
  }

  setLastAction(agentId: string, actionId: string | null): LoggedInAgent {
    const loggedInAgent = this.mustGetLoggedIn(agentId);
    loggedInAgent.last_action_id = actionId;
    return loggedInAgent;
  }

  setLastRejectedAction(agentId: string, actionId: string | null): LoggedInAgent {
    const loggedInAgent = this.mustGetLoggedIn(agentId);
    loggedInAgent.last_rejected_action_id = actionId;
    return loggedInAgent;
  }

  setLastUsedItem(agentId: string, itemId: string | null): LoggedInAgent {
    const loggedInAgent = this.mustGetLoggedIn(agentId);
    loggedInAgent.last_used_item_id = itemId;
    return loggedInAgent;
  }

  addExcludedInfoCommand(agentId: string, command: InfoCommandChoice): void {
    this.mustGetLoggedIn(agentId);
    const excluded = this.excludedInfoCommandsByAgent.get(agentId) ?? new Set<InfoCommandChoice>();
    excluded.add(command);
    this.excludedInfoCommandsByAgent.set(agentId, excluded);
  }

  clearExcludedInfoCommands(agentId: string): void {
    this.excludedInfoCommandsByAgent.delete(agentId);
  }

  clearInfoCommandFromAllAgents(command: InfoCommandChoice): void {
    for (const commands of this.excludedInfoCommandsByAgent.values()) {
      commands.delete(command);
    }
  }

  getExcludedInfoCommands(agentId: string): ReadonlySet<InfoCommandChoice> {
    return this.excludedInfoCommandsByAgent.get(agentId) ?? new Set<InfoCommandChoice>();
  }

  setMoney(agentId: string, money: number): LoggedInAgent {
    const loggedInAgent = this.mustGetLoggedIn(agentId);
    loggedInAgent.money = money;
    return loggedInAgent;
  }

  addMoney(agentId: string, delta: number): LoggedInAgent {
    const loggedInAgent = this.mustGetLoggedIn(agentId);
    loggedInAgent.money = Math.max(0, loggedInAgent.money + delta);
    return loggedInAgent;
  }

  setItems(agentId: string, items: AgentItem[]): LoggedInAgent {
    const loggedInAgent = this.mustGetLoggedIn(agentId);
    loggedInAgent.items = [...items];
    return loggedInAgent;
  }

  private mustGetLoggedIn(agentId: string): LoggedInAgent {
    const loggedInAgent = this.getLoggedIn(agentId);
    if (!loggedInAgent) {
      throw new Error(`Agent is not logged in: ${agentId}`);
    }
    return loggedInAgent;
  }
}
