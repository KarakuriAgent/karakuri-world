import { randomBytes, randomInt, randomUUID } from 'node:crypto';

import {
  executeValidatedAction,
  handleActionCompleted,
  validateAction,
} from '../domain/actions.js';
import {
  acceptConversation as acceptConversationRequest,
  cancelPendingConversation,
  endConversationByAgent,
  forceEndConversation,
  getConversationActionableSpeaker,
  handleAcceptTimeout,
  handleConversationInterval,
  handleInactiveCheckTimeout,
  handleTurnTimeout,
  joinConversation as joinConversationRequest,
  leaveConversation as leaveConversationRequest,
  rejectConversation as rejectConversationRequest,
  speak as speakInConversation,
  startConversation as startConversationRequest,
  stayInConversation as stayInConversationRequest,
} from '../domain/conversation.js';
import { handleIdleReminderFired, startIdleReminder } from '../domain/idle-reminder.js';
import { getNodeConfig, isNodeWithinBounds, isPassable } from '../domain/map-utils.js';
import {
  cleanupServerEventsForAgent,
  fireServerEvent as fireRuntimeServerEvent,
  handleServerEventInterruption,
} from '../domain/server-events.js';
import {
  executeValidatedMove,
  getAgentCurrentNode,
  getMovementTimer,
  handleMovementCompleted,
  validateMove,
} from '../domain/movement.js';
import { getPerceptionData } from '../domain/perception.js';
import { executeValidatedUseItem, handleItemUseCompleted, validateUseItem } from '../domain/use-item.js';
import { executeValidatedWait, handleWaitCompleted, validateWait } from '../domain/wait.js';
import type { WeatherService, WeatherState } from '../domain/weather.js';
import { WorldError } from '../types/api.js';
import type {
  ActionRequest,
  AdminAgentSummary,
  ConversationAcceptRequest,
  ConversationEndRequest,
  ConversationJoinRequest,
  ConversationLeaveRequest,
  ConversationSpeakRequest,
  ConversationSpeakResponse,
  ConversationStartRequest,
  ConversationStartResponse,
  FireServerEventRequest,
  FireServerEventResponse,
  LoginResponse,
  LogoutResponse,
  MoveRequest,
  MoveResponse,
  NotificationAcceptedResponse,
  OkResponse,
  PerceptionResponse,
  UseItemRequest,
  WaitRequest,
  WaitResponse,
  WorldAgentsResponse,
} from '../types/api.js';
import type { AgentRegistration, AgentState } from '../types/agent.js';
import type { MapConfig, NodeId, ServerConfig } from '../types/data-model.js';
import type { WorldEvent } from '../types/event.js';
import type { WorldSnapshot } from '../types/snapshot.js';
import type { ActionTimer, ItemUseTimer, WaitTimer } from '../types/timer.js';
import { getMapRenderTheme } from '../discord/map-renderer.js';
import { EventBus } from './event-bus.js';
import type { AgentHistoryManager } from './agent-history-manager.js';
import { isSnapshotTriggerEvent, type SnapshotPublisher } from './snapshot-publisher.js';
import { buildWorldCalendarSnapshot } from './world-snapshot.js';
import { WorldState } from './state/world-state.js';
import { TimerManager } from './timer-manager.js';

type EmittableWorldEvent<T extends WorldEvent = WorldEvent> = T extends WorldEvent
  ? Omit<T, 'event_id' | 'occurred_at'>
  : never;

function findActionEmoji(config: ServerConfig, actionId: string): string | undefined {
  for (const building of config.map.buildings) {
    const action = building.actions.find((candidate) => candidate.action_id === actionId);
    if (action) {
      return action.emoji;
    }
  }

  for (const npc of config.map.npcs) {
    const action = npc.actions.find((candidate) => candidate.action_id === actionId);
    if (action) {
      return action.emoji;
    }
  }

  return undefined;
}

function resolveStatusEmoji(params: {
  state: AgentState;
  currentActivity?: WorldSnapshot['agents'][number]['current_activity'];
  actionEmoji?: string;
}): string {
  if (params.state === 'moving') {
    return '🚶';
  }
  if (params.state === 'in_conversation') {
    return '💬';
  }
  if (params.currentActivity?.type === 'wait') {
    return '💤';
  }
  if (params.currentActivity?.type === 'item_use') {
    return '🧰';
  }
  if (params.currentActivity?.type === 'action') {
    return params.actionEmoji ?? '✨';
  }
  return '';
}

