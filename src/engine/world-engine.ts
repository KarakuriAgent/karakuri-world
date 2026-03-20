import { randomBytes, randomInt, randomUUID } from 'node:crypto';

import {
  executeAction as executeActionRequest,
  getAvailableActions as getAvailableActionsForAgent,
  handleActionCompleted,
} from '../domain/actions.js';
import {
  acceptConversation as acceptConversationRequest,
  cancelPendingConversation,
  forceEndConversation,
  handleAcceptTimeout,
  handleConversationInterval,
  handleTurnTimeout,
  rejectConversation as rejectConversationRequest,
  speak as speakInConversation,
  startConversation as startConversationRequest,
} from '../domain/conversation.js';
import { handleIdleReminderFired, startIdleReminder } from '../domain/idle-reminder.js';
import { getNodeConfig, isNodeWithinBounds, isPassable } from '../domain/map-utils.js';
import {
  cleanupServerEventsForAgent,
  fireServerEvent as fireConfiguredServerEvent,
  handleServerEventTimeout,
  selectServerEvent as selectRuntimeServerEvent,
} from '../domain/server-events.js';
import { executeMove, getAgentCurrentNode, getMovementTimer, handleMovementCompleted } from '../domain/movement.js';
import { executeWait as executeWaitRequest, handleWaitCompleted } from '../domain/wait.js';
import { getPerceptionData } from '../domain/perception.js';
import { WorldError } from '../types/api.js';
import type {
  ActionRequest,
  ActionResponse,
  AdminAgentSummary,
  AvailableActionsResponse,
  ConversationAcceptRequest,
  ConversationRejectRequest,
  ConversationSpeakRequest,
  ConversationSpeakResponse,
  ConversationStartRequest,
  ConversationStartResponse,
  FireServerEventResponse,
  LoginResponse,
  LogoutResponse,
  MoveRequest,
  MoveResponse,
  OkResponse,
  PerceptionResponse,
  ServerEventSelectRequest,
  WaitRequest,
  WaitResponse,
  WorldAgentsResponse,
} from '../types/api.js';
import type { AgentRegistration, AgentState } from '../types/agent.js';
import type { MapConfig, NodeId, ServerConfig } from '../types/data-model.js';
import type { WorldEvent } from '../types/event.js';
import type { ActionTimer } from '../types/timer.js';
import type { WorldSnapshot } from '../types/snapshot.js';
import { EventBus } from './event-bus.js';
import { TimerManager } from './timer-manager.js';
import { WorldState } from './state/world-state.js';

type EmittableWorldEvent<T extends WorldEvent = WorldEvent> = T extends WorldEvent
  ? Omit<T, 'event_id' | 'occurred_at'>
  : never;

export interface DiscordRuntimeAdapter {
  createAgentChannel(agentName: string, discordBotId: string): Promise<string>;
  deleteAgentChannel(channelId: string): Promise<void>;
  channelExists(channelId: string): Promise<boolean>;
}

export interface WorldEngineOptions {
  initialRegistrations?: AgentRegistration[];
  onRegistrationChanged?: (agents: AgentRegistration[]) => void;
}

export class WorldEngine {
  readonly timerManager = new TimerManager();
  readonly eventBus = new EventBus();
  readonly state: WorldState;
  private readonly onRegistrationChanged?: (agents: AgentRegistration[]) => void;
  private readonly loggingInAgentIds = new Set<string>();

