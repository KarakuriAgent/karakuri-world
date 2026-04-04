import type { NodeId } from '../types/data-model.js';
import type { AgentSnapshot, ConversationSnapshot, WorldSnapshot } from '../types/snapshot.js';

const MESSAGE_CHAR_LIMIT = 1900;

function formatTime(timestamp: number, timezone: string): string {
  return new Date(timestamp).toLocaleTimeString('ja-JP', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatNode(nodeId: NodeId, snapshot: WorldSnapshot): string {
  const label = snapshot.map.nodes[nodeId]?.label;
  return label ? `${nodeId} (${label})` : nodeId;
}

function buildAgentNameMap(snapshot: WorldSnapshot): Map<string, string> {
  return new Map(snapshot.agents.map((agent) => [agent.agent_id, agent.agent_name]));
}

function formatAgentStatus(agent: AgentSnapshot, snapshot: WorldSnapshot): string {
  const location = formatNode(agent.node_id, snapshot);
  switch (agent.state) {
    case 'moving':
      if (agent.movement) {
        return `- **${agent.agent_name}** - ${location} - 移動中 → ${formatNode(agent.movement.to_node_id, snapshot)}`;
      }
      return `- **${agent.agent_name}** - ${location} - 移動中`;
    case 'in_action':
      if (agent.current_activity?.type === 'action') {
        return `- **${agent.agent_name}** - ${location} - 行動中:「${agent.current_activity.action_name}」`;
      }
      if (agent.current_activity?.type === 'wait') {
        return `- **${agent.agent_name}** - ${location} - 待機中`;
      }
      return `- **${agent.agent_name}** - ${location} - 行動中`;
    case 'in_conversation':
      return `- **${agent.agent_name}** - ${location} - 会話中`;
    case 'idle':
      return `- **${agent.agent_name}** - ${location} - 待機中`;
  }
}

function formatConversation(conversation: ConversationSnapshot, agentNames: Map<string, string>): string {
  const initiatorName = agentNames.get(conversation.initiator_agent_id) ?? conversation.initiator_agent_id;
  const targetName = agentNames.get(conversation.target_agent_id) ?? conversation.target_agent_id;
  const speakerName = agentNames.get(conversation.current_speaker_agent_id) ?? conversation.current_speaker_agent_id;
  const closingSuffix = conversation.status === 'closing' ? ', 終了処理中' : '';
  const displayedTurn = Math.min(conversation.current_turn, conversation.max_turns);
  return `- ${initiatorName} と ${targetName} (ターン ${displayedTurn}/${conversation.max_turns}, ${speakerName}の番${closingSuffix})`;
}


function buildSection(title: string, lines: string[]): string {
  return `## ${title}\n\n${lines.join('\n')}`;
}

function splitLongLine(line: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < line.length; start += MESSAGE_CHAR_LIMIT) {
    chunks.push(line.slice(start, start + MESSAGE_CHAR_LIMIT));
  }
  return chunks;
}

function splitOversizedSection(section: string): string[] {
  const lines = section.split('\n');
  const chunks: string[] = [];
  let current = '';

  const pushCurrent = (): void => {
    const trimmed = current.trim();
    if (trimmed) {
      chunks.push(trimmed);
    }
    current = '';
  };

  for (const line of lines) {
    const lineChunks = line.length > MESSAGE_CHAR_LIMIT ? splitLongLine(line) : [line];
    for (const lineChunk of lineChunks) {
      const candidate = current ? `${current}\n${lineChunk}` : lineChunk;
      if (candidate.length > MESSAGE_CHAR_LIMIT) {
        pushCurrent();
        current = lineChunk;
      } else {
        current = candidate;
      }
    }
  }

  pushCurrent();
  return chunks;
}

function splitSectionsIntoMessages(sections: string[]): string[] {
  const expandedSections = sections.flatMap((section) =>
    section.length > MESSAGE_CHAR_LIMIT ? splitOversizedSection(section) : [section],
  );

  const messages: string[] = [];
  let current = '';

  for (const section of expandedSections) {
    const candidate = current ? `${current}\n\n${section}` : section;
    if (candidate.length > MESSAGE_CHAR_LIMIT) {
      if (current) {
        messages.push(current);
      }
      current = section;
    } else {
      current = candidate;
    }
  }

  if (current) {
    messages.push(current);
  }

  return messages;
}

export function formatStatusBoard(snapshot: WorldSnapshot, timezone: string): string[] {
  const header = [`# ${snapshot.world.name}`, snapshot.world.description].filter(Boolean).join('\n');

  const agents = [...snapshot.agents].sort((left, right) => left.agent_name.localeCompare(right.agent_name));
  const agentLines = agents.length > 0
    ? agents.map((agent) => formatAgentStatus(agent, snapshot))
    : ['_ログイン中のエージェントはいません。_'];

  const agentNames = buildAgentNameMap(snapshot);
  const conversations = snapshot.conversations.filter((conversation) => conversation.status !== 'pending');
  const conversationLines = conversations.length > 0
    ? conversations.map((conversation) => formatConversation(conversation, agentNames))
    : ['_進行中の会話はありません。_'];

  const sections = [
    header,
    buildSection(`エージェント状況 (${agents.length}名ログイン中)`, agentLines),
    buildSection(`進行中の会話 (${conversations.length}件)`, conversationLines),
    `---\n最終更新: ${formatTime(snapshot.generated_at, timezone)}`,
  ];

  return splitSectionsIntoMessages(sections);
}
