import { formatActionSourceLine, getAvailableActionSourcesWithOptions } from '../domain/actions.js';
import { buildChoicesPrompt, type BuildChoicesTextOptions } from '../domain/choices.js';
import { buildMapSummaryText } from '../domain/map-summary.js';
import { buildPerceptionText, getNearbyConversationCount, getPerceptionData } from '../domain/perception.js';
import {
  type CandidateAgent,
  listConversationStartCandidates,
  listJoinableActiveConversations,
  listStandaloneTransferCandidates,
} from '../domain/info-commands.js';
import { clearActiveServerAnnouncement } from '../domain/server-announcements.js';
import { getAgentCurrentNode } from '../domain/movement.js';
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
  formatActiveConversationsInfoMessage,
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
  formatInConversationPendingTransferLine,
  formatInConversationTransferOutcomeLine,
  formatConversationServerAnnouncementClosingPromptMessage,
  formatConversationThreadName,
  formatConversationTurnClosingPromptMessage,
  formatConversationTurnPromptMessage,
  formatTransferAcceptedMessage,
  formatTransferAcceptedPrompt,
  formatTransferCancelledMessage,
  formatTransferCancelledPrompt,
  formatTransferEscrowLostMessage,
  formatTransferRejectedMessage,
  formatTransferRejectedPrompt,
  formatTransferRequestedMessage,
  formatTransferSentMessage,
  formatTransferTimeoutMessage,
  formatTransferTimeoutPrompt,
  formatIdleReminderMessage,
  formatItemUseCompletedMessage,
  formatItemUseVenueRejectedMessage,
  formatMapInfoMessage,
  formatMovementCompletedMessage,
  formatNearbyAgentsInfoMessage,
  formatPerceptionInfoMessage,
  formatServerAnnouncementMessage,
  formatServerEventsInfoMessage,
  formatStatusInfoMessage,
  formatWaitCompletedMessage,
  formatWorldAgentsInfoMessage,
  formatWorldLogAction,
  formatWorldLogActionRejected,
  formatWorldLogActionStarted,
  formatWorldLogConversationMessage,
  formatWorldLogConversationEnded,
  formatWorldLogItemUseCompleted,
  formatWorldLogTransferAccepted,
  formatWorldLogTransferCancelled,
  formatWorldLogTransferEscrowLost,
  formatWorldLogTransferRejected,
  formatWorldLogTransferRequested,
  formatWorldLogTransferTimeout,
  formatWorldLogItemUseStarted,
  formatWorldLogItemUseVenueRejected,
  formatWorldLogMovementStarted,
  formatWorldLogWaitStarted,
  formatWorldLogConversationStarted,
  formatWorldLogLoggedIn,
  formatWorldLogLoggedOut,
  formatWorldLogMovement,
  formatWorldLogServerAnnouncement,
  formatWorldLogServerEventCleared,
  formatWorldLogServerEventCreated,
  formatWorldLogWait,
  type ConversationParticipantInfo,
  type TransferOptionsHint,
  type WorldContext,
} from './notification.js';

interface PendingForcedConversationEnd {
  initiator_agent_id: string;
  participant_agent_ids: string[];
}

interface InConversationTransferAnnotation {
  partnerName: string;
  item: { item_id: string; quantity: number } | null;
  money: number;
  outcome: 'accepted' | 'rejected_by_receiver' | 'unanswered_speak' | 'inventory_full' | 'timeout';
}

interface ForcedConversationPartner {
  conversationId: string;
  partnerId: string;
}

interface ChoicesPromptSuppressionSnapshot {
  rejectedActionId: string | null;
  usedItemId: string | null;
}

