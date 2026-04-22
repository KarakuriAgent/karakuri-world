import { formatActionSourceLine, getAvailableActionSources } from '../domain/actions.js';
import { buildChoicesText } from '../domain/choices.js';
import { buildMapSummaryText } from '../domain/map-summary.js';
import { buildPerceptionText } from '../domain/perception.js';
import { clearActiveServerEvent } from '../domain/server-events.js';
import type { WorldEngine } from '../engine/world-engine.js';
import { WorldError } from '../types/api.js';
import type { ItemType, NodeId } from '../types/data-model.js';
import type { ConversationRejectionReason } from '../types/conversation.js';
import type { WorldEvent } from '../types/event.js';
import type { ConversationIntervalTimer, IdleReminderTimer } from '../types/timer.js';
import { WorldLogThreadCreationError, type DiscordNotificationAdapter, type WebhookIdentity } from './bot.js';
import {
  formatActionCompletedMessage,
  formatActionRejectedMessage,
  formatAvailableActionsInfoMessage,
  formatAgentLoggedInMessage,
  formatAgentLoggedOutMessage,
  formatConversationAcceptedMessage,
  formatConversationClosingPromptMessage,
  formatConversationDeliveredClosingMessage,
  formatConversationEndedMessage,
  formatConversationFYIMessage,
  formatConversationForcedEndedMessage,
  formatConversationInactiveCheckMessage,
  formatConversationPendingJoinCancelledMessage,
  formatConversationLeaveSystemMessage,
  formatConversationRejectedMessage,
  formatConversationReplyPromptMessage,
  formatConversationRequestedMessage,
  formatConversationServerEventClosingPromptMessage,
  formatConversationThreadName,
  formatConversationTurnClosingPromptMessage,
  formatConversationTurnPromptMessage,
  formatIdleReminderMessage,
  formatItemUseCompletedMessage,
  formatItemUseVenueRejectedMessage,
  formatMapInfoMessage,
  formatMovementCompletedMessage,
  formatPerceptionInfoMessage,
  formatServerEventMessage,
  formatWaitCompletedMessage,
  formatWorldAgentsInfoMessage,
  formatWorldLogAction,
  formatWorldLogActionRejected,
  formatWorldLogActionStarted,
  formatWorldLogConversationMessage,
  formatWorldLogConversationEnded,
  formatWorldLogItemUseCompleted,
  formatWorldLogItemUseStarted,
  formatWorldLogItemUseVenueRejected,
  formatWorldLogMovementStarted,
  formatWorldLogWaitStarted,
  formatWorldLogConversationStarted,
  formatWorldLogLoggedIn,
  formatWorldLogLoggedOut,
  formatWorldLogMovement,
  formatWorldLogServerEvent,
  formatWorldLogWait,
  type ConversationParticipantInfo,
  type WorldContext,
} from './notification.js';

interface PendingForcedConversationEnd {
  initiator_agent_id: string;
  participant_agent_ids: string[];
}

interface ForcedConversationPartner {
  conversationId: string;
  partnerId: string;
}

export class DiscordEventHandler {
  private unsubscribe: (() => void) | null = null;
  private readonly pendingForcedConversationEnds = new Map<string, PendingForcedConversationEnd>();
  private readonly conversationThreads = new Map<string, Promise<string | null>>();
  private readonly conversationLogDeliveries = new Map<string, Promise<void>>();
  private readonly agentMessageDeliveries = new Map<string, Promise<void>>();
  private readonly skillName: string;

  constructor(
    private readonly engine: WorldEngine,
    private readonly bot: DiscordNotificationAdapter,
  ) {
    this.skillName = this.engine.config.world.skill_name;
  }

  register(): () => void {
    if (this.unsubscribe) {
      return this.unsubscribe;
    }

    const disposeEventSubscription = this.engine.eventBus.onAny((event) => {
      void this.handleEvent(event).catch((error) => {
        console.error('Failed to dispatch Discord notification.', error);
        this.reportError(`Discord 通知の配信に失敗しました (event: ${event.type})`, error);
      });
    });
    const disposeConversationIntervalSubscription = this.engine.timerManager.onFire('conversation_interval', (timer) => {
      void this.handleConversationInterval(timer).catch((error) => {
        console.error('Failed to dispatch Discord notification.', error);
        this.reportError('会話インターバル通知の配信に失敗しました', error);
      });
    });
    const disposeIdleReminderSubscription = this.engine.timerManager.onFire('idle_reminder', (timer) => {
      void this.handleIdleReminder(timer).catch((error) => {
        console.error('Failed to dispatch Discord notification.', error);
        this.reportError('アイドルリマインダー通知の配信に失敗しました', error);
      });
    });
    this.unsubscribe = () => {
      disposeEventSubscription();
      disposeConversationIntervalSubscription();
      disposeIdleReminderSubscription();
      this.unsubscribe = null;
      this.pendingForcedConversationEnds.clear();
      this.conversationThreads.clear();
      this.conversationLogDeliveries.clear();
      this.agentMessageDeliveries.clear();
    };

    return this.unsubscribe;
  }

  dispose(): void {
    this.unsubscribe?.();
  }