  constructor(
    readonly config: ServerConfig,
    readonly discordBot: DiscordRuntimeAdapter,
    options: WorldEngineOptions = {},
  ) {
    this.state = new WorldState(options.initialRegistrations);
    this.onRegistrationChanged = options.onRegistrationChanged;
    this.timerManager.onFire('movement', (timer) => {
      handleMovementCompleted(this, timer);
    });
    this.timerManager.onFire('action', (timer) => {
      handleActionCompleted(this, timer);
    });
    this.timerManager.onFire('wait', (timer) => {
      handleWaitCompleted(this, timer);
    });
    this.timerManager.onFire('conversation_accept', (timer) => {
      handleAcceptTimeout(this, timer);
    });
    this.timerManager.onFire('conversation_interval', (timer) => {
      handleConversationInterval(this, timer);
    });
    this.timerManager.onFire('conversation_turn', (timer) => {
      handleTurnTimeout(this, timer);
    });
    this.timerManager.onFire('server_event_timeout', (timer) => {
      handleServerEventTimeout(this, timer);
    });
    this.timerManager.onFire('idle_reminder', (timer) => {
      handleIdleReminderFired(this, timer);
    });
  }

  registerAgent(input: { agent_name: string; agent_label: string; discord_bot_id: string }): AgentRegistration {
    const duplicate = this.state.list().find((agent) => agent.agent_name === input.agent_name);
    if (duplicate) {
      throw new WorldError(409, 'state_conflict', `Agent name already exists: ${input.agent_name}`);
    }

    const registration: AgentRegistration = {
      agent_id: `agent-${randomUUID()}`,
      agent_name: input.agent_name,
      agent_label: input.agent_label,
      api_key: `karakuri_${randomBytes(16).toString('hex')}`,
      discord_bot_id: input.discord_bot_id,
      created_at: Date.now(),
    };

    this.persistRegistrations([...this.state.list(), registration]);
    return this.state.register(registration);
  }

  async deleteAgent(agentId: string): Promise<boolean> {
    if (this.loggingInAgentIds.has(agentId)) {
      throw new WorldError(409, 'state_conflict', `Agent is currently logging in: ${agentId}`);
    }

    if (this.state.isLoggedIn(agentId)) {
      throw new WorldError(409, 'state_conflict', `Agent is currently logged in: ${agentId}`);
    }

    const registration = this.state.getById(agentId);
    if (!registration) {
      return false;
    }

    // Persist-then-mutate: remove registration first, then clean up Discord channel.
    this.persistRegistrations(this.state.list().filter((agent) => agent.agent_id !== agentId));
    this.state.delete(agentId);

    if (registration.discord_channel_id) {
      try {
        await this.discordBot.deleteAgentChannel(registration.discord_channel_id);
      } catch (error) {
        console.error('Failed to delete persisted agent channel.', error);
      }
    }

    return true;
  }

  getAgentByApiKey(apiKey: string): AgentRegistration | null {
    return this.state.getByApiKey(apiKey);
  }

  getAgentById(agentId: string): AgentRegistration | null {
    return this.state.getById(agentId);
  }

  listAgents(): AgentRegistration[] {
    return this.state.list();
  }

  listAgentSummaries(): AdminAgentSummary[] {
    return this.state.list().map((agent) => ({
      agent_id: agent.agent_id,
      agent_name: agent.agent_name,
      agent_label: agent.agent_label,
      discord_bot_id: agent.discord_bot_id,
      is_logged_in: this.state.isLoggedIn(agent.agent_id),
    }));
  }

