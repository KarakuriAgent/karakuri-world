import { findConversationByAgent } from '../domain/conversation.js';
import { buildPerceptionText } from '../domain/perception.js';
import type { WorldEngine } from '../engine/world-engine.js';
import type { NodeId } from '../types/data-model.js';
import type { WorldEvent } from '../types/event.js';
import type { ConversationIntervalTimer, IdleReminderTimer } from '../types/timer.js';
import type { DiscordNotificationAdapter } from './bot.js';
import {
  formatActionCompletedMessage,
  formatAgentJoinedMessage,
  formatAgentLeftMessage,
  formatConversationAcceptedMessage,
  formatConversationClosingPromptMessage,
  formatConversationDeliveredClosingMessage,
  formatConversationEndedMessage,
  formatConversationForcedEndedMessage,
  formatConversationRejectedMessage,
  formatConversationReplyPromptMessage,
  formatConversationRequestedMessage,
  formatConversationServerEventClosingPromptMessage,
  formatIdleReminderMessage,
  formatMovementCompletedMessage,
  formatServerEventMessage,
  formatServerEventSelectedMessage,
  formatWaitCompletedMessage,
  formatWorldLogAction,
  formatWorldLogActionStarted,
  formatWorldLogConversationMessage,
  formatWorldLogConversationEnded,
  formatWorldLogMovementStarted,
  formatWorldLogWaitStarted,
  formatWorldLogConversationStarted,
  formatWorldLogJoined,
  formatWorldLogLeft,
  formatWorldLogMovement,
  formatWorldLogServerEvent,
  formatWorldLogWait,
} from './notification.js';

interface PendingForcedConversationEnd {
  initiator_agent_id: string;
  target_agent_id: string;
}

