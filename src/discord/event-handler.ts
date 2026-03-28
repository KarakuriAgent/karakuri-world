import { formatActionSourceLine, getAvailableActionSources } from '../domain/actions.js';
import { buildChoicesText } from '../domain/choices.js';
import { findConversationByAgent } from '../domain/conversation.js';
import { buildMapSummaryText } from '../domain/map-summary.js';
import { buildPerceptionText } from '../domain/perception.js';
import type { WorldEngine } from '../engine/world-engine.js';
import { WorldError } from '../types/api.js';
import type { NodeId } from '../types/data-model.js';
import type { WorldEvent } from '../types/event.js';
import type { ConversationIntervalTimer, IdleReminderTimer } from '../types/timer.js';
import type { DiscordNotificationAdapter } from './bot.js';
import {
  formatActionCompletedMessage,
  formatAvailableActionsInfoMessage,
  formatAgentLoggedInMessage,
  formatAgentLoggedOutMessage,
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
  formatMapInfoMessage,
  formatMovementCompletedMessage,
  formatPerceptionInfoMessage,
  formatServerEventMessage,
  formatServerEventSelectedMessage,
  formatWaitCompletedMessage,
  formatWorldAgentsInfoMessage,
  formatWorldLogAction,
  formatWorldLogActionStarted,
  formatWorldLogConversationMessage,
  formatWorldLogConversationEnded,
  formatWorldLogMovementStarted,
  formatWorldLogWaitStarted,
  formatWorldLogConversationStarted,
  formatWorldLogLoggedIn,
  formatWorldLogLoggedOut,
  formatWorldLogMovement,
  formatWorldLogServerEvent,
  formatWorldLogWait,
  type WorldContext,
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
    private readonly timezone: string = 'Asia/Tokyo',
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
        await this.handleActionCompleted(event.agent_id, event.agent_name, event.action_name, event.result_description);
        return;
      case 'wait_completed':
        await this.handleWaitCompleted(event.agent_id, event.agent_name, event.duration_ms);
        return;
      case 'wait_started':
        await this.handleWaitStarted(event.agent_name, event.duration_ms, event.completes_at);
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
        await this.handleMovementStarted(event.agent_name, event.to_node_id, event.arrives_at);
        return;
      case 'action_started':
        await this.handleActionStarted(event.agent_name, event.action_name, event.completes_at);
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
    await this.sendToAgent(
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
    await this.handleConversationMessage(
      timer.listener_agent_id,
      this.getAgentName(timer.speaker_agent_id),
      timer.message,
      closing,
    );
  }

  private async handleAgentLoggedIn(agentId: string, agentName: string, _nodeId: NodeId): Promise<void> {
    const perceptionText = this.getPerceptionText(agentId);
    if (perceptionText) {
      const choicesText = this.getChoicesText(agentId);
      await this.sendToAgent(
        agentId,
        formatAgentLoggedInMessage(this.getWorldContext(agentId), perceptionText, this.skillName, choicesText),
      );
    }

    await this.bot.sendWorldLog(formatWorldLogLoggedIn(agentName));
  }

  private async handleAgentLoggedOut(event: Extract<WorldEvent, { type: 'agent_logged_out' }>): Promise<void> {
    try {
      const agentMessage = formatAgentLoggedOutMessage(event.cancelled_state, event.cancelled_action_name);
      await this.bot.sendAgentMessage(event.discord_channel_id, agentMessage);
    } catch (error) {
      console.error('Failed to send logout notification to agent channel.', error);
    }

    for (const partnerId of this.consumeForcedConversationPartners(event.agent_id)) {
      const perceptionText = this.getPerceptionText(partnerId);
      if (perceptionText) {
        const choicesText = this.getChoicesText(partnerId);
        await this.sendToAgent(
          partnerId,
          formatConversationForcedEndedMessage(
            this.getWorldContext(partnerId),
            event.agent_name,
            perceptionText,
            this.skillName,
            choicesText,
          ),
        );
      }
    }

    await this.bot.sendWorldLog(formatWorldLogLoggedOut(event.agent_name, event.cancelled_state, event.cancelled_action_name));
  }

  private async handleMovementStarted(agentName: string, toNodeId: NodeId, arrivesAt: number): Promise<void> {
    const label = this.engine.getMap().nodes[toNodeId]?.label;
    await this.bot.sendWorldLog(formatWorldLogMovementStarted(agentName, toNodeId, arrivesAt, this.timezone, label));
  }

  private async handleMovementCompleted(agentId: string, agentName: string, toNodeId: NodeId): Promise<void> {
    const perceptionText = this.getPerceptionText(agentId);
    if (perceptionText) {
      const label = this.engine.getMap().nodes[toNodeId]?.label;
      const choicesText = this.getChoicesText(agentId);
      await this.sendToAgent(
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
      await this.bot.sendWorldLog(formatWorldLogMovement(agentName, toNodeId, label));
    }
  }

  private async handleActionStarted(agentName: string, actionName: string, completesAt: number): Promise<void> {
    await this.bot.sendWorldLog(formatWorldLogActionStarted(agentName, actionName, completesAt, this.timezone));
  }

  private async handleActionCompleted(
    agentId: string,
    agentName: string,
    actionName: string,
    resultDescription: string,
  ): Promise<void> {
    const perceptionText = this.getPerceptionText(agentId);
    if (perceptionText) {
      const choicesText = this.getChoicesText(agentId);
      await this.sendToAgent(
        agentId,
        formatActionCompletedMessage(
          this.getWorldContext(agentId),
          actionName,
          resultDescription,
          perceptionText,
          this.skillName,
          choicesText,
        ),
      );
    }

    await this.bot.sendWorldLog(formatWorldLogAction(agentName, actionName));
  }

  private async handleWaitStarted(agentName: string, durationMs: number, completesAt: number): Promise<void> {
    await this.bot.sendWorldLog(formatWorldLogWaitStarted(agentName, durationMs, completesAt, this.timezone));
  }

  private async handleWaitCompleted(agentId: string, agentName: string, durationMs: number): Promise<void> {
    const perceptionText = this.getPerceptionText(agentId);
    if (perceptionText) {
      const choicesText = this.getChoicesText(agentId);
      await this.sendToAgent(
        agentId,
        formatWaitCompletedMessage(this.getWorldContext(agentId), durationMs, perceptionText, this.skillName, choicesText),
      );
    }

    await this.bot.sendWorldLog(formatWorldLogWait(agentName, durationMs));
  }

  private async handleConversationRequested(
    targetAgentId: string,
    initiatorName: string,
    initialMessage: string,
  ): Promise<void> {
    await this.sendToAgent(
      targetAgentId,
      formatConversationRequestedMessage(
        this.getWorldContext(targetAgentId),
        initiatorName,
        initialMessage,
        this.skillName,
      ),
    );
  }

  private async handleConversationAccepted(
    initiatorAgentId: string,
    targetName: string,
    initiatorName: string,
    logTargetName: string,
  ): Promise<void> {
    await this.bot.sendWorldLog(formatWorldLogConversationStarted(initiatorName, logTargetName));
    await this.sendToAgent(initiatorAgentId, formatConversationAcceptedMessage(targetName));
  }

  private async handleConversationRejected(
    initiatorAgentId: string,
    targetName: string,
    reason: 'rejected' | 'timeout' | 'target_logged_out',
  ): Promise<void> {
    const perceptionText = this.getPerceptionText(initiatorAgentId);
    if (!perceptionText) {
      return;
    }

    const choicesText = this.getChoicesText(initiatorAgentId);
    await this.sendToAgent(
      initiatorAgentId,
      formatConversationRejectedMessage(
        this.getWorldContext(initiatorAgentId),
        targetName,
        reason,
        perceptionText,
        this.skillName,
        choicesText,
      ),
    );
  }

  private async handleConversationMessage(
    listenerAgentId: string,
    speakerName: string,
    message: string,
    closing: boolean,
  ): Promise<void> {
    const content = closing
      ? formatConversationClosingPromptMessage(
          this.getWorldContext(listenerAgentId),
          speakerName,
          message,
          this.skillName,
        )
      : formatConversationReplyPromptMessage(
          this.getWorldContext(listenerAgentId),
          speakerName,
          message,
          this.skillName,
        );

    await this.sendToAgent(listenerAgentId, content);
  }

  private async handleConversationEnded(event: Extract<WorldEvent, { type: 'conversation_ended' }>): Promise<void> {
    if (event.reason === 'partner_logged_out') {
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

      const choicesText = this.getChoicesText(participantId);
      await this.sendToAgent(
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

    await this.bot.sendWorldLog(
      formatWorldLogConversationEnded(this.getAgentName(event.initiator_agent_id), this.getAgentName(event.target_agent_id)),
    );
  }

  private async handleServerEventFired(event: Extract<WorldEvent, { type: 'server_event_fired' }>): Promise<void> {
    for (const agentId of event.delivered_agent_ids) {
      const content = formatServerEventMessage(
        this.getWorldContext(agentId),
        event.name,
        event.description,
        event.choices,
        event.server_event_id,
        this.skillName,
      );
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
        const choicesText = this.getChoicesText(event.agent_id);
        await this.sendToAgent(
          event.agent_id,
          formatServerEventSelectedMessage(
            this.getWorldContext(event.agent_id),
            event.name,
            event.choice_label,
            perceptionText,
            this.skillName,
            choicesText,
          ),
        );
      }
      return;
    }

    if (event.source_state === 'in_conversation') {
      const conversation = findConversationByAgent(this.engine, event.agent_id, ['closing']);
      if (conversation) {
        await this.sendToAgent(
          event.agent_id,
          formatConversationServerEventClosingPromptMessage(
            this.getWorldContext(event.agent_id),
            event.name,
            this.skillName,
          ),
        );
      }
    }
  }

  private getPerceptionText(agentId: string): string {
    const loggedInAgent = this.engine.state.getLoggedIn(agentId);
    if (!loggedInAgent) {
      return '';
    }

    return buildPerceptionText(this.engine.getPerception(agentId));
  }

  private getChoicesText(agentId: string): string {
    try {
      return buildChoicesText(this.engine, agentId);
    } catch (error) {
      if (!(error instanceof WorldError)) {
        console.error(`Failed to build choices text for agent ${agentId}.`, error);
      }
      return '';
    }
  }

  private async handleMapInfoRequested(agentId: string): Promise<void> {
    const choicesText = this.getChoicesText(agentId);
    await this.sendToAgent(
      agentId,
      formatMapInfoMessage(this.getWorldContext(agentId), buildMapSummaryText(this.engine.config.map), this.skillName, choicesText),
    );
  }

  private async handleWorldAgentsInfoRequested(agentId: string): Promise<void> {
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
    await this.sendToAgent(agentId, formatWorldAgentsInfoMessage(this.getWorldContext(agentId), agentsText, this.skillName, choicesText));
  }

  private async handlePerceptionRequested(agentId: string): Promise<void> {
    const perceptionText = this.getPerceptionText(agentId);
    if (!perceptionText) {
      return;
    }

    const choicesText = this.getChoicesText(agentId);
    await this.sendToAgent(
      agentId,
      formatPerceptionInfoMessage(this.getWorldContext(agentId), perceptionText, choicesText, this.skillName),
    );
  }

  private async handleAvailableActionsRequested(agentId: string): Promise<void> {
    if (!this.engine.state.getLoggedIn(agentId)) {
      return;
    }

    const lines = getAvailableActionSources(this.engine, agentId).map(
      (source) => `- action: ${formatActionSourceLine(source)}`,
    );
    const actionsText = lines.length > 0 ? `実行可能なアクション:\n${lines.join('\n')}` : '実行可能なアクションはありません。';
    const choicesText = this.getChoicesText(agentId);
    await this.sendToAgent(
      agentId,
      formatAvailableActionsInfoMessage(this.getWorldContext(agentId), actionsText, choicesText, this.skillName),
    );
  }

  private getAgentName(agentId: string): string {
    return this.engine.getAgentById(agentId)?.agent_name ?? agentId;
  }

  private getAgentLabel(agentId: string): string {
    const agent = this.engine.state.getLoggedIn(agentId) ?? this.engine.getAgentById(agentId);
    return agent?.agent_label ?? this.getAgentName(agentId);
  }

  private getWorldContext(agentId: string): WorldContext {
    return {
      worldName: this.engine.config.world.name,
      worldDescription: this.engine.config.world.description,
      agentLabel: this.getAgentLabel(agentId),
    };
  }

  private async sendToAgent(agentId: string, content: string): Promise<void> {
    const loggedInAgent = this.engine.state.getLoggedIn(agentId);
    if (!loggedInAgent) {
      return;
    }

    await this.bot.sendAgentMessage(loggedInAgent.discord_channel_id, content);
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
