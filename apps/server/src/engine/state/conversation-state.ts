import type { ConversationData } from '../../types/conversation.js';

export class ConversationStateStore {
  private readonly conversations = new Map<string, ConversationData>();

  set(conversation: ConversationData): ConversationData {
    this.conversations.set(conversation.conversation_id, conversation);
    return conversation;
  }

  get(conversationId: string): ConversationData | null {
    return this.conversations.get(conversationId) ?? null;
  }

  delete(conversationId: string): ConversationData | null {
    const conversation = this.conversations.get(conversationId) ?? null;
    if (conversation) {
      this.conversations.delete(conversationId);
    }
    return conversation;
  }

  list(): ConversationData[] {
    return [...this.conversations.values()].sort((left, right) => left.conversation_id.localeCompare(right.conversation_id));
  }
}