export class DiscordEventHandler {
  private unsubscribe: (() => void) | null = null;
  private readonly pendingForcedConversationEnds = new Map<string, PendingForcedConversationEnd>();
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
      });
    });
    const disposeConversationIntervalSubscription = this.engine.timerManager.onFire('conversation_interval', (timer) => {
      void this.handleConversationInterval(timer).catch((error) => {
        console.error('Failed to dispatch Discord notification.', error);
      });
    });
    const disposeIdleReminderSubscription = this.engine.timerManager.onFire('idle_reminder', (timer) => {
      void this.handleIdleReminder(timer).catch((error) => {
        console.error('Failed to dispatch Discord notification.', error);
      });
    });
    this.unsubscribe = () => {
      disposeEventSubscription();
      disposeConversationIntervalSubscription();
      disposeIdleReminderSubscription();
      this.unsubscribe = null;
      this.pendingForcedConversationEnds.clear();
    };

    return this.unsubscribe;
  }

  dispose(): void {
    this.unsubscribe?.();
  }

  private async handleEvent(event: WorldEvent): Promise<void> {
    switch (event.type) {
      case 'agent_joined':
        await this.handleAgentJoined(event.agent_id, event.agent_name, event.node_id);
        return;
      case 'agent_left':
        await this.handleAgentLeft(event);
        return;
      case 'movement_completed':
        await this.handleMovementCompleted(event.agent_id, event.agent_name, event.node_id);
        return;
      case 'action_completed':
        await this.handleActionCompleted(event.agent_id, event.agent_name, event.action_name, event.result_description);
        return;
      case 'wait_completed':
        await this.handleWaitCompleted(event.agent_id, event.agent_name, event.duration_ms);
        return;
      case 'wait_started':
        await this.handleWaitStarted(event.agent_name, event.duration_ms);
        return;
      case 'conversation_requested':
        await this.handleConversationRequested(
          event.target_agent_id,
          this.getAgentName(event.initiator_agent_id),
          event.message,
          event.conversation_id,
        );
        return;
      case 'conversation_accepted':
        await this.handleConversationAccepted(
          event.initiator_agent_id,
          this.getAgentName(event.target_agent_id),
          this.getAgentName(event.initiator_agent_id),
          this.getAgentName(event.target_agent_id),
          event.conversation_id,
        );
        return;
      case 'conversation_rejected':
        await this.handleConversationRejected(
          event.initiator_agent_id,
          this.getAgentName(event.target_agent_id),
          event.reason,
        );
        return;
      case 'conversation_message':
        await this.bot.sendWorldLog(
          formatWorldLogConversationMessage(this.getAgentName(event.speaker_agent_id), event.message),
        );
        return;
      case 'conversation_ended':
        await this.handleConversationEnded(event);
        return;
      case 'server_event_fired':
        await this.handleServerEventFired(event);
        return;
      case 'server_event_selected':
        await this.handleServerEventSelected(event);
        return;
      case 'movement_started':
        await this.handleMovementStarted(event.agent_name, event.to_node_id);
        return;
      case 'action_started':
        await this.handleActionStarted(event.agent_name, event.action_name);
        return;
    }
  }

  private async handleIdleReminder(timer: IdleReminderTimer): Promise<void> {
    const agent = this.engine.state.getJoined(timer.agent_id);
    if (!agent || agent.pending_conversation_id) {
      return;
    }

    const perceptionText = this.getPerceptionText(timer.agent_id);
    if (!perceptionText) {
      return;
    }

    const elapsedMs = Date.now() - timer.idle_since;
    await this.sendToAgent(timer.agent_id, formatIdleReminderMessage(elapsedMs, perceptionText, this.skillName));
  }

  private async handleConversationInterval(timer: ConversationIntervalTimer): Promise<void> {
    const conversation = this.engine.state.conversations.get(timer.conversation_id);
    if (!conversation) {
      return;
    }

    await this.handleConversationMessage(
      timer.listener_agent_id,
      this.getAgentName(timer.speaker_agent_id),
      timer.message,
      timer.conversation_id,
      conversation.status === 'closing',
    );
  }

  private async handleAgentJoined(agentId: string, agentName: string, _nodeId: NodeId): Promise<void> {
    const perceptionText = this.getPerceptionText(agentId);
    if (perceptionText) {
      await this.sendToAgent(agentId, formatAgentJoinedMessage(perceptionText, this.skillName));
    }

    await this.bot.sendWorldLog(formatWorldLogJoined(agentName));
  }

  private async handleAgentLeft(event: Extract<WorldEvent, { type: 'agent_left' }>): Promise<void> {
    try {
      const agentMessage = formatAgentLeftMessage(event.cancelled_state, event.cancelled_action_name);
      await this.bot.sendAgentMessage(event.discord_channel_id, agentMessage);
    } catch (error) {
      console.error('Failed to send leave notification to agent channel.', error);
    }

    for (const partnerId of this.consumeForcedConversationPartners(event.agent_id)) {
      const perceptionText = this.getPerceptionText(partnerId);
      if (perceptionText) {
        await this.sendToAgent(partnerId, formatConversationForcedEndedMessage(event.agent_name, perceptionText, this.skillName));
      }
    }

    await this.bot.sendWorldLog(formatWorldLogLeft(event.agent_name, event.cancelled_state, event.cancelled_action_name));
  }

  private async handleMovementStarted(agentName: string, toNodeId: NodeId): Promise<void> {
    const label = this.engine.getMap().nodes[toNodeId]?.label;
    await this.bot.sendWorldLog(formatWorldLogMovementStarted(agentName, toNodeId, label));
  }

  private async handleMovementCompleted(agentId: string, agentName: string, toNodeId: NodeId): Promise<void> {
    const perceptionText = this.getPerceptionText(agentId);
    if (perceptionText) {
      const label = this.engine.getMap().nodes[toNodeId]?.label;
      await this.sendToAgent(agentId, formatMovementCompletedMessage(toNodeId, label, perceptionText, this.skillName));
      await this.bot.sendWorldLog(formatWorldLogMovement(agentName, toNodeId, label));
    }
  }

  private async handleActionStarted(agentName: string, actionName: string): Promise<void> {
    await this.bot.sendWorldLog(formatWorldLogActionStarted(agentName, actionName));
  }

  private async handleActionCompleted(
    agentId: string,
    agentName: string,
    actionName: string,
    resultDescription: string,
  ): Promise<void> {
    const perceptionText = this.getPerceptionText(agentId);
    if (perceptionText) {
      await this.sendToAgent(agentId, formatActionCompletedMessage(actionName, resultDescription, perceptionText, this.skillName));
    }

    await this.bot.sendWorldLog(formatWorldLogAction(agentName, actionName));
  }

  private async handleWaitStarted(agentName: string, durationMs: number): Promise<void> {
    await this.bot.sendWorldLog(formatWorldLogWaitStarted(agentName, durationMs));
  }

  private async handleWaitCompleted(agentId: string, agentName: string, durationMs: number): Promise<void> {
    const perceptionText = this.getPerceptionText(agentId);
    if (perceptionText) {
      await this.sendToAgent(agentId, formatWaitCompletedMessage(durationMs, perceptionText, this.skillName));
    }

    await this.bot.sendWorldLog(formatWorldLogWait(agentName, durationMs));
  }

  private async handleConversationRequested(
    targetAgentId: string,
    initiatorName: string,
    initialMessage: string,
    conversationId: string,
  ): Promise<void> {
    await this.sendToAgent(
      targetAgentId,
      formatConversationRequestedMessage(initiatorName, initialMessage, conversationId),
    );
  }

  private async handleConversationAccepted(
    initiatorAgentId: string,
    targetName: string,
    initiatorName: string,
    logTargetName: string,
    conversationId: string,
  ): Promise<void> {
    await this.sendToAgent(initiatorAgentId, formatConversationAcceptedMessage(targetName));
    await this.bot.sendWorldLog(formatWorldLogConversationStarted(initiatorName, logTargetName));

    const conversation = this.engine.state.conversations.get(conversationId);
    if (conversation) {
      await this.bot.sendWorldLog(
        formatWorldLogConversationMessage(initiatorName, conversation.initial_message),
      );
    }
  }

  private async handleConversationRejected(
    initiatorAgentId: string,
    targetName: string,
    reason: 'rejected' | 'timeout' | 'target_left',
  ): Promise<void> {
    const perceptionText = this.getPerceptionText(initiatorAgentId);
    if (!perceptionText) {
      return;
    }

    await this.sendToAgent(initiatorAgentId, formatConversationRejectedMessage(targetName, reason, perceptionText, this.skillName));
  }

  private async handleConversationMessage(
    listenerAgentId: string,
    speakerName: string,
    message: string,
    conversationId: string,
    closing: boolean,
  ): Promise<void> {
    const content = closing
      ? formatConversationClosingPromptMessage(speakerName, message, conversationId)
      : formatConversationReplyPromptMessage(speakerName, message, conversationId);

    await this.sendToAgent(listenerAgentId, content);
  }

  private async handleConversationEnded(event: Extract<WorldEvent, { type: 'conversation_ended' }>): Promise<void> {
    if (event.reason === 'partner_left') {
      this.pendingForcedConversationEnds.set(event.conversation_id, {
        initiator_agent_id: event.initiator_agent_id,
        target_agent_id: event.target_agent_id,
      });
      return;
    }

    if (event.final_message && event.final_speaker_agent_id) {
      const listenerAgentId =
        event.final_speaker_agent_id === event.initiator_agent_id ? event.target_agent_id : event.initiator_agent_id;
      await this.sendToAgent(
        listenerAgentId,
        formatConversationDeliveredClosingMessage(this.getAgentName(event.final_speaker_agent_id), event.final_message),
      );
    }

    for (const participantId of [event.initiator_agent_id, event.target_agent_id]) {
      const perceptionText = this.getPerceptionText(participantId);
      if (!perceptionText) {
        continue;
      }

      await this.sendToAgent(participantId, formatConversationEndedMessage(event.reason, perceptionText, this.skillName));
    }

    await this.bot.sendWorldLog(
      formatWorldLogConversationEnded(this.getAgentName(event.initiator_agent_id), this.getAgentName(event.target_agent_id)),
    );
  }

  private async handleServerEventFired(event: Extract<WorldEvent, { type: 'server_event_fired' }>): Promise<void> {
    const content = formatServerEventMessage(event.name, event.description, event.choices, event.server_event_id);
    for (const agentId of event.delivered_agent_ids) {
      await this.sendToAgent(agentId, content);
    }

    if (!event.delayed) {
      await this.bot.sendWorldLog(formatWorldLogServerEvent(event.name, event.description));
    }
  }

  private async handleServerEventSelected(event: Extract<WorldEvent, { type: 'server_event_selected' }>): Promise<void> {
    if (event.source_state === 'in_action') {
      const perceptionText = this.getPerceptionText(event.agent_id);
      if (perceptionText) {
        await this.sendToAgent(
          event.agent_id,
          formatServerEventSelectedMessage(event.name, event.choice_label, perceptionText, this.skillName),
        );
      }
      return;
    }

    if (event.source_state === 'in_conversation') {
      const conversation = findConversationByAgent(this.engine, event.agent_id, ['closing']);
      if (conversation) {
        await this.sendToAgent(
          event.agent_id,
          formatConversationServerEventClosingPromptMessage(event.name, conversation.conversation_id),
        );
      }
    }
  }

  private getPerceptionText(agentId: string): string {
    const joinedAgent = this.engine.state.getJoined(agentId);
    if (!joinedAgent) {
      return '';
    }

    return buildPerceptionText(this.engine.getPerception(agentId));
  }

  private getAgentName(agentId: string): string {
    return this.engine.getAgentById(agentId)?.agent_name ?? agentId;
  }

  private async sendToAgent(agentId: string, content: string): Promise<void> {
    const joinedAgent = this.engine.state.getJoined(agentId);
    if (!joinedAgent) {
      return;
    }

    await this.bot.sendAgentMessage(joinedAgent.discord_channel_id, content);
  }

  private consumeForcedConversationPartners(agentId: string): string[] {
    const partnerIds: string[] = [];

    for (const [conversationId, pending] of this.pendingForcedConversationEnds.entries()) {
      if (pending.initiator_agent_id === agentId) {
        partnerIds.push(pending.target_agent_id);
        this.pendingForcedConversationEnds.delete(conversationId);
      } else if (pending.target_agent_id === agentId) {
        partnerIds.push(pending.initiator_agent_id);
        this.pendingForcedConversationEnds.delete(conversationId);
      }
    }

    return partnerIds;
  }
}