  private async handleEvent(event: WorldEvent): Promise<void> {
    switch (event.type) {
      case 'agent_logged_in':
        await this.handleAgentLoggedIn(event.agent_id, event.agent_name, event.node_id);
        return;
      case 'agent_logged_out':
        await this.handleAgentLoggedOut(event);
        return;
      case 'movement_completed':
        await this.handleMovementCompleted(event.agent_id, event.agent_name, event.node_id);
        return;
      case 'action_completed':
        await this.handleActionCompleted(event);
        return;
      case 'action_rejected':
        await this.handleActionRejected(event.agent_id, event.action_name, event.rejection_reason);
        return;
      case 'wait_completed':
        await this.handleWaitCompleted(event.agent_id, event.duration_ms);
        return;
      case 'wait_started':
        await this.handleWaitStarted(event.agent_id, event.duration_ms, event.completes_at);
        return;
      case 'item_use_started':
        await this.handleItemUseStarted(event.agent_id, event.item_name, event.completes_at);
        return;
      case 'item_use_completed':
        await this.handleItemUseCompleted(event.agent_id, event.item_name, event.item_type);
        return;
      case 'item_use_venue_rejected':
        await this.handleItemUseVenueRejected(event.agent_id, event.item_name, event.venue_hints);
        return;
      case 'conversation_requested':
        await this.handleConversationRequested(
          event.target_agent_id,
          this.getAgentName(event.initiator_agent_id),
          event.message,
        );
        return;
      case 'conversation_accepted':
        await this.handleConversationAccepted(
          event.conversation_id,
          event.initiator_agent_id,
          event.participant_agent_ids,
        );
        return;
      case 'conversation_rejected':
        await this.handleConversationRejected(
          event.initiator_agent_id,
          event.target_agent_id,
          this.getAgentName(event.initiator_agent_id),
          this.getAgentName(event.target_agent_id),
          event.reason,
        );
        return;
      case 'conversation_message': {
        const content = formatWorldLogConversationMessage(event.message);
        const threadPromise = this.conversationThreads.get(event.conversation_id);
        await this.enqueueConversationLog(event.conversation_id, async () => {
          if (threadPromise) {
            const threadId = await threadPromise;
            if (threadId) {
              try {
                await this.sendToThreadForAgent(threadId, event.speaker_agent_id, content);
                return;
              } catch (error) {
                console.warn(`Failed to send conversation message to thread ${threadId}, falling back to world log.`, error);
              }
            }
          }

          try {
            await this.sendWorldLogForAgent(event.speaker_agent_id, content);
          } catch (error) {
            console.error('Failed to send conversation message to both thread and world log. Message lost.', error);
          }
        });
        return;
      }
      case 'conversation_ended':
        await this.handleConversationEnded(event);
        return;
      case 'conversation_pending_join_cancelled':
        await this.handleConversationPendingJoinCancelled(event);
        return;
      case 'conversation_join':
        await this.handleConversationJoin(event);
        return;
      case 'conversation_leave':
        await this.handleConversationLeave(event);
        return;
      case 'conversation_inactive_check':
        await this.handleConversationInactiveCheck(event);
        return;
      case 'conversation_interval_interrupted':
        await this.handleConversationIntervalInterrupted(event);
        return;
      case 'conversation_turn_started':
        await this.handleConversationTurnStarted(event);
        return;
      case 'conversation_closing':
        await this.handleConversationClosing(event);
        return;
      case 'server_event_fired':
        await this.handleServerEventFired(event);
        return;
      case 'movement_started':
        await this.handleMovementStarted(event.agent_id, event.to_node_id, event.arrives_at);
        return;
      case 'action_started':
        await this.handleActionStarted(event.agent_id, event.action_name, event.completes_at);
        return;
      case 'map_info_requested':
        await this.handleMapInfoRequested(event.agent_id);
        return;
      case 'world_agents_info_requested':
        await this.handleWorldAgentsInfoRequested(event.agent_id);
        return;
      case 'perception_requested':
        await this.handlePerceptionRequested(event.agent_id);
        return;
      case 'available_actions_requested':
        await this.handleAvailableActionsRequested(event.agent_id);
        return;
    }
  }

  private async handleIdleReminder(timer: IdleReminderTimer): Promise<void> {
    const agent = this.engine.state.getLoggedIn(timer.agent_id);
    if (!agent || agent.pending_conversation_id) {
      return;
    }

    const perceptionText = this.getPerceptionText(timer.agent_id);
    if (!perceptionText) {
      return;
    }

    const choicesText = this.getChoicesText(timer.agent_id);
    const elapsedMs = Date.now() - timer.idle_since;
    await this.sendToAgentClearingServerEvent(
      timer.agent_id,
      formatIdleReminderMessage(this.getWorldContext(timer.agent_id), elapsedMs, perceptionText, this.skillName, choicesText),
    );
  }

