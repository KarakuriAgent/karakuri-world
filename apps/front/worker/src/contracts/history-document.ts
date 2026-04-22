import { z } from 'zod';

export const historyEntrySchema = z.object({
  event_id: z.string().min(1),
  type: z.string().min(1),
  occurred_at: z.number().int().nonnegative(),
  agent_ids: z.array(z.string().min(1)),
  conversation_id: z.string().min(1).optional(),
  summary: z.object({
    emoji: z.string(),
    title: z.string(),
    text: z.string(),
  }),
  detail: z.record(z.string(), z.unknown()),
});

export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const agentHistoryDocumentSchema = z.object({
  agent_id: z.string().min(1).optional(),
  updated_at: z.number().int().nonnegative().optional(),
  items: z.array(historyEntrySchema).optional(),
  recent_actions: z.array(historyEntrySchema).optional(),
  recent_conversations: z.array(historyEntrySchema).optional(),
});

export type RawAgentHistoryDocument = z.infer<typeof agentHistoryDocumentSchema>;

export type AgentHistoryDocument = {
  agent_id: string;
  updated_at: number;
  items: HistoryEntry[];
  recent_actions: HistoryEntry[];
  recent_conversations: HistoryEntry[];
};

// agent_id is passed by the caller because the R2 key is the source of truth;
// the body is not required to echo it. All reader defaulting funnels through
// this helper so `?? []` / `?? 0` does not get duplicated at call sites.
export function coerceAgentHistoryDocument(raw: RawAgentHistoryDocument, agentId: string): AgentHistoryDocument {
  return {
    agent_id: raw.agent_id ?? agentId,
    updated_at: raw.updated_at ?? 0,
    items: raw.items ?? [],
    recent_actions: raw.recent_actions ?? [],
    recent_conversations: raw.recent_conversations ?? [],
  };
}

export const conversationHistoryDocumentSchema = z.object({
  conversation_id: z.string().min(1).optional(),
  updated_at: z.number().int().nonnegative().optional(),
  items: z.array(historyEntrySchema).optional(),
});

export type RawConversationHistoryDocument = z.infer<typeof conversationHistoryDocumentSchema>;

export type ConversationHistoryDocument = {
  conversation_id: string;
  updated_at: number;
  items: HistoryEntry[];
};

export function coerceConversationHistoryDocument(
  raw: RawConversationHistoryDocument,
  conversationId: string,
): ConversationHistoryDocument {
  return {
    conversation_id: raw.conversation_id ?? conversationId,
    updated_at: raw.updated_at ?? 0,
    items: raw.items ?? [],
  };
}

export interface HistoryResponse {
  items: HistoryEntry[];
}

export function historyAgentObjectKey(agentId: string): string {
  return `history/agents/${encodeURIComponent(agentId)}.json`;
}

export function historyConversationObjectKey(conversationId: string): string {
  return `history/conversations/${encodeURIComponent(conversationId)}.json`;
}

export function dedupeHistoryEntriesByEventId(items: HistoryEntry[]): HistoryEntry[] {
  const seen = new Set<string>();
  const deduped: HistoryEntry[] = [];

  for (const item of items) {
    if (seen.has(item.event_id)) {
      continue;
    }

    seen.add(item.event_id);
    deduped.push(item);
  }

  return deduped;
}

export function sortHistoryEntriesByOccurredAtDesc(items: HistoryEntry[]): HistoryEntry[] {
  return [...items].sort(
    (left, right) => right.occurred_at - left.occurred_at || right.event_id.localeCompare(left.event_id),
  );
}