  async loginAgent(agentId: string): Promise<LoginResponse> {
    const agent = this.state.getById(agentId);
    if (!agent) {
      throw new WorldError(404, 'not_found', `Agent not found: ${agentId}`);
    }

    if (this.loggingInAgentIds.has(agentId)) {
      throw new WorldError(409, 'state_conflict', `Agent is already logging in: ${agentId}`);
    }

    if (this.state.isLoggedIn(agentId)) {
      throw new WorldError(409, 'state_conflict', `Agent is already logged in: ${agentId}`);
    }

    if (this.config.spawn.nodes.length === 0) {
      throw new WorldError(500, 'invalid_config', 'Spawn nodes are not configured.');
    }

    this.loggingInAgentIds.add(agentId);
    let channelId = '';
    let channelCreated = false;

    try {
      if (agent.discord_channel_id && (await this.discordBot.channelExists(agent.discord_channel_id))) {
        channelId = agent.discord_channel_id;
      } else {
        channelId = await this.discordBot.createAgentChannel(agent.agent_name, agent.discord_bot_id);
        channelCreated = true;
      }

      const spawnNodeId = this.resolveSpawnNode(agent.last_node_id);

      const loggedInAgent = this.state.login({
        agent_id: agentId,
        node_id: spawnNodeId,
        discord_channel_id: channelId,
      });

      startIdleReminder(this, agentId);

      this.emitEvent({
        type: 'agent_logged_in',
        agent_id: loggedInAgent.agent_id,
        agent_name: loggedInAgent.agent_name,
        node_id: loggedInAgent.node_id,
        discord_channel_id: loggedInAgent.discord_channel_id,
      });

      return {
        channel_id: channelId,
        node_id: loggedInAgent.node_id,
      };
    } catch (error) {
      if (channelCreated && channelId) {
        await this.discordBot.deleteAgentChannel(channelId);
      }
      throw error;
    } finally {
      this.loggingInAgentIds.delete(agentId);
    }
  }

  async logoutAgent(agentId: string): Promise<LogoutResponse> {
    const loggedInAgent = this.state.getLoggedIn(agentId);
    if (!loggedInAgent) {
      throw new WorldError(409, 'state_conflict', `Agent is not logged in: ${agentId}`);
    }

    const leftNodeId = getAgentCurrentNode(this, loggedInAgent);
    const { cancelledState, cancelledActionName } = this.describeCancelledActivity(loggedInAgent.state, agentId);

    // Persist channel ID and position before tearing down runtime state.
    // This follows the same persist-then-mutate pattern as registerAgent/deleteAgent.
    const registration = this.state.getById(agentId);
    if (registration) {
      this.persistRegistrations(
        this.state.list().map((agent) =>
          agent.agent_id === agentId
            ? { ...agent, discord_channel_id: loggedInAgent.discord_channel_id, last_node_id: leftNodeId }
            : agent,
        ),
      );
      registration.discord_channel_id = loggedInAgent.discord_channel_id;
      registration.last_node_id = leftNodeId;
    }

    cancelPendingConversation(this, agentId);
    forceEndConversation(this, agentId);
    this.timerManager.cancelByAgent(agentId);
    cleanupServerEventsForAgent(this, agentId);
    this.state.setPendingConversation(agentId, null);
    this.state.clearPendingServerEvents(agentId);
    this.state.logout(agentId);

    this.emitEvent({
      type: 'agent_logged_out',
      agent_id: loggedInAgent.agent_id,
      agent_name: loggedInAgent.agent_name,
      node_id: leftNodeId,
      discord_channel_id: loggedInAgent.discord_channel_id,
      cancelled_state: cancelledState,
      cancelled_action_name: cancelledActionName,
    });

    return { status: 'ok' };
  }

  move(_agentId: string, _request: MoveRequest): MoveResponse {
    return executeMove(this, _agentId, _request);
  }

  executeAction(_agentId: string, _request: ActionRequest): ActionResponse {
    return executeActionRequest(this, _agentId, _request);
  }

  executeWait(_agentId: string, _request: WaitRequest): WaitResponse {
    return executeWaitRequest(this, _agentId, _request);
  }

  startConversation(_agentId: string, _request: ConversationStartRequest): ConversationStartResponse {
    return startConversationRequest(this, _agentId, _request);
  }

  acceptConversation(_agentId: string, _request: ConversationAcceptRequest): OkResponse {
    return acceptConversationRequest(this, _agentId, _request);
  }

  rejectConversation(_agentId: string, _request: ConversationRejectRequest): OkResponse {
    return rejectConversationRequest(this, _agentId, _request);
  }

  speak(_agentId: string, _request: ConversationSpeakRequest): ConversationSpeakResponse {
    return speakInConversation(this, _agentId, _request);
  }