function getSnapshotConversationId(state: WorldState, agentId: string, currentConversationId: string | null): string | null {
  if (!currentConversationId) {
    return null;
  }

  const conversation = state.conversations.get(currentConversationId);
  if (!conversation || !conversation.participant_agent_ids.includes(agentId)) {
    return null;
  }

  return currentConversationId;
}

export interface DiscordRuntimeAdapter {
  createAgentChannel(agentName: string, agentId: string): Promise<string>;
  deleteAgentChannel(channelId: string): Promise<void>;
  channelExists(channelId: string): Promise<boolean>;
  fetchBotInfo(discordBotId: string): Promise<{ username: string; avatarURL: string }>;
}

export interface WorldEngineOptions {
  initialRegistrations?: AgentRegistration[];
  onRegistrationChanged?: (agents: AgentRegistration[]) => void;
  weatherService?: WeatherService;
  onError?: (message: string) => void;
  snapshotPublisher?: SnapshotPublisher;
  agentHistoryManager?: AgentHistoryManager;
}

export class WorldEngine {
  readonly timerManager = new TimerManager();
  readonly eventBus = new EventBus();
  readonly state: WorldState;
  private readonly onRegistrationChanged?: (agents: AgentRegistration[]) => void;
  private readonly onError?: (message: string) => void;
  private readonly registeringAgentIds = new Set<string>();
  private readonly loggingInAgentIds = new Set<string>();
  private readonly weatherService: WeatherService | null;
  private readonly snapshotPublisher: SnapshotPublisher | null;
  private readonly agentHistoryManager: AgentHistoryManager | null;
  private readonly unsubscribeWeather?: () => void;
  private shutdownSnapshot: WorldSnapshot | null = null;
  private disposePromise: Promise<void> | null = null;

  constructor(
    readonly config: ServerConfig,
    readonly discordBot: DiscordRuntimeAdapter,
    options: WorldEngineOptions = {},
  ) {
    this.state = new WorldState(options.initialRegistrations);
    this.onRegistrationChanged = options.onRegistrationChanged;
    this.onError = options.onError;
    this.weatherService = options.weatherService ?? null;
    this.snapshotPublisher = options.snapshotPublisher ?? null;
    this.agentHistoryManager = options.agentHistoryManager ?? null;
    if (this.weatherService && this.snapshotPublisher) {
      this.unsubscribeWeather = this.weatherService.onWeatherUpdated(() => {
        this.snapshotPublisher?.requestPublish();
      });
    }
    this.timerManager.onFire('movement', (timer) => {
      handleMovementCompleted(this, timer);
    });
    this.timerManager.onFire('action', (timer) => {
      handleActionCompleted(this, timer);
    });
    this.timerManager.onFire('wait', (timer) => {
      handleWaitCompleted(this, timer);
    });
    this.timerManager.onFire('item_use', (timer) => {
      handleItemUseCompleted(this, timer as ItemUseTimer);
    });
    this.timerManager.onFire('conversation_accept', (timer) => {
      handleAcceptTimeout(this, timer);
    });
    this.timerManager.onFire('conversation_interval', (timer) => {
      handleConversationInterval(this, timer);
    });
    this.timerManager.onFire('conversation_inactive_check', (timer) => {
      handleInactiveCheckTimeout(this, timer);
    });
    this.timerManager.onFire('conversation_turn', (timer) => {
      handleTurnTimeout(this, timer);
    });
    this.timerManager.onFire('idle_reminder', (timer) => {
      handleIdleReminderFired(this, timer);
    });
  }