  private async handleConversationInterval(timer: ConversationIntervalTimer): Promise<void> {
    const conversation = this.engine.state.conversations.get(timer.conversation_id);
    if (!conversation) {
      return;
    }

    const closing = conversation.status === 'closing' || conversation.closing_reason === 'ended_by_agent';
    const participants = this.getParticipantInfos(conversation.participant_agent_ids);
    const { listenerAgentIds, nextSpeakerAgentId } = this.resolveConversationIntervalNotificationTargets(timer, conversation);
    const nextSpeakerName = nextSpeakerAgentId ? this.getAgentName(nextSpeakerAgentId) : undefined;
    for (const listenerAgentId of listenerAgentIds) {
      if (
        nextSpeakerAgentId
        && listenerAgentId === nextSpeakerAgentId
        && conversation.status === 'closing'
        && conversation.closing_reason === 'ended_by_agent'
        && conversation.participant_agent_ids.length <= 2
        && conversation.current_speaker_agent_id === nextSpeakerAgentId
      ) {
        await this.sendConversationFollowUp(
          listenerAgentId,
          formatConversationDeliveredClosingMessage(this.getAgentName(timer.speaker_agent_id), timer.message),
        );
        continue;
      }
      if (
        nextSpeakerAgentId
        && listenerAgentId === nextSpeakerAgentId
        && conversation.status === 'closing'
        && conversation.closing_reason === 'server_event'
        && conversation.current_speaker_agent_id === nextSpeakerAgentId
      ) {
        await this.sendConversationFollowUp(
          listenerAgentId,
          formatConversationDeliveredClosingMessage(this.getAgentName(timer.speaker_agent_id), timer.message),
        );
        continue;
      }

      await this.handleConversationMessage(
        listenerAgentId,
        this.getAgentName(timer.speaker_agent_id),
        timer.message,
        closing,
        participants,
        listenerAgentId === nextSpeakerAgentId,
        nextSpeakerName,
      );
    }
  }

  private resolveConversationIntervalNotificationTargets(
    timer: ConversationIntervalTimer,
    conversation: {
      participant_agent_ids: string[];
      current_speaker_agent_id: string;
      inactive_check_pending_agent_ids?: string[];
      resume_speaker_agent_id?: string | null;
    },
  ): {
    listenerAgentIds: string[];
    nextSpeakerAgentId?: string;
  } {
    if (conversation.participant_agent_ids.length === 0) {
      return { listenerAgentIds: [] };
    }

    const participantIds = new Set(conversation.participant_agent_ids);
    const listenerAgentIds = conversation.participant_agent_ids.filter(
      (participantAgentId) => participantAgentId !== timer.speaker_agent_id,
    );
    const hasInactiveCheckPause = (conversation.inactive_check_pending_agent_ids?.length ?? 0) > 0;
    const pausedNextSpeakerAgentId = hasInactiveCheckPause
      ? (
        conversation.resume_speaker_agent_id && participantIds.has(conversation.resume_speaker_agent_id)
          ? conversation.resume_speaker_agent_id
          : participantIds.has(timer.next_speaker_agent_id)
            ? timer.next_speaker_agent_id
            : undefined
      )
      : undefined;
    const nextSpeakerAgentId = pausedNextSpeakerAgentId
      ?? (participantIds.has(conversation.current_speaker_agent_id)
        ? conversation.current_speaker_agent_id
        : participantIds.has(timer.next_speaker_agent_id)
          ? timer.next_speaker_agent_id
          : listenerAgentIds[0]);

    return {
      listenerAgentIds,
      nextSpeakerAgentId,
    };
  }

  private async handleConversationIntervalInterrupted(
    event: Extract<WorldEvent, { type: 'conversation_interval_interrupted' }>,
  ): Promise<void> {
    const participants = this.getParticipantInfos(event.participant_agent_ids);
    const speakerName = this.getAgentName(event.speaker_agent_id);
    const nextSpeakerName = this.getAgentName(event.next_speaker_agent_id);
    const prioritizedListenerAgentIds = event.listener_agent_ids.includes(event.next_speaker_agent_id)
      ? [
          event.next_speaker_agent_id,
          ...event.listener_agent_ids.filter((listenerAgentId) => listenerAgentId !== event.next_speaker_agent_id),
        ]
      : event.listener_agent_ids;
    for (const listenerAgentId of prioritizedListenerAgentIds) {
      if (listenerAgentId === event.next_speaker_agent_id) {
        await this.sendConversationFollowUp(
          listenerAgentId,
          formatConversationDeliveredClosingMessage(speakerName, event.message),
        );
        continue;
      }

      await this.handleConversationMessage(
        listenerAgentId,
        speakerName,
        event.message,
        event.closing,
        participants,
        false,
        nextSpeakerName,
      );
    }
  }

  private async handleAgentLoggedIn(agentId: string, _agentName: string, _nodeId: NodeId): Promise<void> {
    const perceptionText = this.getPerceptionText(agentId);
    if (perceptionText) {
      const choicesText = this.getChoicesText(agentId);
      await this.sendToAgent(
        agentId,
        formatAgentLoggedInMessage(this.getWorldContext(agentId), perceptionText, this.skillName, choicesText),
      );
    }

    await this.sendWorldLogForAgent(agentId, formatWorldLogLoggedIn());
  }

  private async handleAgentLoggedOut(event: Extract<WorldEvent, { type: 'agent_logged_out' }>): Promise<void> {
    try {
      const agentMessage = formatAgentLoggedOutMessage(event.cancelled_state, event.cancelled_action_name);
      await this.bot.sendAgentMessage(event.discord_channel_id, agentMessage);
    } catch (error) {
      console.error('Failed to send logout notification to agent channel.', error);
    }

    const forcedConversationPartners = this.consumeForcedConversationPartners(event.agent_id);

    for (const { partnerId } of forcedConversationPartners) {
      const perceptionText = this.getPerceptionText(partnerId);
      if (perceptionText) {
        const choicesText = this.getChoicesText(partnerId);
        await this.sendConversationFollowUp(
          partnerId,
          formatConversationForcedEndedMessage(this.getWorldContext(partnerId), event.agent_name, perceptionText, this.skillName, choicesText),
        );
      }
    }

    await this.sendLogoutWorldLog(
      event.agent_id,
      forcedConversationPartners.map(({ conversationId }) => conversationId),
      formatWorldLogLoggedOut(event.cancelled_state, event.cancelled_action_name),
    );
  }

