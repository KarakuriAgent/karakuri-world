import type { SpectatorAgentSnapshot, SpectatorSnapshot } from '../../../worker/src/contracts/spectator-snapshot.js';
import { getAgentAvatarFallbackLabel, getAgentAvatarPlaceholderColor } from '../../lib/agent-avatar.js';
import { getNodeCenter } from './map-render-model.js';
import type { AgentVisualPosition } from './motion-effects.js';

const AGENT_AVATAR_SIZE_RATIO = 0.58;
const AGENT_STATUS_FONT_RATIO = 0.22;
const AGENT_GROUP_BADGE_FONT_RATIO = 0.18;
const AGENT_GROUP_STACK_OFFSET_RATIO = 0.18;
const MAX_GROUP_VISIBLE_AVATARS = 3;

export interface AgentAvatarRenderModel {
  agentId: string;
  agentName: string;
  nodeId: string;
  centerX: number;
  centerY: number;
  size: number;
  statusEmoji: string;
  statusFontSize: number;
  avatarUrl?: string;
  fallbackLabel: string;
  placeholderColor: string;
  isSelected: boolean;
}

export interface SingleAgentRenderModel {
  kind: 'single';
  key: string;
  agent: AgentAvatarRenderModel;
}

export interface AgentGroupRenderModel {
  kind: 'group';
  key: string;
  nodeId: string;
  centerX: number;
  centerY: number;
  count: number;
  badgeFontSize: number;
  agents: SpectatorAgentSnapshot[];
  visibleAvatars: AgentAvatarRenderModel[];
}

export type AgentRenderTarget = SingleAgentRenderModel | AgentGroupRenderModel;

export interface SelectionRingRenderModel {
  agentId: string;
  centerX: number;
  centerY: number;
  radius: number;
}

function compareAgents(left: SpectatorAgentSnapshot, right: SpectatorAgentSnapshot): number {
  return left.agent_name.localeCompare(right.agent_name, 'ja') || left.agent_id.localeCompare(right.agent_id, 'ja');
}

function getGroupVisibleAgents(
  agents: SpectatorAgentSnapshot[],
  selectedAgentId: string | undefined,
): SpectatorAgentSnapshot[] {
  const sortedAgents = [...agents].sort(compareAgents);
  const selectedAgent = selectedAgentId
    ? sortedAgents.find((agent) => agent.agent_id === selectedAgentId)
    : undefined;
  const withoutSelected = selectedAgent
    ? sortedAgents.filter((agent) => agent.agent_id !== selectedAgent.agent_id)
    : sortedAgents;
  const visibleAgents = selectedAgent
    ? withoutSelected.slice(0, MAX_GROUP_VISIBLE_AVATARS - 1).concat(selectedAgent)
    : sortedAgents.slice(0, MAX_GROUP_VISIBLE_AVATARS);

  return visibleAgents.length <= 1
    ? visibleAgents
    : visibleAgents.filter((agent) => agent.agent_id !== selectedAgent?.agent_id).concat(selectedAgent ?? []);
}

function getGroupOffsets(count: number, offset: number): number[] {
  switch (count) {
    case 1:
      return [0];
    case 2:
      return [-offset * 0.55, offset * 0.55];
    default:
      return [-offset, 0, offset];
  }
}

