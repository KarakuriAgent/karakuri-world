import type { HistoryEntry } from '../../worker/src/contracts/history-document.js';
import type {
  SpectatorAgentSnapshot,
  SpectatorKnownAgent,
  SpectatorSnapshot,
} from '../../worker/src/contracts/spectator-snapshot.js';

export interface HistorySpeakerResolution {
  speaker_agent_id: string;
  agent?: SpectatorAgentSnapshot;
  known_agent?: SpectatorKnownAgent;
  display_name: string;
  discord_bot_avatar_url?: string;
}

const SPEAKING_EVENT_TYPES = new Set<HistoryEntry['type']>([
  'conversation_requested',
  'conversation_message',
  'conversation_interval_interrupted',
  'conversation_ended',
]);

const UTTERANCE_EVENT_TYPES = new Set<HistoryEntry['type']>([
  'conversation_requested',
  'conversation_message',
  'conversation_interval_interrupted',
]);

export function isSpeakingHistoryEntry(entry: HistoryEntry): boolean {
  return SPEAKING_EVENT_TYPES.has(entry.type);
}

export function isUtteranceHistoryEntry(entry: HistoryEntry): boolean {
  return UTTERANCE_EVENT_TYPES.has(entry.type);
}

function getSpeakerIdFromDetail(entry: HistoryEntry): string | undefined {
  const detail = entry.detail as Record<string, unknown> | undefined;
  if (!detail) {
    return undefined;
  }

  if (entry.type === 'conversation_ended') {
    const finalSpeaker = detail.final_speaker_agent_id;
    return typeof finalSpeaker === 'string' && finalSpeaker.length > 0 ? finalSpeaker : undefined;
  }

  if (entry.type === 'conversation_requested') {
    const initiator = detail.initiator_agent_id;
    return typeof initiator === 'string' && initiator.length > 0 ? initiator : undefined;
  }

  const speaker = detail.speaker_agent_id;
  return typeof speaker === 'string' && speaker.length > 0 ? speaker : undefined;
}

export function resolveHistorySpeaker(
  entry: HistoryEntry,
  snapshot: Pick<SpectatorSnapshot, 'agents' | 'known_agents'> | undefined,
): HistorySpeakerResolution | undefined {
  if (!isSpeakingHistoryEntry(entry)) {
    return undefined;
  }

  const speakerId = getSpeakerIdFromDetail(entry);
  if (!speakerId) {
    return undefined;
  }

  const agent = snapshot?.agents.find((candidate) => candidate.agent_id === speakerId);
  const knownAgent = snapshot?.known_agents?.find((candidate) => candidate.agent_id === speakerId);
  if (!agent && !knownAgent) {
    console.warn('resolveHistorySpeaker: speaker not found in snapshot.agents or known_agents', {
      speaker_id: speakerId,
      event_id: entry.event_id,
      event_type: entry.type,
    });
  }
  const displayName = agent?.agent_name ?? knownAgent?.agent_name ?? speakerId;
  const avatarUrl = agent?.discord_bot_avatar_url ?? knownAgent?.discord_bot_avatar_url;

  return {
    speaker_agent_id: speakerId,
    ...(agent ? { agent } : {}),
    ...(knownAgent ? { known_agent: knownAgent } : {}),
    display_name: displayName,
    ...(avatarUrl ? { discord_bot_avatar_url: avatarUrl } : {}),
  };
}

export function collapseConversationHistoryForAgentTimeline(items: HistoryEntry[]): HistoryEntry[] {
  const headEventIdByConversationId = new Map<string, string>();

  const conversationsById = new Map<string, HistoryEntry[]>();
  for (const item of items) {
    if (!item.conversation_id) {
      continue;
    }
    const bucket = conversationsById.get(item.conversation_id) ?? [];
    bucket.push(item);
    conversationsById.set(item.conversation_id, bucket);
  }

  for (const [conversationId, bucket] of conversationsById) {
    const requested = bucket.find((entry) => entry.type === 'conversation_requested');
    if (requested) {
      headEventIdByConversationId.set(conversationId, requested.event_id);
      continue;
    }

    const utterances = bucket.filter(isUtteranceHistoryEntry);
    const earliestUtterance = utterances.at(-1);
    if (earliestUtterance) {
      headEventIdByConversationId.set(conversationId, earliestUtterance.event_id);
    }
  }

  return items.filter((item) => {
    if (!item.conversation_id) {
      return true;
    }
    return headEventIdByConversationId.get(item.conversation_id) === item.event_id;
  });
}