export class DiscordEventHandler {
  private unsubscribe: (() => void) | null = null;
  private readonly pendingForcedConversationEnds = new Map<string, PendingForcedConversationEnd>();
  private readonly conversationThreads = new Map<string, Promise<string | null>>();
  private readonly conversationLogDeliveries = new Map<string, Promise<void>>();
  private readonly agentMessageDeliveries = new Map<string, Promise<void>>();
  /**
   * in_conversation transfer の決着結果を、対象エージェントの次の conversation_message 通知本文に
   * inline で埋めるための一時キャッシュ。key = `${conversation_id}:${recipient_agent_id}`。
   * handleTransferAccepted/Rejected/Timeout で in_conversation のときに書き込み、
   * handleConversationMessage が読み取り次第クリアする。
   */
  private readonly inConversationTransferAnnotations = new Map<string, InConversationTransferAnnotation>();
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
        await this.handleActionRejected(event.agent_id, event.action_id, event.action_name, event.rejection_reason);
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
      case 'transfer_requested':
        await this.handleTransferRequested(event);
        return;
      case 'transfer_accepted':
        await this.handleTransferAccepted(event);
        return;
      case 'transfer_rejected':
        await this.handleTransferRejected(event);
        return;
      case 'transfer_timeout':
        await this.handleTransferTimeout(event);
        return;
      case 'transfer_cancelled':
        await this.handleTransferCancelled(event);
        return;
      case 'transfer_escrow_lost':
        await this.handleTransferEscrowLost(event);
        return;
      case 'server_announcement_fired':
        await this.handleServerAnnouncementFired(event);
        return;
      case 'server_event_created':
        await this.handleServerEventCreated(event);
        return;
      case 'server_event_cleared':
        await this.handleServerEventCleared(event);
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
      case 'status_info_requested':
        await this.handleStatusInfoRequested(event.agent_id);
        return;
      case 'nearby_agents_info_requested':
        await this.handleNearbyAgentsInfoRequested(event.agent_id);
        return;
      case 'active_conversations_info_requested':
        await this.handleActiveConversationsInfoRequested(event.agent_id);
        return;
      case 'server_events_info_requested':
        await this.handleServerEventsInfoRequested(event.agent_id);
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
    const suppressionSnapshot = this.captureChoicesPromptSuppressions(timer.agent_id);
    let consumedRejectedActionId: string | null = null;
    let consumedUsedItemId: string | null = null;
    await this.sendToAgentClearingServerAnnouncementBuilt(timer.agent_id, () => {
      const agent = this.engine.state.getLoggedIn(timer.agent_id);
      if (!agent || agent.pending_conversation_id) {
        return null;
      }

      const perception = this.buildPerceptionTextForAgent(timer.agent_id, suppressionSnapshot.usedItemId);
      if (!perception.text) {
        return null;
      }

      const choicesPrompt = this.getChoicesPrompt(timer.agent_id, undefined, suppressionSnapshot);
      consumedRejectedActionId = choicesPrompt.consumedRejectedActionId;
      consumedUsedItemId = perception.consumedUsedItemId;
      const elapsedMs = Date.now() - timer.idle_since;
      return formatIdleReminderMessage(
        this.getWorldContext(timer.agent_id),
        elapsedMs,
        perception.text,
        this.skillName,
        choicesPrompt.choicesText,
      );
    }, () => this.clearChoicesPromptSuppressionsIfCurrent(timer.agent_id, consumedRejectedActionId, consumedUsedItemId));
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
        && conversation.closing_reason === 'server_announcement'
        && conversation.current_speaker_agent_id === nextSpeakerAgentId
      ) {
        await this.sendConversationFollowUp(
          listenerAgentId,
          formatConversationDeliveredClosingMessage(this.getAgentName(timer.speaker_agent_id), timer.message),
        );
        continue;
      }

      await this.handleConversationMessage(
        timer.conversation_id,
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
        event.conversation_id,
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
    const suppressionSnapshot = this.captureChoicesPromptSuppressions(agentId);
    let consumedRejectedActionId: string | null = null;
    await this.sendToAgentBuilt(
      agentId,
      () => {
        const perceptionText = this.getPerceptionText(agentId);
        if (!perceptionText) {
          return null;
        }

        const choicesPrompt = this.getChoicesPrompt(agentId, undefined, suppressionSnapshot);
        consumedRejectedActionId = choicesPrompt.consumedRejectedActionId;
        return formatAgentLoggedInMessage(this.getWorldContext(agentId), perceptionText, this.skillName, choicesPrompt.choicesText);
      },
      () => this.clearChoicesPromptSuppressionsIfCurrent(agentId, consumedRejectedActionId, null),
    );

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
      const suppressionSnapshot = this.captureChoicesPromptSuppressions(partnerId);
      let consumedRejectedActionId: string | null = null;
      await this.sendConversationFollowUpBuilt(
        partnerId,
        () => {
          const perceptionText = this.getPerceptionText(partnerId);
          if (!perceptionText) {
            return null;
          }

          const choicesPrompt = this.getChoicesPrompt(partnerId, undefined, suppressionSnapshot);
          consumedRejectedActionId = choicesPrompt.consumedRejectedActionId;
          return formatConversationForcedEndedMessage(
            this.getWorldContext(partnerId),
            event.agent_name,
            perceptionText,
            this.skillName,
            choicesPrompt.choicesText,
          );
        },
        () => this.clearChoicesPromptSuppressionsIfCurrent(partnerId, consumedRejectedActionId, null),
      );
    }

    await this.sendLogoutWorldLog(
      event.agent_id,
      forcedConversationPartners.map(({ conversationId }) => conversationId),
      formatWorldLogLoggedOut(event.cancelled_state, event.cancelled_action_name),
    );
  }

  private async handleMovementStarted(agentId: string, toNodeId: NodeId, arrivesAt: number): Promise<void> {
    const label = this.engine.config.map.nodes[toNodeId]?.label;
    await this.sendWorldLogForAgent(agentId, formatWorldLogMovementStarted(toNodeId, arrivesAt, this.engine.config.timezone, label));
  }

  private async handleMovementCompleted(agentId: string, _agentName: string, toNodeId: NodeId): Promise<void> {
    const label = this.engine.config.map.nodes[toNodeId]?.label;
    const suppressionSnapshot = this.captureChoicesPromptSuppressions(agentId);
    let consumedRejectedActionId: string | null = null;
    await this.sendToAgentClearingServerAnnouncementBuilt(agentId, () => {
      const perceptionText = this.getPerceptionText(agentId);
      if (!perceptionText) {
        return null;
      }

      const choicesPrompt = this.getChoicesPrompt(agentId, undefined, suppressionSnapshot);
      consumedRejectedActionId = choicesPrompt.consumedRejectedActionId;
      return formatMovementCompletedMessage(
        this.getWorldContext(agentId),
        toNodeId,
        label,
        perceptionText,
        this.skillName,
        choicesPrompt.choicesText,
      );
    }, () => this.clearChoicesPromptSuppressionsIfCurrent(agentId, consumedRejectedActionId, null));
    await this.sendWorldLogForAgent(agentId, formatWorldLogMovement(toNodeId, label));
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
    const suppressionSnapshot = this.captureChoicesPromptSuppressions(event.agent_id);
    let consumedRejectedActionId: string | null = null;
    await this.sendToAgentClearingServerAnnouncementBuilt(event.agent_id, () => {
      const perceptionText = this.getPerceptionText(event.agent_id);
      if (!perceptionText) {
        return null;
      }

      const choicesPrompt = this.getChoicesPrompt(event.agent_id, undefined, suppressionSnapshot);
      consumedRejectedActionId = choicesPrompt.consumedRejectedActionId;
      return formatActionCompletedMessage(
        this.getWorldContext(event.agent_id),
        event.action_name,
        this.buildActionEffectText(event) || undefined,
        perceptionText,
        this.skillName,
        choicesPrompt.choicesText,
      );
    }, () => this.clearChoicesPromptSuppressionsIfCurrent(event.agent_id, consumedRejectedActionId, null));

    await this.sendWorldLogForAgent(event.agent_id, formatWorldLogAction(event.action_name));
  }

  private async handleActionRejected(
    agentId: string,
    actionId: string,
    actionName: string,
    rejectionReason: string,
  ): Promise<void> {
    const suppressionSnapshot = this.captureChoicesPromptSuppressions(agentId);
    let consumedRejectedActionId: string | null = null;
    await this.sendToAgentClearingServerAnnouncementBuilt(
      agentId,
      () => {
        const perceptionText = this.getPerceptionText(agentId);
        if (perceptionText) {
          const choicesPrompt = this.getChoicesPrompt(agentId, {
            excludedActionIds: [actionId],
            includeStoredRejectedAction: false,
          }, suppressionSnapshot);
          consumedRejectedActionId = choicesPrompt.suppressedActionIds.includes(actionId) ? actionId : null;
          return formatActionRejectedMessage(
            this.getWorldContext(agentId),
            actionName,
            rejectionReason,
            perceptionText,
            this.skillName,
            choicesPrompt.choicesText,
          );
        }

        console.warn(`[handleActionRejected] perceptionText unavailable for agent ${agentId}, sending minimal rejection`);
        return `「${actionName}」を実行できませんでした。${rejectionReason}`;
      },
      () => {
        this.clearChoicesPromptSuppressionsIfCurrent(agentId, consumedRejectedActionId, null);
      },
    );

    await this.sendWorldLogForAgent(agentId, formatWorldLogActionRejected(actionName, rejectionReason));
  }

  private async handleWaitStarted(agentId: string, durationMs: number, completesAt: number): Promise<void> {
    await this.sendWorldLogForAgent(agentId, formatWorldLogWaitStarted(durationMs, completesAt, this.engine.config.timezone));
  }

  private async handleWaitCompleted(agentId: string, durationMs: number): Promise<void> {
    const suppressionSnapshot = this.captureChoicesPromptSuppressions(agentId);
    let consumedRejectedActionId: string | null = null;
    await this.sendToAgentClearingServerAnnouncementBuilt(agentId, () => {
      const perceptionText = this.getPerceptionText(agentId);
      if (!perceptionText) {
        return null;
      }

      const choicesPrompt = this.getChoicesPrompt(agentId, undefined, suppressionSnapshot);
      consumedRejectedActionId = choicesPrompt.consumedRejectedActionId;
      return formatWaitCompletedMessage(
        this.getWorldContext(agentId),
        durationMs,
        perceptionText,
        this.skillName,
        choicesPrompt.choicesText,
      );
    }, () => this.clearChoicesPromptSuppressionsIfCurrent(agentId, consumedRejectedActionId, null));

    await this.sendWorldLogForAgent(agentId, formatWorldLogWait(durationMs));
  }

  private async handleItemUseStarted(agentId: string, itemName: string, completesAt: number): Promise<void> {
    await this.sendWorldLogForAgent(agentId, formatWorldLogItemUseStarted(itemName, completesAt, this.engine.config.timezone));
  }

  private async handleItemUseCompleted(agentId: string, itemName: string, itemType: ItemType): Promise<void> {
    const suppressionSnapshot = this.captureChoicesPromptSuppressions(agentId);
    let consumedRejectedActionId: string | null = null;
    await this.sendToAgentClearingServerAnnouncementBuilt(agentId, () => {
      const perceptionText = this.getPerceptionText(agentId);
      if (!perceptionText) {
        return null;
      }

      const choicesPrompt = this.getChoicesPrompt(agentId, undefined, suppressionSnapshot);
      consumedRejectedActionId = choicesPrompt.consumedRejectedActionId;
      return formatItemUseCompletedMessage(
        this.getWorldContext(agentId),
        itemName,
        itemType,
        perceptionText,
        this.skillName,
        choicesPrompt.choicesText,
      );
    }, () => this.clearChoicesPromptSuppressionsIfCurrent(agentId, consumedRejectedActionId, null));

    await this.sendWorldLogForAgent(agentId, formatWorldLogItemUseCompleted(itemName));
  }

  private async handleItemUseVenueRejected(agentId: string, itemName: string, venueHints: string[]): Promise<void> {
    const suppressionSnapshot = this.captureChoicesPromptSuppressions(agentId);
    let consumedRejectedActionId: string | null = null;
    await this.sendToAgentClearingServerAnnouncementBuilt(agentId, () => {
      const perception = this.buildPerceptionTextForAgent(agentId, suppressionSnapshot.usedItemId);
      if (perception.text) {
        const choicesPrompt = this.getChoicesPrompt(agentId, undefined, suppressionSnapshot);
        consumedRejectedActionId = choicesPrompt.consumedRejectedActionId;
        return formatItemUseVenueRejectedMessage(
          this.getWorldContext(agentId),
          itemName,
          venueHints,
          perception.text,
          this.skillName,
          choicesPrompt.choicesText,
        );
      }

      console.warn(`[handleItemUseVenueRejected] perceptionText unavailable for agent ${agentId}, sending minimal rejection`);
      const hintsText = venueHints.length > 0 ? `${venueHints.join('、')} で利用できます。` : '';
      return `ここでは「${itemName}」を利用できません。${hintsText}`;
    }, () => {
      this.clearChoicesPromptSuppressionsIfCurrent(agentId, consumedRejectedActionId, null);
    });

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
    if (reason === 'server_announcement') {
      await this.sendConversationRejectedNotification(targetAgentId, initiatorName, reason);
    }
  }

  private async handleConversationMessage(
    conversationId: string,
    listenerAgentId: string,
    speakerName: string,
    message: string,
    closing: boolean,
    participants: ConversationParticipantInfo[],
    actionable: boolean,
    nextSpeakerName?: string,
  ): Promise<void> {
    // 会話本体メッセージの直前/直後で発生した in_conversation transfer の状況を inline で添える。
    // 1) 受け手が pending offer を抱えていれば「X から Y の譲渡提案が届いています」を append。
    // 2) 直前のターンで決着した outcome (accept / reject / unanswered_speak / inventory_full / timeout)
    //    がキャッシュにあれば inline で append しキャッシュを消費する。
    // どちらが乗っているかで会話 reply プロンプトの transfer_response トーンも変える。
    const pendingOffer = this.resolveInConversationPendingOffer(conversationId, listenerAgentId);
    const cachedOutcome = this.consumeInConversationTransferAnnotation(conversationId, listenerAgentId);
    const inlineLines: string[] = [];
    if (pendingOffer) {
      inlineLines.push(formatInConversationPendingTransferLine(pendingOffer.fromName, pendingOffer.item, pendingOffer.money));
    }
    if (cachedOutcome) {
      inlineLines.push(formatInConversationTransferOutcomeLine(cachedOutcome.partnerName, cachedOutcome.item, cachedOutcome.money, cachedOutcome.outcome));
    }
    const inlineNote = inlineLines.length > 0 ? inlineLines.join('\n') : undefined;
    const content = actionable
      ? (closing
      ? formatConversationClosingPromptMessage(
          this.getWorldContext(listenerAgentId),
          speakerName,
          message,
          this.skillName,
          participants,
          { transferNote: inlineNote, hasPendingOffer: pendingOffer !== null },
        )
      : formatConversationReplyPromptMessage(
          this.getWorldContext(listenerAgentId),
          speakerName,
          message,
          this.skillName,
          participants,
          this.getTransferOptionsHint(listenerAgentId),
          { transferNote: inlineNote, hasPendingOffer: pendingOffer !== null },
        ))
      : formatConversationFYIMessage(speakerName, message, nextSpeakerName);

    await this.sendConversationFollowUp(listenerAgentId, content);
  }

  private async handleConversationClosing(event: Extract<WorldEvent, { type: 'conversation_closing' }>): Promise<void> {
    if (event.reason !== 'server_announcement') {
      return;
    }

    await this.sendToAgentClearingServerAnnouncement(
      event.current_speaker_agent_id,
      formatConversationServerAnnouncementClosingPromptMessage(
        this.getWorldContext(event.current_speaker_agent_id),
        this.skillName,
        this.getParticipantInfos(event.participant_agent_ids),
      ),
    );
  }

  private async handleConversationPendingJoinCancelled(
    event: Extract<WorldEvent, { type: 'conversation_pending_join_cancelled' }>,
  ): Promise<void> {
    const suppressionSnapshot = this.captureChoicesPromptSuppressions(event.agent_id);
    let consumedRejectedActionId: string | null = null;
    await this.sendConversationFollowUpBuilt(
      event.agent_id,
      () => {
        const loggedInAgent = this.engine.state.getLoggedIn(event.agent_id);
        if (!loggedInAgent) {
          return null;
        }

        const choicesPrompt = this.getChoicesPrompt(event.agent_id, undefined, suppressionSnapshot);
        consumedRejectedActionId = choicesPrompt.consumedRejectedActionId;
        return formatConversationPendingJoinCancelledMessage(
          this.getWorldContext(event.agent_id),
          event.reason,
          this.getPerceptionText(event.agent_id),
          this.skillName,
          choicesPrompt.choicesText,
        );
      },
      () => this.clearChoicesPromptSuppressionsIfCurrent(event.agent_id, consumedRejectedActionId, null),
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

    const conversationEndReason = event.reason;
    for (const participantId of event.participant_agent_ids) {
      const suppressionSnapshot = this.captureChoicesPromptSuppressions(participantId);
      let consumedRejectedActionId: string | null = null;
      await this.sendConversationFollowUpBuilt(
        participantId,
        () => {
          const perceptionText = this.getPerceptionText(participantId);
          if (!perceptionText) {
            return null;
          }

          const choicesPrompt = this.getChoicesPrompt(participantId, undefined, suppressionSnapshot);
          consumedRejectedActionId = choicesPrompt.consumedRejectedActionId;
          return formatConversationEndedMessage(
            this.getWorldContext(participantId),
            conversationEndReason,
            perceptionText,
            this.skillName,
            choicesPrompt.choicesText,
          );
        },
        () => this.clearChoicesPromptSuppressionsIfCurrent(participantId, consumedRejectedActionId, null),
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
    // turn prompt にも pending offer / outcome inline を反映する。
    const pendingOffer = this.resolveInConversationPendingOffer(event.conversation_id, event.current_speaker_agent_id);
    const cachedOutcome = this.consumeInConversationTransferAnnotation(event.conversation_id, event.current_speaker_agent_id);
    const inlineLines: string[] = [];
    if (pendingOffer) {
      inlineLines.push(formatInConversationPendingTransferLine(pendingOffer.fromName, pendingOffer.item, pendingOffer.money));
    }
    if (cachedOutcome) {
      inlineLines.push(formatInConversationTransferOutcomeLine(cachedOutcome.partnerName, cachedOutcome.item, cachedOutcome.money, cachedOutcome.outcome));
    }
    const transferInline = {
      transferNote: inlineLines.length > 0 ? inlineLines.join('\n') : undefined,
      hasPendingOffer: pendingOffer !== null,
    };
    const content = conversation.status === 'closing'
      ? formatConversationTurnClosingPromptMessage(
          this.getWorldContext(event.current_speaker_agent_id),
          this.skillName,
          participants,
          transferInline,
        )
      : formatConversationTurnPromptMessage(
          this.getWorldContext(event.current_speaker_agent_id),
          this.skillName,
          participants,
          this.getTransferOptionsHint(event.current_speaker_agent_id),
          transferInline,
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

  private async handleServerAnnouncementFired(event: Extract<WorldEvent, { type: 'server_announcement_fired' }>): Promise<void> {
    for (const agentId of event.delivered_agent_ids) {
      const suppressionSnapshot = this.captureChoicesPromptSuppressions(agentId);
      let consumedRejectedActionId: string | null = null;
      await this.sendToAgentBuilt(
        agentId,
        () => {
          const choicesPrompt = this.getChoicesPrompt(agentId, { forceShowActions: true }, suppressionSnapshot);
          consumedRejectedActionId = choicesPrompt.consumedRejectedActionId;
          return formatServerAnnouncementMessage(
            this.getWorldContext(agentId),
            event.description,
            this.skillName,
            choicesPrompt.choicesText,
          );
        },
        () => this.clearChoicesPromptSuppressionsIfCurrent(agentId, consumedRejectedActionId, null),
      );
    }

    if (!event.delayed) {
      await this.bot.sendWorldLog(formatWorldLogServerAnnouncement(event.description));
    }
  }

  private async handleServerEventCreated(event: Extract<WorldEvent, { type: 'server_event_created' }>): Promise<void> {
    await this.sendServerEventWorldLog(
      'server_event_created',
      formatWorldLogServerEventCreated(event.server_event.description),
    );
  }

  private async handleServerEventCleared(event: Extract<WorldEvent, { type: 'server_event_cleared' }>): Promise<void> {
    await this.sendServerEventWorldLog(
      'server_event_cleared',
      formatWorldLogServerEventCleared(event.server_event.description),
    );
  }

  private async sendServerEventWorldLog(kind: string, content: string): Promise<void> {
    try {
      await this.bot.sendWorldLog(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to send ${kind} world log.`, error);
      this.engine.reportError(`${kind} の world-log 投稿に失敗しました: ${message}`);
    }
  }

  private buildPerceptionTextForAgent(agentId: string, hiddenItemId: string | null): { text: string; consumedUsedItemId: string | null } {
    const loggedInAgent = this.engine.state.getLoggedIn(agentId);
    if (!loggedInAgent) {
      return { text: '', consumedUsedItemId: null };
    }

    const perception = getPerceptionData(this.engine, agentId);
    const nearbyConversationCount = getNearbyConversationCount(this.engine, agentId);
    const serverEventCount = this.engine.state.serverEvents.listActive().length;
    const consumedUsedItemId = hiddenItemId && perception.items.some((item) => item.item_id === hiddenItemId && item.quantity > 0)
      ? hiddenItemId
      : null;
    return {
      text: buildPerceptionText(perception, { hiddenItemId, nearbyConversationCount, serverEventCount }),
      consumedUsedItemId,
    };
  }

  private getPerceptionText(agentId: string): string {
    if (!this.engine.state.getLoggedIn(agentId)) {
      return '';
    }
    const nearbyConversationCount = getNearbyConversationCount(this.engine, agentId);
    const serverEventCount = this.engine.state.serverEvents.listActive().length;
    return buildPerceptionText(getPerceptionData(this.engine, agentId), { nearbyConversationCount, serverEventCount });
  }

  private clearRejectedActionIfCurrent(agentId: string, actionId: string | null): void {
    if (actionId && this.engine.state.getLoggedIn(agentId)?.last_rejected_action_id === actionId) {
      this.engine.state.setLastRejectedAction(agentId, null);
    }
  }

  private clearLastUsedItemIfCurrent(agentId: string, itemId: string | null): void {
    if (itemId && this.engine.state.getLoggedIn(agentId)?.last_used_item_id === itemId) {
      this.engine.state.setLastUsedItem(agentId, null);
    }
  }

  private clearChoicesPromptSuppressionsIfCurrent(
    agentId: string,
    actionId: string | null,
    itemId: string | null,
  ): void {
    this.clearRejectedActionIfCurrent(agentId, actionId);
    this.clearLastUsedItemIfCurrent(agentId, itemId);
  }

  private captureChoicesPromptSuppressions(agentId: string): ChoicesPromptSuppressionSnapshot {
    const loggedInAgent = this.engine.state.getLoggedIn(agentId);
    return {
      rejectedActionId: loggedInAgent?.last_rejected_action_id ?? null,
      usedItemId: loggedInAgent?.last_used_item_id ?? null,
    };
  }

  private mergeChoiceSuppressionIds(ids: readonly string[] | undefined, id: string | null): string[] | undefined {
    if (!id) {
      return ids ? [...ids] : undefined;
    }

    return [...new Set([...(ids ?? []), id])];
  }

  private getChoicesPrompt(
    agentId: string,
    options?: BuildChoicesTextOptions,
    suppressionSnapshot?: ChoicesPromptSuppressionSnapshot,
  ): {
    choicesText: string;
    consumedRejectedActionId: string | null;
    suppressedActionIds: string[];
  } {
    try {
      const prompt = buildChoicesPrompt(
        this.engine,
        agentId,
        suppressionSnapshot
          ? {
              ...options,
              excludedActionIds: this.mergeChoiceSuppressionIds(options?.excludedActionIds, suppressionSnapshot.rejectedActionId),
              includeStoredRejectedAction: false,
            }
          : options,
      );
      const loggedInAgent = this.engine.state.getLoggedIn(agentId);
      const consumedRejectedActionId = suppressionSnapshot
        ? (
          suppressionSnapshot.rejectedActionId
          && prompt.suppressedActionIds.includes(suppressionSnapshot.rejectedActionId)
            ? suppressionSnapshot.rejectedActionId
            : null
        )
        : (
          loggedInAgent?.last_rejected_action_id
          && prompt.suppressedActionIds.includes(loggedInAgent.last_rejected_action_id)
            ? loggedInAgent.last_rejected_action_id
            : null
        );
      return {
        choicesText: prompt.text,
        consumedRejectedActionId,
        suppressedActionIds: prompt.suppressedActionIds,
      };
    } catch (error) {
      if (!(error instanceof WorldError)) {
        throw error;
      }
      console.warn(`Choices text skipped for agent ${agentId}: ${error.code} - ${error.message}`);
      return {
        choicesText: '',
        consumedRejectedActionId: null,
        suppressedActionIds: [],
      };
    }
  }

  private async handleMapInfoRequested(agentId: string): Promise<void> {
    if (!this.engine.state.getLoggedIn(agentId)) {
      return;
    }

    const suppressionSnapshot = this.captureChoicesPromptSuppressions(agentId);
    let consumedRejectedActionId: string | null = null;
    await this.sendToAgentBuilt(agentId, () => {
      // 通常は入口 (REST/MCP) で addExcludedInfoCommand 済みのため store 経由でも除外されるが、
      // 入口を経ない直接 emit に対する保険として excludeInfoCommands を併記する。
      const choicesPrompt = this.getChoicesPrompt(agentId, { excludeInfoCommands: ['get_map'] }, suppressionSnapshot);
      consumedRejectedActionId = choicesPrompt.consumedRejectedActionId;
      return formatMapInfoMessage(
        this.getWorldContext(agentId),
        buildMapSummaryText(this.engine.config.map),
        this.skillName,
        choicesPrompt.choicesText,
      );
    }, () => this.clearChoicesPromptSuppressionsIfCurrent(agentId, consumedRejectedActionId, null));
  }

  private async handleWorldAgentsInfoRequested(agentId: string): Promise<void> {
    if (!this.engine.state.getLoggedIn(agentId)) {
      return;
    }

    const agentsText = (() => {
      const lines = this.engine
        .getSnapshot()
        .agents
        .filter((agent) => agent.agent_id !== agentId)
        .sort((left, right) => left.agent_id.localeCompare(right.agent_id))
        .map((agent) => `- ${agent.agent_name} (${agent.agent_id}) - 位置: ${agent.node_id} - 状態: ${agent.state}`);
      return lines.length > 0 ? lines.join('\n') : '他にログイン中のエージェントはいません。';
    })();

    const suppressionSnapshot = this.captureChoicesPromptSuppressions(agentId);
    let consumedRejectedActionId: string | null = null;
    await this.sendToAgentBuilt(agentId, () => {
      const choicesPrompt = this.getChoicesPrompt(agentId, { excludeInfoCommands: ['get_world_agents'] }, suppressionSnapshot);
      consumedRejectedActionId = choicesPrompt.consumedRejectedActionId;
      return formatWorldAgentsInfoMessage(this.getWorldContext(agentId), agentsText, this.skillName, choicesPrompt.choicesText);
    }, () => this.clearChoicesPromptSuppressionsIfCurrent(agentId, consumedRejectedActionId, null));
  }

  private buildStatusInfoText(agentId: string, hiddenItemId: string | null): { text: string; consumedUsedItemId: string | null } {
    const agent = this.engine.state.getLoggedIn(agentId);
    if (!agent) {
      return { text: '', consumedUsedItemId: null };
    }
    const itemNames = new Map((this.engine.config.items ?? []).map((item) => [item.item_id, item.name]));
    const hidden = hiddenItemId && agent.items.some((item) => item.item_id === hiddenItemId && item.quantity > 0) ? hiddenItemId : null;
    const itemLines = agent.items
      .filter((item) => item.quantity > 0 && item.item_id !== hidden)
      .sort((left, right) => left.item_id.localeCompare(right.item_id))
      .map((item) => `- ${itemNames.get(item.item_id) ?? item.item_id} (${item.item_id}) ×${item.quantity}`);
    const nodeId = getAgentCurrentNode(this.engine, agent, Date.now());
    return {
      text: [
        `現在地: ${nodeId}`,
        `所持金: ${agent.money.toLocaleString('ja-JP')}円`,
        itemLines.length > 0 ? `所持品:\n${itemLines.join('\n')}` : '所持品: なし',
      ].join('\n'),
      consumedUsedItemId: hidden,
    };
  }

  private async handleStatusInfoRequested(agentId: string): Promise<void> {
    if (!this.engine.state.getLoggedIn(agentId)) {
      return;
    }

    const suppressionSnapshot = this.captureChoicesPromptSuppressions(agentId);
    let consumedRejectedActionId: string | null = null;
    let consumedUsedItemId: string | null = null;
    await this.sendToAgentBuilt(agentId, () => {
      const statusInfo = this.buildStatusInfoText(agentId, suppressionSnapshot.usedItemId);
      consumedUsedItemId = statusInfo.consumedUsedItemId;
      const choicesPrompt = this.getChoicesPrompt(agentId, { excludeInfoCommands: ['get_status'] }, suppressionSnapshot);
      consumedRejectedActionId = choicesPrompt.consumedRejectedActionId;
      return formatStatusInfoMessage(this.getWorldContext(agentId), statusInfo.text, this.skillName, choicesPrompt.choicesText);
    }, () => this.clearChoicesPromptSuppressionsIfCurrent(agentId, consumedRejectedActionId, consumedUsedItemId));
  }

  private async handleNearbyAgentsInfoRequested(agentId: string): Promise<void> {
    if (!this.engine.state.getLoggedIn(agentId)) {
      return;
    }

    const formatCandidate = (agent: CandidateAgent) =>
      `- ${agent.agent_name} (${agent.agent_id}) - ${agent.state}`;
    const conversationCandidates = listConversationStartCandidates(this.engine, agentId).map(formatCandidate);
    const transferCandidates = listStandaloneTransferCandidates(this.engine, agentId).map(formatCandidate);
    const agentsText = [
      'conversation_candidates:',
      conversationCandidates.length > 0 ? conversationCandidates.join('\n') : '- なし',
      'transfer_candidates:',
      transferCandidates.length > 0 ? transferCandidates.join('\n') : '- なし',
    ].join('\n');

    const suppressionSnapshot = this.captureChoicesPromptSuppressions(agentId);
    let consumedRejectedActionId: string | null = null;
    await this.sendToAgentBuilt(agentId, () => {
      const choicesPrompt = this.getChoicesPrompt(agentId, { excludeInfoCommands: ['get_nearby_agents'] }, suppressionSnapshot);
      consumedRejectedActionId = choicesPrompt.consumedRejectedActionId;
      return formatNearbyAgentsInfoMessage(this.getWorldContext(agentId), agentsText, this.skillName, choicesPrompt.choicesText);
    }, () => this.clearChoicesPromptSuppressionsIfCurrent(agentId, consumedRejectedActionId, null));
  }

  private async handleActiveConversationsInfoRequested(agentId: string): Promise<void> {
    if (!this.engine.state.getLoggedIn(agentId)) {
      return;
    }

    const lines = listJoinableActiveConversations(this.engine, agentId)
      .map((conversation) => {
        const participants = conversation.participant_agent_ids
          .map((participantId) => {
            const agent = this.engine.getAgentById(participantId);
            return `${agent?.agent_name ?? participantId} (${participantId})`;
          })
          .join('、');
        return `- ${conversation.conversation_id}: ${participants}`;
      });
    const conversationsText = lines.length > 0 ? `参加可能な進行中の会話:\n${lines.join('\n')}` : '参加可能な進行中の会話はありません。';

    const suppressionSnapshot = this.captureChoicesPromptSuppressions(agentId);
    let consumedRejectedActionId: string | null = null;
    await this.sendToAgentBuilt(agentId, () => {
      const choicesPrompt = this.getChoicesPrompt(agentId, { excludeInfoCommands: ['get_active_conversations'] }, suppressionSnapshot);
      consumedRejectedActionId = choicesPrompt.consumedRejectedActionId;
      return formatActiveConversationsInfoMessage(this.getWorldContext(agentId), conversationsText, this.skillName, choicesPrompt.choicesText);
    }, () => this.clearChoicesPromptSuppressionsIfCurrent(agentId, consumedRejectedActionId, null));
  }

  private async handleServerEventsInfoRequested(agentId: string): Promise<void> {
    if (!this.engine.state.getLoggedIn(agentId)) {
      return;
    }
    const lines = this.engine.state.serverEvents.listActive().map(
      (event) => `- ${event.server_event_id}: ${event.description}`,
    );
    const eventsText = lines.length > 0 ? `実施中のサーバーイベント:\n${lines.join('\n')}` : '実施中のサーバーイベントはありません。';
    const suppressionSnapshot = this.captureChoicesPromptSuppressions(agentId);
    let consumedRejectedActionId: string | null = null;
    await this.sendToAgentBuilt(agentId, () => {
      const choicesPrompt = this.getChoicesPrompt(agentId, { excludeInfoCommands: ['get_event'] }, suppressionSnapshot);
      consumedRejectedActionId = choicesPrompt.consumedRejectedActionId;
      return formatServerEventsInfoMessage(this.getWorldContext(agentId), eventsText, this.skillName, choicesPrompt.choicesText);
    }, () => this.clearChoicesPromptSuppressionsIfCurrent(agentId, consumedRejectedActionId, null));
  }

  private async handlePerceptionRequested(agentId: string): Promise<void> {
    if (!this.engine.state.getLoggedIn(agentId)) {
      return;
    }

    const suppressionSnapshot = this.captureChoicesPromptSuppressions(agentId);
    let consumedRejectedActionId: string | null = null;
    let consumedUsedItemId: string | null = null;
    await this.sendToAgentBuilt(agentId, () => {
      const perception = this.buildPerceptionTextForAgent(agentId, suppressionSnapshot.usedItemId);
      const choicesPrompt = this.getChoicesPrompt(agentId, { excludeInfoCommands: ['get_perception'] }, suppressionSnapshot);
      consumedRejectedActionId = choicesPrompt.consumedRejectedActionId;
      consumedUsedItemId = perception.consumedUsedItemId;
      return formatPerceptionInfoMessage(this.getWorldContext(agentId), perception.text, this.skillName, choicesPrompt.choicesText);
    }, () => this.clearChoicesPromptSuppressionsIfCurrent(agentId, consumedRejectedActionId, consumedUsedItemId));
  }

  private async handleAvailableActionsRequested(agentId: string): Promise<void> {
    if (!this.engine.state.getLoggedIn(agentId)) {
      return;
    }

    const suppressionSnapshot = this.captureChoicesPromptSuppressions(agentId);
    let consumedRejectedActionId: string | null = null;
    await this.sendToAgentBuilt(agentId, () => {
      // actionsText (詳細形式) は formatActionSourceLine による拡張表示のため、
      // 簡潔な `- action: ...` 形式の choices とは独立して構築する必要がある。
      const rejectedActionId = suppressionSnapshot.rejectedActionId;
      const availableActionSources = getAvailableActionSourcesWithOptions(this.engine, agentId, {
        excluded_action_ids: rejectedActionId ? [rejectedActionId] : [],
      });
      const lines = availableActionSources.map(
        (source) => `- action: ${formatActionSourceLine(source, this.engine.config.items ?? [])}`,
      );
      const actionsText = lines.length > 0 ? `実行可能なアクション:\n${lines.join('\n')}` : '実行可能なアクションはありません。';
      const choicesPrompt = this.getChoicesPrompt(agentId, { excludeInfoCommands: ['get_available_actions'] }, suppressionSnapshot);
      consumedRejectedActionId = choicesPrompt.consumedRejectedActionId;
      return formatAvailableActionsInfoMessage(this.getWorldContext(agentId), actionsText, this.skillName, choicesPrompt.choicesText);
    }, () => this.clearChoicesPromptSuppressionsIfCurrent(agentId, consumedRejectedActionId, null));
  }

  private async handleTransferRequested(event: Extract<WorldEvent, { type: 'transfer_requested' }>): Promise<void> {
    if (event.mode === 'standalone') {
      // sender / receiver どちらかの通知が失敗しても、もう片方は届けたいので個別に try/catch する。
      try {
        await this.sendConversationFollowUp(
          event.from_agent_id,
          formatTransferSentMessage(event.to_agent_name, event.item, event.money),
        );
      } catch (error) {
        this.reportError(`transfer_requested sender 通知の配信に失敗 (transfer_id=${event.transfer_id})`, error);
      }
      try {
        await this.sendConversationFollowUpBuilt(event.to_agent_id, () => formatTransferRequestedMessage(
          this.getWorldContext(event.to_agent_id),
          event.from_agent_name,
          event.item,
          event.money,
          this.skillName,
        ));
      } catch (error) {
        this.reportError(`transfer_requested receiver 通知の配信に失敗 (transfer_id=${event.transfer_id})`, error);
      }
    }
    // in_conversation の場合は会話メッセージ通知に inline 統合されるため、独立通知は送らない
    // (handleConversationMessage 側で受信側 pending_transfer_id を見て本文に追記する)。
    try {
      await this.sendWorldLogForAgent(event.from_agent_id, formatWorldLogTransferRequested(event.to_agent_name));
    } catch (error) {
      this.reportError(`transfer_requested world-log 配信に失敗 (transfer_id=${event.transfer_id})`, error);
    }
  }

  /**
   * standalone モードの譲渡決着後、両者は idle に戻る。次の行動を選べるよう
   * sendToAgentClearingServerAnnouncementBuilt 経由で perception + 選択肢付き prompt を送る。
   * in_conversation モードは会話フローが次ターンを案内するので、現状の info-only 通知を維持。
   */
  private async sendStandaloneTransferSettlementPrompt(
    agentId: string,
    buildPrompt: (perceptionText: string, choicesText: string | undefined) => string,
  ): Promise<void> {
    const suppressionSnapshot = this.captureChoicesPromptSuppressions(agentId);
    let consumedRejectedActionId: string | null = null;
    await this.sendToAgentClearingServerAnnouncementBuilt(agentId, () => {
      const perceptionText = this.getPerceptionText(agentId);
      if (!perceptionText) {
        return null;
      }
      const choicesPrompt = this.getChoicesPrompt(agentId, undefined, suppressionSnapshot);
      consumedRejectedActionId = choicesPrompt.consumedRejectedActionId;
      return buildPrompt(perceptionText, choicesPrompt.choicesText);
    }, () => this.clearChoicesPromptSuppressionsIfCurrent(agentId, consumedRejectedActionId, null));
  }

  private async handleTransferAccepted(event: Extract<WorldEvent, { type: 'transfer_accepted' }>): Promise<void> {
    if (event.mode === 'standalone') {
      try {
        await this.sendStandaloneTransferSettlementPrompt(event.from_agent_id, (perceptionText, choicesText) =>
          formatTransferAcceptedPrompt(this.getWorldContext(event.from_agent_id), event.to_agent_name, event.item, event.money, false, perceptionText, this.skillName, choicesText),
        );
      } catch (error) {
        this.reportError(`transfer_accepted sender 通知の配信に失敗 (transfer_id=${event.transfer_id})`, error);
      }
      try {
        await this.sendStandaloneTransferSettlementPrompt(event.to_agent_id, (perceptionText, choicesText) =>
          formatTransferAcceptedPrompt(this.getWorldContext(event.to_agent_id), event.from_agent_name, event.item, event.money, true, perceptionText, this.skillName, choicesText),
        );
      } catch (error) {
        this.reportError(`transfer_accepted receiver 通知の配信に失敗 (transfer_id=${event.transfer_id})`, error);
      }
    } else if (event.conversation_id) {
      // in_conversation: 独立通知は出さず、送信側 (from_agent_id) の次回 conversation_message
      // 通知本文に「相手が受け取った」旨を inline で添えるため、結果をキャッシュする。
      this.cacheInConversationTransferAnnotation(event.conversation_id, event.from_agent_id, {
        partnerName: event.to_agent_name,
        item: event.item ? { item_id: event.item.item_id, quantity: event.item.quantity } : null,
        money: event.money,
        outcome: 'accepted',
      });
    }
    try {
      await this.sendWorldLogForAgent(event.from_agent_id, formatWorldLogTransferAccepted(event.to_agent_name, false));
    } catch (error) {
      this.reportError(`transfer_accepted world-log 配信に失敗 (transfer_id=${event.transfer_id})`, error);
    }
  }

  private async handleTransferRejected(event: Extract<WorldEvent, { type: 'transfer_rejected' }>): Promise<void> {
    if (event.mode === 'standalone') {
      try {
        await this.sendStandaloneTransferSettlementPrompt(event.from_agent_id, (perceptionText, choicesText) =>
          formatTransferRejectedPrompt(this.getWorldContext(event.from_agent_id), event.to_agent_name, event.reason, false, perceptionText, this.skillName, choicesText),
        );
      } catch (error) {
        this.reportError(`transfer_rejected sender 通知の配信に失敗 (transfer_id=${event.transfer_id})`, error);
      }
      try {
        await this.sendStandaloneTransferSettlementPrompt(event.to_agent_id, (perceptionText, choicesText) =>
          formatTransferRejectedPrompt(this.getWorldContext(event.to_agent_id), event.from_agent_name, event.reason, true, perceptionText, this.skillName, choicesText),
        );
      } catch (error) {
        this.reportError(`transfer_rejected receiver 通知の配信に失敗 (transfer_id=${event.transfer_id})`, error);
      }
    } else if (event.conversation_id) {
      // in_conversation: 結果を送信側にキャッシュ。reason から inline 表現を選ぶ。
      const outcome: InConversationTransferAnnotation['outcome'] =
        event.reason.kind === 'rejected_by_receiver' ? 'rejected_by_receiver'
          : event.reason.kind === 'unanswered_speak' ? 'unanswered_speak'
            : 'inventory_full';
      this.cacheInConversationTransferAnnotation(event.conversation_id, event.from_agent_id, {
        partnerName: event.to_agent_name,
        item: event.item ? { item_id: event.item.item_id, quantity: event.item.quantity } : null,
        money: event.money,
        outcome,
      });
    }
    try {
      await this.sendWorldLogForAgent(event.from_agent_id, formatWorldLogTransferRejected(event.to_agent_name));
    } catch (error) {
      this.reportError(`transfer_rejected world-log 配信に失敗 (transfer_id=${event.transfer_id})`, error);
    }
  }

  private async handleTransferTimeout(event: Extract<WorldEvent, { type: 'transfer_timeout' }>): Promise<void> {
    if (event.mode === 'standalone') {
      try {
        await this.sendStandaloneTransferSettlementPrompt(event.from_agent_id, (perceptionText, choicesText) =>
          formatTransferTimeoutPrompt(this.getWorldContext(event.from_agent_id), event.to_agent_name, false, perceptionText, this.skillName, choicesText),
        );
      } catch (error) {
        this.reportError(`transfer_timeout sender 通知の配信に失敗 (transfer_id=${event.transfer_id})`, error);
      }
      try {
        await this.sendStandaloneTransferSettlementPrompt(event.to_agent_id, (perceptionText, choicesText) =>
          formatTransferTimeoutPrompt(this.getWorldContext(event.to_agent_id), event.from_agent_name, true, perceptionText, this.skillName, choicesText),
        );
      } catch (error) {
        this.reportError(`transfer_timeout receiver 通知の配信に失敗 (transfer_id=${event.transfer_id})`, error);
      }
    } else if (event.conversation_id) {
      // in_conversation: 会話継続中なら次回 conversation_message に inline 添付。
      // 会話が既に終わっているケースはここでは検知できないが、closing 系で別途通知される。
      this.cacheInConversationTransferAnnotation(event.conversation_id, event.from_agent_id, {
        partnerName: event.to_agent_name,
        item: event.item ? { item_id: event.item.item_id, quantity: event.item.quantity } : null,
        money: event.money,
        outcome: 'timeout',
      });
    }
    try {
      await this.sendWorldLogForAgent(event.from_agent_id, formatWorldLogTransferTimeout(event.to_agent_name));
    } catch (error) {
      this.reportError(`transfer_timeout world-log 配信に失敗 (transfer_id=${event.transfer_id})`, error);
    }
  }

  private async handleTransferCancelled(event: Extract<WorldEvent, { type: 'transfer_cancelled' }>): Promise<void> {
    if (event.mode === 'standalone') {
      try {
        await this.sendStandaloneTransferSettlementPrompt(event.from_agent_id, (perceptionText, choicesText) =>
          formatTransferCancelledPrompt(this.getWorldContext(event.from_agent_id), event.to_agent_name, event.reason, false, perceptionText, this.skillName, choicesText),
        );
      } catch (error) {
        this.reportError(`transfer_cancelled sender 通知の配信に失敗 (transfer_id=${event.transfer_id})`, error);
      }
      try {
        await this.sendStandaloneTransferSettlementPrompt(event.to_agent_id, (perceptionText, choicesText) =>
          formatTransferCancelledPrompt(this.getWorldContext(event.to_agent_id), event.from_agent_name, event.reason, true, perceptionText, this.skillName, choicesText),
        );
      } catch (error) {
        this.reportError(`transfer_cancelled receiver 通知の配信に失敗 (transfer_id=${event.transfer_id})`, error);
      }
    } else if (event.conversation_id) {
      // in_conversation の cancel は会話終了処理に伴う発火が多い。会話継続中なら次の
      // conversation_message 通知本文に inline 表示される。会話が既に終了している場合は
      // キャッシュは消費されず数分後に Map から消去されないが、通常は短命なので許容。
      const annotation: InConversationTransferAnnotation = {
        partnerName: '',
        item: event.item ? { item_id: event.item.item_id, quantity: event.item.quantity } : null,
        money: event.money,
        outcome: 'timeout', // cancel/timeout 共通の「自動キャンセル」表現を流用
      };
      this.cacheInConversationTransferAnnotation(event.conversation_id, event.from_agent_id, {
        ...annotation,
        partnerName: event.to_agent_name,
      });
      this.cacheInConversationTransferAnnotation(event.conversation_id, event.to_agent_id, {
        ...annotation,
        partnerName: event.from_agent_name,
      });
    }
    try {
      await this.sendWorldLogForAgent(event.from_agent_id, formatWorldLogTransferCancelled(event.to_agent_name));
    } catch (error) {
      this.reportError(`transfer_cancelled world-log 配信に失敗 (transfer_id=${event.transfer_id})`, error);
    }
  }

  private async handleTransferEscrowLost(event: Extract<WorldEvent, { type: 'transfer_escrow_lost' }>): Promise<void> {
    try {
      await this.sendConversationFollowUp(event.from_agent_id, formatTransferEscrowLostMessage(event.to_agent_name));
    } catch (error) {
      this.reportError(`transfer_escrow_lost sender 通知の配信に失敗 (transfer_id=${event.transfer_id})`, error);
    }
    try {
      await this.sendWorldLogForAgent(event.from_agent_id, formatWorldLogTransferEscrowLost(event.to_agent_name));
    } catch (error) {
      this.reportError(`transfer_escrow_lost world-log 配信に失敗 (transfer_id=${event.transfer_id})`, error);
    }
  }

  /**
   * in_conversation transfer 決着の結果を、相手側 (受け手) に伝えるための一時キャッシュ書き込み。
   * 次に当該会話で recipientAgentId を listener とする conversation_message 通知が組み立てられた
   * タイミングで本文に inline で添えられる。
   */
  private cacheInConversationTransferAnnotation(
    conversationId: string,
    recipientAgentId: string,
    annotation: InConversationTransferAnnotation,
  ): void {
    const key = `${conversationId}:${recipientAgentId}`;
    this.inConversationTransferAnnotations.set(key, annotation);
  }

  private consumeInConversationTransferAnnotation(
    conversationId: string,
    recipientAgentId: string,
  ): InConversationTransferAnnotation | undefined {
    const key = `${conversationId}:${recipientAgentId}`;
    const annotation = this.inConversationTransferAnnotations.get(key);
    if (annotation !== undefined) {
      this.inConversationTransferAnnotations.delete(key);
    }
    return annotation;
  }

  /**
   * recipientAgentId に届いている pending な in_conversation transfer offer を引く。
   * conversation_id が一致するものだけ返す。
   */
  private resolveInConversationPendingOffer(
    conversationId: string,
    recipientAgentId: string,
  ): { fromName: string; item: { item_id: string; quantity: number } | null; money: number } | null {
    const recipient = this.engine.state.getLoggedIn(recipientAgentId);
    if (!recipient || !recipient.pending_transfer_id) {
      return null;
    }
    const offer = this.engine.state.transfers.get(recipient.pending_transfer_id);
    if (!offer || offer.mode !== 'in_conversation' || offer.conversation_id !== conversationId) {
      return null;
    }
    if (offer.status !== 'open') {
      return null;
    }
    return {
      fromName: this.engine.getAgentById(offer.from_agent_id)?.agent_name ?? offer.from_agent_id,
      item: offer.item ? { item_id: offer.item.item_id, quantity: offer.item.quantity } : null,
      money: offer.money,
    };
  }

  /**
   * 会話 reply プロンプトに乗せる「同梱可能な transfer のヒント」を組み立てる。
   * 所持アイテムの item_id を集約し、所持金の有無も併せて返す。空なら transfer? は出さない。
   */
  private getTransferOptionsHint(agentId: string): TransferOptionsHint {
    const agent = this.engine.state.getLoggedIn(agentId);
    if (!agent) {
      return { item_ids: [], has_money: false };
    }
    const item_ids = [...new Set(agent.items.filter((entry) => entry.quantity > 0).map((entry) => entry.item_id))]
      .sort((left, right) => left.localeCompare(right));
    return { item_ids, has_money: agent.money > 0 };
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
    await this.sendToAgentBuilt(agentId, () => content);
  }

  private async sendToAgentClearingServerAnnouncement(agentId: string, content: string): Promise<void> {
    await this.sendToAgentClearingServerAnnouncementBuilt(agentId, () => content);
  }

  private async sendToAgentBuilt(
    agentId: string,
    buildContent: () => string | null,
    onDelivered?: () => void,
  ): Promise<void> {
    await this.enqueueAgentMessageDelivery(agentId, async () => {
      const content = buildContent();
      if (!content) {
        return;
      }

      await this.sendToAgentNow(agentId, content);
      onDelivered?.();
    });
  }

  private async sendToAgentClearingServerAnnouncementBuilt(
    agentId: string,
    buildContent: () => string | null,
    onDelivered?: () => void,
  ): Promise<void> {
    await this.enqueueAgentMessageDelivery(agentId, async () => {
      const content = buildContent();
      if (!content) {
        return;
      }

      try {
        await this.sendToAgentNow(agentId, content);
        onDelivered?.();
      } finally {
        clearActiveServerAnnouncement(this.engine, agentId);
      }
    });
  }

  private async sendConversationRejectedNotification(
    agentId: string,
    counterpartName: string,
    reason: ConversationRejectionReason,
  ): Promise<void> {
    const suppressionSnapshot = this.captureChoicesPromptSuppressions(agentId);
    let consumedRejectedActionId: string | null = null;
    await this.sendConversationFollowUpBuilt(
      agentId,
      () => {
        const perceptionText = this.getPerceptionText(agentId);
        if (!perceptionText) {
          return null;
        }

        const choicesPrompt = this.getChoicesPrompt(agentId, undefined, suppressionSnapshot);
        consumedRejectedActionId = choicesPrompt.consumedRejectedActionId;
        return formatConversationRejectedMessage(
          this.getWorldContext(agentId),
          counterpartName,
          reason,
          perceptionText,
          this.skillName,
          choicesPrompt.choicesText,
        );
      },
      () => this.clearChoicesPromptSuppressionsIfCurrent(agentId, consumedRejectedActionId, null),
    );
  }

  private async sendConversationFollowUp(agentId: string, content: string): Promise<void> {
    await this.sendConversationFollowUpBuilt(agentId, () => content);
  }

  private async sendConversationFollowUpBuilt(
    agentId: string,
    buildContent: () => string | null,
    onDelivered?: () => void,
  ): Promise<void> {
    if (this.engine.state.getLoggedIn(agentId)?.active_server_announcement_id != null) {
      await this.sendToAgentClearingServerAnnouncementBuilt(agentId, buildContent, onDelivered);
      return;
    }

    await this.sendToAgentBuilt(agentId, buildContent, onDelivered);
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