export function buildAgentRenderTargets(
  snapshot: Pick<SpectatorSnapshot, 'agents' | 'map' | 'map_render_theme'>,
  selectedAgentId?: string,
  agentPositions?: Record<string, AgentVisualPosition>,
): AgentRenderTarget[] {
  const groupedAgents = new Map<string, SpectatorAgentSnapshot[]>();

  for (const agent of snapshot.agents) {
    const visualPosition = agentPositions?.[agent.agent_id];
    const groupKey = visualPosition?.mode === 'interpolated' ? `agent:${agent.agent_id}` : agent.node_id;
    const currentGroup = groupedAgents.get(groupKey);

    if (currentGroup) {
      currentGroup.push(agent);
    } else {
      groupedAgents.set(groupKey, [agent]);
    }
  }

  const avatarSize = snapshot.map_render_theme.cell_size * AGENT_AVATAR_SIZE_RATIO;
  const statusFontSize = snapshot.map_render_theme.cell_size * AGENT_STATUS_FONT_RATIO;
  const badgeFontSize = snapshot.map_render_theme.cell_size * AGENT_GROUP_BADGE_FONT_RATIO;
  const stackOffset = snapshot.map_render_theme.cell_size * AGENT_GROUP_STACK_OFFSET_RATIO;
  const targets: AgentRenderTarget[] = [];
  const sortedGroups = [...groupedAgents.entries()].sort(([leftNodeId], [rightNodeId]) =>
    leftNodeId.localeCompare(rightNodeId, 'ja'),
  );

  for (const [nodeId, agents] of sortedGroups) {
    const visualCenter =
      agents.length === 1 ? agentPositions?.[agents[0]!.agent_id] : undefined;
    const nodeCenter = visualCenter ?? getNodeCenter(snapshot, agents[0]?.node_id ?? nodeId);

    if (!nodeCenter) {
      continue;
    }

    if (agents.length === 1) {
      const agent = agents[0]!;

      targets.push({
        kind: 'single',
        key: 'single-' + agent.agent_id,
        agent: {
          agentId: agent.agent_id,
          agentName: agent.agent_name,
          nodeId: agent.node_id,
          centerX: nodeCenter.centerX,
          centerY: nodeCenter.centerY,
          size: avatarSize,
          statusEmoji: agent.status_emoji,
          statusFontSize,
          ...(agent.discord_bot_avatar_url ? { avatarUrl: agent.discord_bot_avatar_url } : {}),
          fallbackLabel: getAgentAvatarFallbackLabel(agent.agent_name),
          placeholderColor: getAgentAvatarPlaceholderColor(agent.agent_id),
          isSelected: selectedAgentId === agent.agent_id,
        },
      });
      continue;
    }

    const visibleAgents = getGroupVisibleAgents(agents, selectedAgentId);
    const offsets = getGroupOffsets(visibleAgents.length, stackOffset);

    targets.push({
      kind: 'group',
      key: 'group-' + nodeId,
      nodeId,
      centerX: nodeCenter.centerX,
      centerY: nodeCenter.centerY,
      count: agents.length,
      badgeFontSize,
      agents: [...agents].sort(compareAgents),
      visibleAvatars: visibleAgents.map((agent, index) => ({
        agentId: agent.agent_id,
        agentName: agent.agent_name,
        nodeId: agent.node_id,
        centerX: nodeCenter.centerX + offsets[index]!,
        centerY: nodeCenter.centerY + Math.abs(offsets[index] ?? 0) * 0.12,
        size: avatarSize,
        statusEmoji: agent.status_emoji,
        statusFontSize,
        ...(agent.discord_bot_avatar_url ? { avatarUrl: agent.discord_bot_avatar_url } : {}),
        fallbackLabel: getAgentAvatarFallbackLabel(agent.agent_name),
        placeholderColor: getAgentAvatarPlaceholderColor(agent.agent_id),
        isSelected: selectedAgentId === agent.agent_id,
      })),
    });
  }

  return targets;
}

export function buildSelectionRingModels(targets: AgentRenderTarget[]): SelectionRingRenderModel[] {
  return targets.flatMap((target) => {
    if (target.kind === 'single') {
      return target.agent.isSelected
        ? [
            {
              agentId: target.agent.agentId,
              centerX: target.agent.centerX,
              centerY: target.agent.centerY,
              radius: target.agent.size / 2 + 8,
            },
          ]
        : [];
    }

    return target.visibleAvatars
      .filter((avatar) => avatar.isSelected)
      .map((avatar) => ({
        agentId: avatar.agentId,
        centerX: avatar.centerX,
        centerY: avatar.centerY,
        radius: avatar.size / 2 + 8,
      }));
  });
}

export function findSelectedGroupNodeId(targets: AgentRenderTarget[], selectedAgentId?: string): string | undefined {
  if (!selectedAgentId) {
    return undefined;
  }

  const selectedGroup = targets.find(
    (target): target is AgentGroupRenderModel =>
      target.kind === 'group' && target.agents.some((agent) => agent.agent_id === selectedAgentId),
  );

  return selectedGroup?.nodeId;
}