  private async handleMovementStarted(agentId: string, toNodeId: NodeId, arrivesAt: number): Promise<void> {
    const label = this.engine.getMap().nodes[toNodeId]?.label;
    await this.sendWorldLogForAgent(agentId, formatWorldLogMovementStarted(toNodeId, arrivesAt, this.engine.config.timezone, label));
  }

  private async handleMovementCompleted(agentId: string, _agentName: string, toNodeId: NodeId): Promise<void> {
    const perceptionText = this.getPerceptionText(agentId);
    if (perceptionText) {
      const label = this.engine.getMap().nodes[toNodeId]?.label;
      const choicesText = this.getChoicesText(agentId);
      await this.sendToAgentClearingServerEvent(
        agentId,
        formatMovementCompletedMessage(
          this.getWorldContext(agentId),
          toNodeId,
          label,
          perceptionText,
          this.skillName,
          choicesText,
        ),
      );
      await this.sendWorldLogForAgent(agentId, formatWorldLogMovement(toNodeId, label));
    }
  }

  private async handleActionStarted(agentId: string, actionName: string, completesAt: number): Promise<void> {
    await this.sendWorldLogForAgent(agentId, formatWorldLogActionStarted(actionName, completesAt, this.engine.config.timezone));
  }

  private buildActionEffectText(event: Extract<WorldEvent, { type: 'action_completed' }>): string {
    const itemNames = new Map((this.engine.config.items ?? []).map((item) => [item.item_id, item.name]));
    const lines: string[] = [];
    if (event.money_balance !== undefined) {
      if (event.cost_money !== undefined && event.cost_money > 0) {
        lines.push(`💰 -${event.cost_money.toLocaleString('ja-JP')}円 → 残高: ${event.money_balance.toLocaleString('ja-JP')}円`);
      }
      if (event.reward_money !== undefined && event.reward_money > 0) {
        lines.push(`💰 +${event.reward_money.toLocaleString('ja-JP')}円 → 残高: ${event.money_balance.toLocaleString('ja-JP')}円`);
      }
    }
    event.items_granted?.forEach((item) => {
      lines.push(`📦 ${itemNames.get(item.item_id) ?? item.item_id} ×${item.quantity} を入手`);
    });
    event.items_dropped?.forEach((item) => {
      lines.push(`📦 ${itemNames.get(item.item_id) ?? item.item_id} ×${item.quantity} を入手できませんでした（インベントリ満杯）`);
    });
    return lines.join('\n');
  }

  private async handleActionCompleted(event: Extract<WorldEvent, { type: 'action_completed' }>): Promise<void> {
    const perceptionText = this.getPerceptionText(event.agent_id);
    if (perceptionText) {
      const choicesText = this.getChoicesText(event.agent_id);
      await this.sendToAgentClearingServerEvent(
        event.agent_id,
        formatActionCompletedMessage(
          this.getWorldContext(event.agent_id),
          event.action_name,
          this.buildActionEffectText(event) || undefined,
          perceptionText,
          this.skillName,
          choicesText,
        ),
      );
    }

    await this.sendWorldLogForAgent(event.agent_id, formatWorldLogAction(event.action_name));
  }

  private async handleActionRejected(
    agentId: string,
    actionName: string,
    rejectionReason: string,
  ): Promise<void> {
    const perceptionText = this.getPerceptionText(agentId);
    if (perceptionText) {
      const choicesText = this.getChoicesText(agentId);
      await this.sendToAgentClearingServerEvent(
        agentId,
        formatActionRejectedMessage(
          this.getWorldContext(agentId),
          actionName,
          rejectionReason,
          perceptionText,
          this.skillName,
          choicesText,
        ),
      );
    } else {
      console.warn(`[handleActionRejected] perceptionText unavailable for agent ${agentId}, sending minimal rejection`);
      await this.sendToAgentClearingServerEvent(
        agentId,
        `「${actionName}」を実行できませんでした。${rejectionReason}`,
      );
    }

    await this.sendWorldLogForAgent(agentId, formatWorldLogActionRejected(actionName, rejectionReason));
  }

  private async handleWaitStarted(agentId: string, durationMs: number, completesAt: number): Promise<void> {
    await this.sendWorldLogForAgent(agentId, formatWorldLogWaitStarted(durationMs, completesAt, this.engine.config.timezone));
  }

  private async handleWaitCompleted(agentId: string, durationMs: number): Promise<void> {
    const perceptionText = this.getPerceptionText(agentId);
    if (perceptionText) {
      const choicesText = this.getChoicesText(agentId);
      await this.sendToAgentClearingServerEvent(
        agentId,
        formatWaitCompletedMessage(this.getWorldContext(agentId), durationMs, perceptionText, this.skillName, choicesText),
      );
    }

    await this.sendWorldLogForAgent(agentId, formatWorldLogWait(durationMs));
  }

  private async handleItemUseStarted(agentId: string, itemName: string, completesAt: number): Promise<void> {
    await this.sendWorldLogForAgent(agentId, formatWorldLogItemUseStarted(itemName, completesAt, this.engine.config.timezone));
  }

