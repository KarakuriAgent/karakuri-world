const AGENT_AVATAR_PLACEHOLDER_PALETTE = ['#0ea5e9', '#8b5cf6', '#f97316', '#10b981', '#ec4899', '#f59e0b'];

function hashString(value: string): number {
  let hash = 0;

  for (const char of value) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }

  return Math.abs(hash);
}

export function getAgentAvatarFallbackLabel(agentName: string): string {
  return agentName.trim().charAt(0).toUpperCase() || '?';
}

export function getAgentAvatarPlaceholderColor(agentId: string): string {
  return AGENT_AVATAR_PLACEHOLDER_PALETTE[hashString(agentId) % AGENT_AVATAR_PLACEHOLDER_PALETTE.length]!;
}
