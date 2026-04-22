import type {
  SpectatorAgentSnapshot,
  SpectatorSnapshot,
} from '../../../worker/src/contracts/spectator-snapshot.js';

import { AgentAvatar } from '../common/AgentAvatar.js';
import { getAgentStateLabel } from '../../lib/agent-state-label.js';
import { formatNodeLabel } from '../../lib/node-label.js';
import { getSidebarServerEvents } from '../../lib/recent-server-events.js';
import { formatHistoryTimestamp } from '../../lib/timestamp.js';

export interface SidebarProps {
  snapshot?: SpectatorSnapshot;
  agents: SpectatorAgentSnapshot[];
  selectedAgentId?: string;
  onSelectAgent?: (agentId: string) => void;
}

export function Sidebar({ snapshot, agents, selectedAgentId, onSelectAgent }: SidebarProps) {
  const recentServerEvents = getSidebarServerEvents(snapshot);
  const timezone = snapshot?.timezone;

  return (
    <aside
      className="flex h-full max-h-screen w-full flex-col overflow-y-auto border-r border-slate-800 bg-slate-950/95 p-3 max-lg:landscape:text-xs lg:p-6"
      data-testid="desktop-sidebar"
    >
      <header className="space-y-1 border-b border-slate-800 pb-3 lg:space-y-2 lg:pb-4">
        <p className="text-xs font-medium text-slate-300 lg:text-sm">{snapshot?.world.name ?? 'Karakuri World'}</p>
        <h1 className="text-base font-semibold text-white lg:text-2xl">{snapshot?.calendar.display_label ?? '読み込み中…'}</h1>
        <p className="text-xs text-slate-400 lg:text-sm" data-testid="desktop-sidebar-weather">
          {snapshot?.weather
            ? `${snapshot.weather.condition} ${snapshot.weather.temperature_celsius}℃`
            : '天気情報を表示します'}
        </p>
      </header>

      <section className="space-y-2 border-b border-slate-800 py-3 lg:space-y-3 lg:py-4">
        <h2 className="text-xs font-semibold text-white lg:text-sm">サーバーイベント</h2>
        {recentServerEvents.length ? (
          <ul className="space-y-2 text-xs text-slate-200 lg:text-sm">
            {recentServerEvents.map((event) => (
              <li
                key={event.server_event_id}
                className="rounded-xl border border-slate-800 bg-slate-900/70 p-2 lg:p-3"
                data-testid="desktop-server-event-item"
              >
                <p className="font-medium text-slate-100">{event.description}</p>
                <time className="mt-1 block text-[10px] text-slate-500 lg:text-xs">
                  {formatHistoryTimestamp(event.occurred_at, timezone)}
                </time>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-xl border border-dashed border-slate-700 p-2 text-xs text-slate-400 lg:p-3 lg:text-sm">
            サーバーイベントはまだありません
          </p>
        )}
      </section>

      <section className="min-h-0 flex-1 pt-3 lg:pt-4">
        <div className="mb-2 flex items-center justify-between lg:mb-3">
          <h2 className="text-xs font-semibold text-white lg:text-sm">エージェント一覧</h2>
          <span className="text-[10px] text-slate-400 lg:text-xs">{agents.length} 人</span>
        </div>
        <ul className="space-y-2 overflow-y-auto pr-1" data-testid="sidebar-agent-list">
          {agents.length > 0 ? (
            agents.map((agent) => (
              <li key={agent.agent_id}>
                <button
                  type="button"
                  className={`w-full rounded-xl border p-2 text-left transition-colors lg:p-3 ${
                    selectedAgentId === agent.agent_id
                      ? 'border-cyan-400/70 bg-cyan-400/10 shadow-[0_0_0_1px_rgba(34,211,238,0.2)]'
                      : 'border-slate-800 bg-slate-900/70 hover:border-slate-700 hover:bg-slate-900'
                  }`}
                  data-testid={`sidebar-agent-button-${agent.agent_id}`}
                  aria-pressed={selectedAgentId === agent.agent_id}
                  onClick={() => onSelectAgent?.(agent.agent_id)}
                >
                  <div className="flex items-center justify-between gap-2 lg:gap-3">
                    <div className="flex min-w-0 items-center gap-2 lg:gap-3">
                      <AgentAvatar
                        agent={agent}
                        size="sm"
                        testId={`sidebar-agent-avatar-${agent.agent_id}`}
                        fallbackTestId={`sidebar-agent-avatar-fallback-${agent.agent_id}`}
                      />
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-slate-100 lg:text-base">{agent.agent_name}</p>
                        <p className="text-[10px] text-slate-400 lg:text-xs">{formatNodeLabel(agent.node_id, snapshot?.map)}</p>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-base leading-none lg:text-lg">{agent.status_emoji}</p>
                      <p className="mt-1 text-[10px] text-slate-400 lg:text-xs">{getAgentStateLabel(agent.state)}</p>
                    </div>
                  </div>
                </button>
              </li>
            ))
          ) : (
            <li className="rounded-xl border border-dashed border-slate-700 p-3 text-sm text-slate-400">
              エージェントが接続するとここに一覧が表示されます
            </li>
          )}
        </ul>
      </section>
    </aside>
  );
}