  private async handleItemUseCompleted(agentId: string, itemName: string, itemType: ItemType): Promise<void> {
    const perceptionText = this.getPerceptionText(agentId);
    if (perceptionText) {
      const choicesText = this.getChoicesText(agentId);
      await this.sendToAgentClearingServerEvent(
        agentId,
        formatItemUseCompletedMessage(this.getWorldContext(agentId), itemName, itemType, perceptionText, this.skillName, choicesText),
      );
    }

    await this.sendWorldLogForAgent(agentId, formatWorldLogItemUseCompleted(itemName));
  }

  private async handleItemUseVenueRejected(agentId: string, itemName: string, venueHints: string[]): Promise<void> {
    const perceptionText = this.getPerceptionText(agentId);
    if (perceptionText) {
      const choicesText = this.getChoicesText(agentId);
      await this.sendToAgentClearingServerEvent(
        agentId,
        formatItemUseVenueRejectedMessage(this.getWorldContext(agentId), itemName, venueHints, perceptionText, this.skillName, choicesText),
      );
    } else {
      console.warn(`[handleItemUseVenueRejected] perceptionText unavailable for agent ${agentId}, sending minimal rejection`);
      const hintsText = venueHints.length > 0 ? `${venueHints.join('、')} で利用できます。` : '';
      await this.sendToAgentClearingServerEvent(
        agentId,
        `ここでは「${itemName}」を利用できません。${hintsText}`,
      );
    }

    await this.sendWorldLogForAgent(agentId, formatWorldLogItemUseVenueRejected(itemName));
  }

  private async handleConversationRequested(
    targetAgentId: string,
    initiatorName: string,
    initialMessage: string,
  ): Promise<void> {
    await this.sendConversationFollowUp(
      targetAgentId,
      formatConversationRequestedMessage(this.getWorldContext(targetAgentId), initiatorName, initialMessage, this.skillName),
    );
  }

  private async handleConversationAccepted(
    conversationId: string,
    initiatorAgentId: string,
    participantAgentIds: string[],
  ): Promise<void> {
    const participantNames = this.getParticipantNames(participantAgentIds);
    const content = formatWorldLogConversationStarted(...participantNames);
    const threadName = this.buildConversationThreadName(participantAgentIds);
    const threadPromise = this.bot.createWorldLogThread(content, threadName).catch(async (error) => {
      console.warn('Failed to create world log thread.', error);
      if (!(error instanceof WorldLogThreadCreationError && error.startMessagePosted)) {
        await this.bot.sendWorldLog(content).catch((fallbackError) => {
          console.error('Failed to post conversation start to both thread and world log. Message lost.', fallbackError);
        });
      }
      return null;
    });
    this.conversationThreads.set(conversationId, threadPromise);
    const targetName = participantNames.find((name) => name !== this.getAgentName(initiatorAgentId)) ?? participantNames[0] ?? '';
    await this.sendConversationFollowUp(initiatorAgentId, formatConversationAcceptedMessage(targetName));
  }

  private async handleConversationRejected(
    initiatorAgentId: string,
    targetAgentId: string,
    initiatorName: string,
    targetName: string,
    reason: ConversationRejectionReason,
  ): Promise<void> {
    await this.sendConversationRejectedNotification(initiatorAgentId, targetName, reason);
    if (reason === 'server_event') {
      await this.sendConversationRejectedNotification(targetAgentId, initiatorName, reason);
    }
  }

  private async handleConversationMessage(
    listenerAgentId: string,
    speakerName: string,
    message: string,
    closing: boolean,
    participants: ConversationParticipantInfo[],
    actionable: boolean,
    nextSpeakerName?: string,
  ): Promise<void> {
    const content = actionable
      ? (closing
      ? formatConversationClosingPromptMessage(
          this.getWorldContext(listenerAgentId),
          speakerName,
          message,
          this.skillName,
          participants,
        )
      : formatConversationReplyPromptMessage(
          this.getWorldContext(listenerAgentId),
          speakerName,
          message,
          this.skillName,
          participants,
        ))
      : formatConversationFYIMessage(speakerName, message, nextSpeakerName);

    await this.sendConversationFollowUp(listenerAgentId, content);
  }

  private async handleConversationClosing(event: Extract<WorldEvent, { type: 'conversation_closing' }>): Promise<void> {
    if (event.reason !== 'server_event') {
      return;
    }

    await this.sendToAgentClearingServerEvent(
      event.current_speaker_agent_id,
      formatConversationServerEventClosingPromptMessage(
        this.getWorldContext(event.current_speaker_agent_id),
        this.skillName,
        this.getParticipantInfos(event.participant_agent_ids),
      ),
    );
  }

  private async handleConversationPendingJoinCancelled(
    event: Extract<WorldEvent, { type: 'conversation_pending_join_cancelled' }>,
  ): Promise<void> {
    const loggedInAgent = this.engine.state.getLoggedIn(event.agent_id);
    if (!loggedInAgent) {
      return;
    }
    const agentContext = this.getWorldContext(event.agent_id);
    const perceptionText = this.getPerceptionText(event.agent_id);
    const choicesText = this.getChoicesText(event.agent_id);
    await this.sendConversationFollowUp(
      event.agent_id,
      formatConversationPendingJoinCancelledMessage(
        agentContext,
        event.reason,
        perceptionText,
        this.skillName,
        choicesText,
      ),
    );
  }