  async registerAgent(input: { discord_bot_id: string }): Promise<AgentRegistration> {
    if (this.state.getById(input.discord_bot_id) || this.registeringAgentIds.has(input.discord_bot_id)) {
      throw new WorldError(409, 'state_conflict', `Agent already exists: ${input.discord_bot_id}`);
    }

    this.registeringAgentIds.add(input.discord_bot_id);
    try {
      const botInfo = await this.discordBot.fetchBotInfo(input.discord_bot_id);
      const registration: AgentRegistration = {
        agent_id: input.discord_bot_id,
        agent_name: botInfo.username,
        api_key: `karakuri_${randomBytes(16).toString('hex')}`,
        discord_bot_avatar_url: botInfo.avatarURL,
        created_at: Date.now(),
        money: this.config.economy?.initial_money ?? 0,
        items: [],
      };

      this.persistRegistrations([...this.state.list(), registration]);
      return this.state.register(registration);
    } finally {
      this.registeringAgentIds.delete(input.discord_bot_id);
    }
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

    this.persistRegistrations(this.state.list().filter((agent) => agent.agent_id !== agentId));
    this.state.delete(agentId);

    if (registration.discord_channel_id) {
      try {
        await this.discordBot.deleteAgentChannel(registration.discord_channel_id);
      } catch (error) {
        console.error('Failed to delete persisted agent channel.', error);
        this.onError?.(`エージェントチャンネルの削除に失敗しました (channel: ${registration.discord_channel_id}): ${error instanceof Error ? error.message : String(error)}`);
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
        channelId = await this.discordBot.createAgentChannel(agent.agent_name, agent.agent_id);
        channelCreated = true;
      }

      const spawnNodeId = this.resolveSpawnNode(agent.last_node_id);

      const loggedInAgent = this.state.login({
        agent_id: agentId,
        node_id: spawnNodeId,
        discord_channel_id: channelId,
        money: agent.money ?? this.config.economy?.initial_money ?? 0,
        items: [...(agent.items ?? [])],
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

    const registration = this.state.getById(agentId);
    if (registration) {
      this.persistRegistrations(
        this.state.list().map((agent) =>
          agent.agent_id === agentId
            ? {
                ...agent,
                discord_channel_id: loggedInAgent.discord_channel_id,
                last_node_id: leftNodeId,
                money: loggedInAgent.money,
                items: [...loggedInAgent.items],
              }
            : agent,
        ),
      );
      registration.discord_channel_id = loggedInAgent.discord_channel_id;
      registration.last_node_id = leftNodeId;
      registration.money = loggedInAgent.money;
      registration.items = [...loggedInAgent.items];
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

  move(agentId: string, request: MoveRequest): MoveResponse {
    const { agent, to_node_id, path } = validateMove(this, agentId, request);
    handleServerEventInterruption(this, agentId);
    return executeValidatedMove(this, agent, to_node_id, path);
  }

  executeAction(agentId: string, request: ActionRequest): NotificationAcceptedResponse {
    const result = validateAction(this, agentId, request);
    if (result.rejected) {
      this.state.setLastRejectedAction(result.agent.agent_id, result.source.action.action_id);
      this.state.clearExcludedInfoCommands(result.agent.agent_id);
      this.emitEvent({
        type: 'action_rejected',
        agent_id: result.agent.agent_id,
        agent_name: result.agent.agent_name,
        action_id: result.source.action.action_id,
        action_name: result.source.action.name,
        rejection_reason: result.rejection_reason,
      });
      handleServerEventInterruption(this, agentId);
      return { ok: true, message: '正常に受け付けました。結果が通知されるまで待機してください。' };
    }

    handleServerEventInterruption(this, agentId);
    return executeValidatedAction(this, result.agent, result.source, result.duration_ms);
  }

  executeWait(agentId: string, request: WaitRequest): WaitResponse {
    const { agent, duration_ms } = validateWait(this, agentId, request);
    handleServerEventInterruption(this, agentId);
    return executeValidatedWait(this, agent, duration_ms);
  }

  useItem(agentId: string, request: UseItemRequest): NotificationAcceptedResponse {
    const validated = validateUseItem(this, agentId, request);
    handleServerEventInterruption(this, agentId);
    return executeValidatedUseItem(this, validated);
  }

  startConversation(agentId: string, request: ConversationStartRequest): ConversationStartResponse {
    return startConversationRequest(this, agentId, request);
  }

  acceptConversation(agentId: string, request: ConversationAcceptRequest): OkResponse {
    return acceptConversationRequest(this, agentId, request);
  }

  joinConversation(agentId: string, request: ConversationJoinRequest): OkResponse {
    return joinConversationRequest(this, agentId, request);
  }

  stayInConversation(agentId: string): OkResponse {
    return stayInConversationRequest(this, agentId);
  }

  leaveConversation(agentId: string, request: ConversationLeaveRequest = {}): OkResponse {
    return leaveConversationRequest(this, agentId, request);
  }

  rejectConversation(agentId: string): OkResponse {
    return rejectConversationRequest(this, agentId);
  }

  speak(agentId: string, request: ConversationSpeakRequest): ConversationSpeakResponse {
    return speakInConversation(this, agentId, request);
  }

  endConversation(agentId: string, request: ConversationEndRequest): ConversationSpeakResponse {
    return endConversationByAgent(this, agentId, request);
  }

  fireServerEvent(request: FireServerEventRequest | string): FireServerEventResponse {
    const description = typeof request === 'string' ? request : request.description;
    return fireRuntimeServerEvent(this, description);
  }

  getPerception(agentId: string): PerceptionResponse {
    return getPerceptionData(this, agentId);
  }

  getMap(): MapConfig {
    return this.config.map;
  }

  reportError(message: string): void {
    try {
      this.onError?.(message);
    } catch (error) {
      console.error('World error reporter threw.', error);
    }
  }

  getWeatherState(): WeatherState | null {
    return this.weatherService?.getState() ?? null;
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

  getSnapshotPublisherStats() {
    return this.snapshotPublisher?.getStats();
  }

  getSnapshot(): WorldSnapshot {
    if (this.shutdownSnapshot) {
      return this.shutdownSnapshot;
    }

    return this.buildSnapshot();
  }

  private buildSnapshot(): WorldSnapshot {
    const now = Date.now();
    const weather = this.getWeatherState();
    const snapshotPublisherStats = this.getSnapshotPublisherStats();

    return {
      world: this.config.world,
      map: this.config.map,
      calendar: buildWorldCalendarSnapshot(now, this.config.timezone),
      map_render_theme: getMapRenderTheme(),
      ...(weather
        ? {
            weather: {
              condition: weather.condition_text,
              temperature_celsius: weather.temperature_celsius,
            },
          }
        : {}),
      agents: this.state.listLoggedIn().map((agent) => {
        const registration = this.state.getById(agent.agent_id);
        const movementTimer = agent.state === 'moving' ? getMovementTimer(this, agent.agent_id) : null;
        const actionTimer = this.timerManager.find(
          (timer): timer is ActionTimer => timer.type === 'action' && timer.agent_id === agent.agent_id,
        );
        const waitTimer = this.timerManager.find(
          (timer): timer is WaitTimer => timer.type === 'wait' && timer.agent_id === agent.agent_id,
        );
        const itemUseTimer = this.timerManager.find(
          (timer): timer is ItemUseTimer => timer.type === 'item_use' && timer.agent_id === agent.agent_id,
        );
        const currentActivity = actionTimer
          ? {
              type: 'action' as const,
              action_id: actionTimer.action_id,
              action_name: actionTimer.action_name,
              duration_ms: actionTimer.duration_ms,
              completes_at: actionTimer.fires_at,
            }
          : waitTimer
            ? {
                type: 'wait' as const,
                duration_ms: waitTimer.duration_ms,
                completes_at: waitTimer.fires_at,
              }
            : itemUseTimer
              ? {
                  type: 'item_use' as const,
                  item_id: itemUseTimer.item_id,
                  item_name: itemUseTimer.item_name,
                  completes_at: itemUseTimer.fires_at,
                }
              : undefined;
        const actionEmoji =
          currentActivity?.type === 'action' ? findActionEmoji(this.config, currentActivity.action_id) : undefined;
        const snapshotConversationId = getSnapshotConversationId(this.state, agent.agent_id, agent.current_conversation_id);

        return {
          agent_id: agent.agent_id,
          agent_name: agent.agent_name,
          node_id: getAgentCurrentNode(this, agent, now),
          state: agent.state,
          discord_channel_id: agent.discord_channel_id,
          money: agent.money,
          items: [...agent.items],
          ...(registration?.discord_bot_avatar_url
            ? {
                discord_bot_avatar_url: registration.discord_bot_avatar_url,
              }
            : {}),
          status_emoji: resolveStatusEmoji({
            state: agent.state,
            currentActivity,
            actionEmoji,
          }),
          ...(snapshotConversationId
            ? {
                current_conversation_id: snapshotConversationId,
              }
            : {}),
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
          ...(currentActivity
            ? {
                current_activity: currentActivity,
              }
            : {}),
        };
      }),
      known_agents: this.state.list().map((registration) => ({
        agent_id: registration.agent_id,
        agent_name: registration.agent_name,
        ...(registration.discord_bot_avatar_url
          ? { discord_bot_avatar_url: registration.discord_bot_avatar_url }
          : {}),
      })),
      conversations: this.state.conversations.list().map((conversation) => ({
        conversation_id: conversation.conversation_id,
        status: conversation.status,
        initiator_agent_id: conversation.initiator_agent_id,
        participant_agent_ids: [...conversation.participant_agent_ids],
        current_turn: conversation.current_turn,
        max_turns: this.config.conversation.max_turns,
        max_participants: this.config.conversation.max_participants,
        current_speaker_agent_id: conversation.current_speaker_agent_id,
        actionable_speaker_agent_id: getConversationActionableSpeaker(conversation) ?? conversation.current_speaker_agent_id,
        closing_reason: conversation.closing_reason,
      })),
      recent_server_events: this.state.recentServerEvents.list(),
      generated_at: now,
      ...(snapshotPublisherStats
        ? {
            runtime: {
              snapshot_publisher: snapshotPublisherStats,
            },
          }
        : {}),
    };
  }

  persistLoggedInAgentState(agentId: string): void {
    const registration = this.state.getById(agentId);
    const loggedInAgent = this.state.getLoggedIn(agentId);
    if (!registration || !loggedInAgent) {
      return;
    }

    const nextRegistrations = this.state.list().map((agent) =>
      agent.agent_id === agentId
        ? {
            ...agent,
            discord_channel_id: loggedInAgent.discord_channel_id,
            last_node_id: getAgentCurrentNode(this, loggedInAgent),
            money: loggedInAgent.money,
            items: [...loggedInAgent.items],
          }
        : agent,
    );
    this.persistRegistrations(nextRegistrations);
    registration.discord_channel_id = loggedInAgent.discord_channel_id;
    registration.last_node_id = getAgentCurrentNode(this, loggedInAgent);
    registration.money = loggedInAgent.money;
    registration.items = [...loggedInAgent.items];
  }

  private describeCancelledActivity(
    state: AgentState,
    agentId: string,
  ): { cancelledState: AgentState; cancelledActionName?: string } {
    if (state === 'in_action') {
      const actionTimer = this.timerManager.find((t): t is ActionTimer => t.type === 'action' && t.agent_id === agentId);
      if (actionTimer) {
        return { cancelledState: 'in_action', cancelledActionName: actionTimer.action_name };
      }
      const itemUseTimer = this.timerManager.find((t): t is ItemUseTimer => t.type === 'item_use' && t.agent_id === agentId);
      if (itemUseTimer) {
        return { cancelledState: 'in_action', cancelledActionName: itemUseTimer.item_name };
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

  private handleEventSideEffectError(sideEffect: string, eventType: WorldEvent['type'], error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`World event ${sideEffect} threw.`, error);
    try {
      this.onError?.(`ワールドイベントの副作用に失敗しました (${sideEffect}, event: ${eventType}): ${errorMessage}`);
    } catch (reportError) {
      console.error('World error reporter threw.', reportError);
    }
  }

  emitEvent(event: EmittableWorldEvent): void {
    const fullEvent = {
      ...event,
      event_id: `evt-${randomUUID()}`,
      occurred_at: Date.now(),
    } as WorldEvent;

    try {
      this.eventBus.emit(fullEvent);
    } catch (error) {
      console.error('World event handler threw.', error);
    }

    try {
      this.agentHistoryManager?.recordEvent(fullEvent);
    } catch (error) {
      this.handleEventSideEffectError('history recording', fullEvent.type, error);
    }

    if (isSnapshotTriggerEvent(fullEvent.type)) {
      try {
        this.snapshotPublisher?.requestPublish();
      } catch (error) {
        this.handleEventSideEffectError('snapshot publishing', fullEvent.type, error);
      }
    }
  }

  async dispose(): Promise<void> {
    this.shutdownSnapshot ??= this.buildSnapshot();
    this.disposePromise ??= (async () => {
      this.unsubscribeWeather?.();
      this.timerManager.clearAll();
      await this.snapshotPublisher?.dispose();
      await this.agentHistoryManager?.dispose();
    })();
    await this.disposePromise;
  }
}