  selectServerEvent(_agentId: string, _request: ServerEventSelectRequest): OkResponse {
    return selectRuntimeServerEvent(this, _agentId, _request);
  }

  fireServerEvent(_eventId: string): FireServerEventResponse {
    return fireConfiguredServerEvent(this, _eventId);
  }

  getAvailableActions(_agentId: string): AvailableActionsResponse {
    return getAvailableActionsForAgent(this, _agentId);
  }

  getPerception(agentId: string): PerceptionResponse {
    return getPerceptionData(this, agentId);
  }

  getMap(): MapConfig {
    return this.config.map;
  }

  getWorldAgents(): WorldAgentsResponse {
    const now = Date.now();
    return {
      agents: this.state.listLoggedIn().map((agent) => ({
        agent_id: agent.agent_id,
        agent_name: agent.agent_name,
        node_id: getAgentCurrentNode(this, agent, now),
        state: agent.state,
      })),
    };
  }

  getSnapshot(): WorldSnapshot {
    const now = Date.now();

    return {
      world: this.config.world,
      map: this.config.map,
      agents: this.state.listLoggedIn().map((agent) => {
        const movementTimer = agent.state === 'moving' ? getMovementTimer(this, agent.agent_id) : null;

        return {
          agent_id: agent.agent_id,
          agent_name: agent.agent_name,
          node_id: getAgentCurrentNode(this, agent, now),
          state: agent.state,
          discord_channel_id: agent.discord_channel_id,
          ...(movementTimer
            ? {
                movement: {
                  from_node_id: movementTimer.from_node_id,
                  to_node_id: movementTimer.to_node_id,
                  path: [...movementTimer.path],
                  arrives_at: movementTimer.fires_at,
                },
              }
            : {}),
        };
      }),
      conversations: this.state.conversations.list().map((conversation) => ({
        conversation_id: conversation.conversation_id,
        status: conversation.status,
        initiator_agent_id: conversation.initiator_agent_id,
        target_agent_id: conversation.target_agent_id,
        current_turn: conversation.current_turn,
        current_speaker_agent_id: conversation.current_speaker_agent_id,
        closing_reason: conversation.closing_reason,
      })),
      server_events: this.state.serverEvents.list().map((serverEvent) => ({
        server_event_id: serverEvent.server_event_id,
        event_id: serverEvent.event_id,
        name: serverEvent.name,
        description: serverEvent.description,
        choices: serverEvent.choices,
        delivered_agent_ids: serverEvent.delivered_agent_ids,
        pending_agent_ids: serverEvent.pending_agent_ids,
      })),
      generated_at: now,
    };
  }

  private describeCancelledActivity(
    state: AgentState,
    agentId: string,
  ): { cancelledState: AgentState; cancelledActionName?: string } {
    if (state === 'in_action') {
      const actionTimer = this.timerManager.find((t): t is ActionTimer => t.type === 'action' && (t as ActionTimer).agent_id === agentId);
      if (actionTimer) {
        return { cancelledState: 'in_action', cancelledActionName: actionTimer.action_name };
      }
      return { cancelledState: 'in_action' };
    }
    return { cancelledState: state };
  }

  private resolveSpawnNode(lastNodeId?: NodeId): NodeId {
    if (lastNodeId) {
      try {
        if (isNodeWithinBounds(lastNodeId, this.config.map) && isPassable(getNodeConfig(lastNodeId, this.config.map).type)) {
          return lastNodeId;
        }
      } catch {
        // Invalid node format — fall through to random spawn
      }
    }
    return this.config.spawn.nodes[randomInt(this.config.spawn.nodes.length)];
  }

  private persistRegistrations(agents: AgentRegistration[]): void {
    this.onRegistrationChanged?.(agents);
  }

  emitEvent(event: EmittableWorldEvent): void {
    this.eventBus.emit({
      ...event,
      event_id: `evt-${randomUUID()}`,
      occurred_at: Date.now(),
    } as WorldEvent);
  }
}