  private async handleConversationEnded(event: Extract<WorldEvent, { type: 'conversation_ended' }>): Promise<void> {
    const participantNames = this.getParticipantNames(event.participant_agent_ids);
    const endContent = formatWorldLogConversationEnded(...participantNames);

    if (event.reason === 'participant_logged_out') {
      this.pendingForcedConversationEnds.set(event.conversation_id, {
        initiator_agent_id: event.initiator_agent_id,
        participant_agent_ids: [...event.participant_agent_ids],
      });
      if (event.final_message && event.final_speaker_agent_id) {
        for (const listenerAgentId of event.participant_agent_ids.filter((agentId) => agentId !== event.final_speaker_agent_id)) {
          await this.sendConversationFollowUp(
            listenerAgentId,
            formatConversationDeliveredClosingMessage(this.getAgentName(event.final_speaker_agent_id), event.final_message),
          );
        }
      }
      await this.finalizeConversationThread(event.conversation_id, endContent);
      return;
    }

    if (event.final_message && event.final_speaker_agent_id) {
      for (const listenerAgentId of event.participant_agent_ids.filter((agentId) => agentId !== event.final_speaker_agent_id)) {
        await this.sendConversationFollowUp(
          listenerAgentId,
          formatConversationDeliveredClosingMessage(this.getAgentName(event.final_speaker_agent_id), event.final_message),
        );
      }
    }

    for (const participantId of event.participant_agent_ids) {
      const perceptionText = this.getPerceptionText(participantId);
      if (!perceptionText) {
        continue;
      }

      const choicesText = this.getChoicesText(participantId);
      await this.sendConversationFollowUp(
        participantId,
        formatConversationEndedMessage(
          this.getWorldContext(participantId),
          event.reason,
          perceptionText,
          this.skillName,
          choicesText,
        ),
      );
    }

    await this.finalizeConversationThread(event.conversation_id, endContent);
  }

  private async handleConversationJoin(event: Extract<WorldEvent, { type: 'conversation_join' }>): Promise<void> {
    await this.renameConversationThread(event.conversation_id, event.participant_agent_ids);
  }

  private async handleConversationLeave(event: Extract<WorldEvent, { type: 'conversation_leave' }>): Promise<void> {
    const nextSpeakerName = event.next_speaker_agent_id ? this.getAgentName(event.next_speaker_agent_id) : undefined;
    await this.renameConversationThread(event.conversation_id, event.participant_agent_ids);
    await this.postConversationSystemMessage(
      event.conversation_id,
      formatConversationLeaveSystemMessage(event.agent_name, event.message, nextSpeakerName),
    );
  }

  private async handleConversationInactiveCheck(event: Extract<WorldEvent, { type: 'conversation_inactive_check' }>): Promise<void> {
    for (const agentId of event.target_agent_ids) {
      await this.sendConversationFollowUp(
        agentId,
        formatConversationInactiveCheckMessage(this.getWorldContext(agentId), this.skillName),
      );
    }
  }

  private async handleConversationTurnStarted(event: Extract<WorldEvent, { type: 'conversation_turn_started' }>): Promise<void> {
    // Yield to let the concurrent interval handler deliver the previous speaker's
    // message before this handler sends the next turn prompt.
    await Promise.resolve();

    const conversation = this.engine.state.conversations.get(event.conversation_id);
    if (!conversation || !conversation.participant_agent_ids.includes(event.current_speaker_agent_id)) {
      return;
    }

    const participants = this.getParticipantInfos(conversation.participant_agent_ids);
    const content = conversation.status === 'closing'
      ? formatConversationTurnClosingPromptMessage(
          this.getWorldContext(event.current_speaker_agent_id),
          this.skillName,
          participants,
        )
      : formatConversationTurnPromptMessage(
          this.getWorldContext(event.current_speaker_agent_id),
          this.skillName,
          participants,
        );
    await this.sendConversationFollowUp(event.current_speaker_agent_id, content);
  }

  private async finalizeConversationThread(conversationId: string, endContent: string): Promise<void> {
    const threadPromise = this.conversationThreads.get(conversationId);
    this.conversationThreads.delete(conversationId);
    await this.enqueueConversationLog(conversationId, async () => {
      if (!threadPromise) {
        try {
          await this.bot.sendWorldLog(endContent);
        } catch (error) {
          console.error('Failed to send conversation end to world log. Message lost.', error);
        }
        return;
      }

      const threadId = await threadPromise;
      if (!threadId) {
        try {
          await this.bot.sendWorldLog(endContent);
        } catch (error) {
          console.error('Failed to send conversation end to world log. Message lost.', error);
        }
        return;
      }

      try {
        await this.bot.sendToThread(threadId, endContent);
      } catch (error) {
        console.warn(`Failed to send conversation end to thread ${threadId}, falling back to world log.`, error);
        try {
          await this.bot.sendWorldLog(endContent);
        } catch (fallbackError) {
          console.error('Failed to send conversation end to both thread and world log. Message lost.', fallbackError);
        }
        return;
      }

      try {
        await this.bot.archiveThread(threadId);
      } catch (error) {
        console.warn(`Failed to archive conversation thread ${threadId}.`, error);
      }
    });
  }

