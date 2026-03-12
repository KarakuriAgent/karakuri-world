import { findConversationByAgent } from '../domain/conversation.js';
import { buildPerceptionText } from '../domain/perception.js';
import type { WorldEngine } from '../engine/world-engine.js';
import type { NodeId } from '../types/data-model.js';
import type { WorldEvent } from '../types/event.js';
import type { ConversationIntervalTimer } from '../types/timer.js';
import type { DiscordNotificationAdapter } from './bot.js';
import {
  formatActionCompletedMessage,
  formatAgentJoinedMessage,
  formatConversationAcceptedMessage,
  formatConversationClosingPromptMessage,
  formatConversationDeliveredClosingMessage,
  formatConversationEndedMessage,
  formatConversationForcedEndedMessage,
  formatConversationRejectedMessage,
  formatConversationReplyPromptMessage,
  formatConversationRequestedMessage,
  formatConversationServerEventClosingPromptMessage,
  formatMovementCompletedMessage,
  formatServerEventMessage,
  formatServerEventSelectedMessage,
  formatWorldLogAction,
  formatWorldLogConversationEnded,
  formatWorldLogConversationStarted,
  formatWorldLogJoined,
  formatWorldLogLeft,
  formatWorldLogMovement,
  formatWorldLogServerEvent,
} from './notification.js';

interface PendingForcedConversationEnd {
  initiator_agent_id: string;
  target_agent_id: string;
}

export class DiscordEventHandler {
  private unsubscribe: (() => void) | null = null;
  private readonly pendingForcedConversationEnds = new Map<string, PendingForcedConversationEnd>();

  constructor(
    private readonly engine: WorldEngine,
    private readonly bot: DiscordNotificationAdapter,
  ) {}

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
    this.unsubscribe = () => {
      disposeEventSubscription();
      disposeConversationIntervalSubscription();
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
        await this.handleAgentLeft(event.agent_id, event.agent_name);
        return;
      case 'movement_completed':
        await this.handleMovementCompleted(event.agent_id, event.agent_name, event.to_node_id);
        return;
      case 'action_completed':
        await this.handleActionCompleted(event.agent_id, event.agent_name, event.action_name, event.result_description);
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
      case 'action_started':
        return;
    }
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
      await this.sendToAgent(agentId, formatAgentJoinedMessage(perceptionText));
    }

    await this.bot.sendWorldLog(formatWorldLogJoined(agentName));
  }

  private async handleAgentLeft(agentId: string, agentName: string): Promise<void> {
    for (const partnerId of this.consumeForcedConversationPartners(agentId)) {
      const perceptionText = this.getPerceptionText(partnerId);
      if (perceptionText) {
        await this.sendToAgent(partnerId, formatConversationForcedEndedMessage(agentName, perceptionText));
      }
    }

    await this.bot.sendWorldLog(formatWorldLogLeft(agentName));
  }

  private async handleMovementCompleted(agentId: string, agentName: string, toNodeId: NodeId): Promise<void> {
    const perceptionText = this.getPerceptionText(agentId);
    if (perceptionText) {
      const label = this.engine.getMap().nodes[toNodeId]?.label;
      await this.sendToAgent(agentId, formatMovementCompletedMessage(toNodeId, label, perceptionText));
      await this.bot.sendWorldLog(formatWorldLogMovement(agentName, toNodeId, label));
    }
  }

  private async handleActionCompleted(
    agentId: string,
    agentName: string,
    actionName: string,
    resultDescription: string,
  ): Promise<void> {
    const perceptionText = this.getPerceptionText(agentId);
    if (perceptionText) {
      await this.sendToAgent(agentId, formatActionCompletedMessage(actionName, resultDescription, perceptionText));
    }

    await this.bot.sendWorldLog(formatWorldLogAction(agentName, actionName));
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
  ): Promise<void> {
    await this.sendToAgent(initiatorAgentId, formatConversationAcceptedMessage(targetName));
    await this.bot.sendWorldLog(formatWorldLogConversationStarted(initiatorName, logTargetName));
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

    await this.sendToAgent(initiatorAgentId, formatConversationRejectedMessage(targetName, reason, perceptionText));
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

      await this.sendToAgent(participantId, formatConversationEndedMessage(event.reason, perceptionText));
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
          formatServerEventSelectedMessage(event.name, event.choice_label, perceptionText),
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
    if (!joinedAgent?.discord_channel_id) {
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
