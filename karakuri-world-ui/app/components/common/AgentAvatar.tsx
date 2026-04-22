import { useEffect, useState } from 'react';

import { getAgentAvatarFallbackLabel } from '../../lib/agent-avatar.js';

export type AgentAvatarSize = 'sm' | 'md' | 'lg';

const AGENT_AVATAR_SIZE_CLASSES: Record<AgentAvatarSize, string> = {
  sm: 'h-8 w-8 text-sm',
  md: 'h-14 w-14 text-xl',
  lg: 'h-16 w-16 text-2xl',
};

export interface AgentAvatarProps {
  agent: {
    agent_id: string;
    agent_name: string;
    discord_bot_avatar_url?: string;
  };
  size?: AgentAvatarSize;
  testId?: string;
  fallbackTestId?: string;
}

export function AgentAvatar({ agent, size = 'lg', testId, fallbackTestId }: AgentAvatarProps) {
  const [hasImageError, setHasImageError] = useState(false);
  const sizeClassName = AGENT_AVATAR_SIZE_CLASSES[size];
  const fallbackLabel = getAgentAvatarFallbackLabel(agent.agent_name);
  const shouldRenderImage = Boolean(agent.discord_bot_avatar_url) && !hasImageError;

  useEffect(() => {
    setHasImageError(false);
  }, [agent.agent_id, agent.discord_bot_avatar_url]);

  return (
    <div
      className={`${sizeClassName} flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-700 bg-slate-800 font-semibold text-white`}
      data-testid={testId}
    >
      {shouldRenderImage ? (
        <img
          src={agent.discord_bot_avatar_url}
          alt={`${agent.agent_name} avatar`}
          className="h-full w-full object-cover"
          onError={() => setHasImageError(true)}
        />
      ) : (
        <span data-testid={fallbackTestId}>{fallbackLabel}</span>
      )}
    </div>
  );
}