  private async sendLogoutWorldLog(agentId: string, conversationIds: string[], content: string): Promise<void> {
    const uniqueConversationIds = [...new Set(conversationIds)];
    if (uniqueConversationIds.length === 0) {
      await this.sendWorldLogForAgent(agentId, content);
      return;
    }

    const trailingConversationId = uniqueConversationIds[uniqueConversationIds.length - 1]!;
    const precedingConversationIds = uniqueConversationIds.slice(0, -1);

    await Promise.all(
      precedingConversationIds.map((conversationId) => this.enqueueConversationLog(conversationId, async () => undefined)),
    );
    await this.enqueueConversationLog(trailingConversationId, async () => {
      await this.sendWorldLogForAgent(agentId, content);
    });
  }

  private async enqueueConversationLog(conversationId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.conversationLogDeliveries.get(conversationId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.conversationLogDeliveries.set(conversationId, next);

    try {
      await next;
    } finally {
      if (this.conversationLogDeliveries.get(conversationId) === next) {
        this.conversationLogDeliveries.delete(conversationId);
      }
    }
  }

  private async handleServerEventFired(event: Extract<WorldEvent, { type: 'server_event_fired' }>): Promise<void> {
    for (const agentId of event.delivered_agent_ids) {
      const content = formatServerEventMessage(
        this.getWorldContext(agentId),
        event.description,
        this.skillName,
        this.getChoicesText(agentId, { forceShowActions: true }),
      );
      await this.sendToAgent(agentId, content);
    }

    if (!event.delayed) {
      await this.bot.sendWorldLog(formatWorldLogServerEvent(event.description));
    }
  }

  private getPerceptionText(agentId: string): string {
    const loggedInAgent = this.engine.state.getLoggedIn(agentId);
    if (!loggedInAgent) {
      return '';
    }

    return buildPerceptionText(this.engine.getPerception(agentId));
  }

  private getChoicesText(agentId: string, options?: { forceShowActions?: boolean }): string {
    try {
      return buildChoicesText(this.engine, agentId, options);
    } catch (error) {
      if (error instanceof WorldError) {
        console.warn(`Choices text skipped for agent ${agentId}: ${error.code} - ${error.message}`);
      } else {
        console.error(`Failed to build choices text for agent ${agentId}.`, error);
      }
      return '';
    }
  }

  private async handleMapInfoRequested(agentId: string): Promise<void> {
    if (!this.engine.state.getLoggedIn(agentId)) {
      return;
    }

    const choicesText = this.getChoicesText(agentId);
    await this.sendToAgentClearingServerEvent(
      agentId,
      formatMapInfoMessage(this.getWorldContext(agentId), buildMapSummaryText(this.engine.config.map), this.skillName, choicesText),
    );
  }

  private async handleWorldAgentsInfoRequested(agentId: string): Promise<void> {
    if (!this.engine.state.getLoggedIn(agentId)) {
      return;
    }

    const agentsText = (() => {
      const lines = this.engine
        .getWorldAgents()
        .agents
        .filter((agent) => agent.agent_id !== agentId)
        .sort((left, right) => left.agent_id.localeCompare(right.agent_id))
        .map((agent) => `- ${agent.agent_name} (${agent.agent_id}) - 位置: ${agent.node_id} - 状態: ${agent.state}`);
      return lines.length > 0 ? lines.join('\n') : '他にログイン中のエージェントはいません。';
    })();

    const choicesText = this.getChoicesText(agentId);
    await this.sendToAgentClearingServerEvent(
      agentId,
      formatWorldAgentsInfoMessage(this.getWorldContext(agentId), agentsText, this.skillName, choicesText),
    );
  }

  private async handlePerceptionRequested(agentId: string): Promise<void> {
    if (!this.engine.state.getLoggedIn(agentId)) {
      return;
    }

    const perceptionText = this.getPerceptionText(agentId);

    const choicesText = this.getChoicesText(agentId);
    await this.sendToAgentClearingServerEvent(
      agentId,
      formatPerceptionInfoMessage(this.getWorldContext(agentId), perceptionText, this.skillName, choicesText),
    );
  }

  private async handleAvailableActionsRequested(agentId: string): Promise<void> {
    if (!this.engine.state.getLoggedIn(agentId)) {
      return;
    }

    const lines = getAvailableActionSources(this.engine, agentId).map(
      (source) => `- action: ${formatActionSourceLine(source, this.engine.config.items ?? [])}`,
    );
    const actionsText = lines.length > 0 ? `実行可能なアクション:\n${lines.join('\n')}` : '実行可能なアクションはありません。';
    const choicesText = this.getChoicesText(agentId);
    await this.sendToAgentClearingServerEvent(
      agentId,
      formatAvailableActionsInfoMessage(this.getWorldContext(agentId), actionsText, this.skillName, choicesText),
    );
  }

  private getAgentName(agentId: string): string {
    return this.engine.getAgentById(agentId)?.agent_name ?? agentId;
  }

  private getParticipantInfos(participantAgentIds: string[]): ConversationParticipantInfo[] {
    return participantAgentIds.map((agentId) => ({
      id: agentId,
      name: this.getAgentName(agentId),
    }));
  }

  private getParticipantNames(participantAgentIds: string[]): string[] {
    return this.getParticipantInfos(participantAgentIds).map((participant) => participant.name);
  }

  private getWorldContext(agentId: string): WorldContext {
    return {
      worldName: this.engine.config.world.name,
      worldDescription: this.engine.config.world.description,
      agentName: this.getAgentName(agentId),
    };
  }

  private getWebhookIdentity(agentId: string): WebhookIdentity | null {
    const agent = this.engine.getAgentById(agentId);
    if (!agent) {
      return null;
    }

    return {
      username: agent.agent_name,
      ...(agent.discord_bot_avatar_url ? { avatarURL: agent.discord_bot_avatar_url } : {}),
    };
  }

  private async sendWorldLogForAgent(agentId: string, content: string): Promise<void> {
    const identity = this.getWebhookIdentity(agentId);
    if (identity) {
      await this.bot.sendWorldLogAsAgent(content, identity);
      return;
    }

    await this.bot.sendWorldLog(content);
  }

  private async sendToThreadForAgent(threadId: string, agentId: string, content: string): Promise<void> {
    const identity = this.getWebhookIdentity(agentId);
    if (identity) {
      await this.bot.sendToThreadAsAgent(threadId, content, identity);
      return;
    }

    await this.bot.sendToThread(threadId, content);
  }

  private async sendToAgent(agentId: string, content: string): Promise<void> {
    await this.enqueueAgentMessageDelivery(agentId, async () => {
      await this.sendToAgentNow(agentId, content);
    });
  }

  private async sendToAgentClearingServerEvent(agentId: string, content: string): Promise<void> {
    await this.enqueueAgentMessageDelivery(agentId, async () => {
      try {
        await this.sendToAgentNow(agentId, content);
      } finally {
        clearActiveServerEvent(this.engine, agentId);
      }
    });
  }

  private async sendConversationRejectedNotification(
    agentId: string,
    counterpartName: string,
    reason: ConversationRejectionReason,
  ): Promise<void> {
    const perceptionText = this.getPerceptionText(agentId);
    if (!perceptionText) {
      return;
    }

    const choicesText = this.getChoicesText(agentId);
    await this.sendConversationFollowUp(
      agentId,
      formatConversationRejectedMessage(
        this.getWorldContext(agentId),
        counterpartName,
        reason,
        perceptionText,
        this.skillName,
        choicesText,
      ),
    );
  }

  private async sendConversationFollowUp(agentId: string, content: string): Promise<void> {
    if (this.engine.state.getLoggedIn(agentId)?.active_server_event_id != null) {
      await this.sendToAgentClearingServerEvent(agentId, content);
      return;
    }

    await this.sendToAgent(agentId, content);
  }

  private async enqueueAgentMessageDelivery(agentId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.agentMessageDeliveries.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.agentMessageDeliveries.set(agentId, next);

    try {
      await next;
    } finally {
      if (this.agentMessageDeliveries.get(agentId) === next) {
        this.agentMessageDeliveries.delete(agentId);
      }
    }
  }

  private async sendToAgentNow(agentId: string, content: string): Promise<void> {
    const loggedInAgent = this.engine.state.getLoggedIn(agentId);
    if (!loggedInAgent) {
      return;
    }

    await this.bot.sendAgentMessage(loggedInAgent.discord_channel_id, content);
  }

  private consumeForcedConversationPartners(agentId: string): ForcedConversationPartner[] {
    const partners: ForcedConversationPartner[] = [];

    for (const [conversationId, pending] of this.pendingForcedConversationEnds.entries()) {
      if (pending.initiator_agent_id === agentId) {
        for (const partnerId of pending.participant_agent_ids.filter((participantId) => participantId !== agentId)) {
          partners.push({ conversationId, partnerId });
        }
        this.pendingForcedConversationEnds.delete(conversationId);
      } else if (pending.participant_agent_ids.includes(agentId)) {
        for (const partnerId of pending.participant_agent_ids.filter((participantId) => participantId !== agentId)) {
          partners.push({ conversationId, partnerId });
        }
        this.pendingForcedConversationEnds.delete(conversationId);
      }
    }

    return partners;
  }

  private async postConversationSystemMessage(conversationId: string, content: string): Promise<void> {
    const threadPromise = this.conversationThreads.get(conversationId);
    await this.enqueueConversationLog(conversationId, async () => {
      const threadId = await threadPromise;
      if (threadId) {
        try {
          await this.bot.sendToThread(threadId, content);
          return;
        } catch (error) {
          console.warn(`Failed to send system message to thread ${threadId}, falling back to world log.`, error);
        }
      }
      await this.bot.sendWorldLog(content);
    });
  }

  private buildConversationThreadName(participantAgentIds: string[]): string {
    const participantNames = this.getParticipantNames(participantAgentIds);
    const [initiatorName = '', targetName = ''] = participantNames;
    return formatConversationThreadName(initiatorName, targetName, Math.max(participantNames.length - 2, 0));
  }

  private async renameConversationThread(conversationId: string, participantAgentIds: string[]): Promise<void> {
    if (participantAgentIds.length < 2) {
      return;
    }

    const threadPromise = this.conversationThreads.get(conversationId);
    if (!threadPromise) {
      return;
    }

    const threadId = await threadPromise;
    if (!threadId) {
      return;
    }

    try {
      await this.bot.renameThread(threadId, this.buildConversationThreadName(participantAgentIds));
    } catch (error) {
      console.warn(`Failed to rename conversation thread ${threadId}.`, error);
    }
  }

  private reportError(message: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    void this.bot.sendErrorReport(`${message}\n\`\`\`\n${detail}\n\`\`\``).catch((reportError) => {
      console.error('Failed to send error report to Discord.', reportError);
    });
  }
}
