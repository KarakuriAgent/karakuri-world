import type {
  SpectatorAgentSnapshot,
  SpectatorSnapshot,
} from '../../../worker/src/contracts/spectator-snapshot.js';

import { getAgentStateLabel } from '../../lib/agent-state-label.js';
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
      className="sticky top-0 flex h-screen w-full flex-col overflow-y-auto border-r border-slate-800 bg-slate-950/95 p-6"
      data-testid="desktop-sidebar"
    >
      <header className="space-y-2 border-b border-slate-800 pb-4">
        <p className="text-sm font-medium text-slate-300">{snapshot?.world.name ?? 'Karakuri World'}</p>
        <h1 className="text-2xl font-semibold text-white">{snapshot?.calendar.display_label ?? 'snapshot loading...'}</h1>
        <p className="text-sm text-slate-400" data-testid="desktop-sidebar-weather">
          {snapshot?.weather
            ? `${snapshot.weather.condition} ${snapshot.weather.temperature_celsius}℃`
            : '天気情報を表示します'}
        </p>
      </header>

      <section className="space-y-3 border-b border-slate-800 py-4">
        <h2 className="text-sm font-semibold text-white">サーバーイベント</h2>
        {recentServerEvents.length ? (
          <ul className="space-y-2 text-sm text-slate-200">
            {recentServerEvents.map((event) => (
              <li
                key={event.server_event_id}
                className="rounded-xl border border-slate-800 bg-slate-900/70 p-3"
                data-testid="desktop-server-event-item"
              >
                <p className="font-medium text-slate-100">{event.description}</p>
                <time className="mt-1 block text-xs text-slate-500">
                  {formatHistoryTimestamp(event.occurred_at, timezone)}
                </time>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-xl border border-dashed border-slate-700 p-3 text-sm text-slate-400">
            サーバーイベントはまだありません
          </p>
        )}
      </section>

      <section className="min-h-0 flex-1 pt-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">エージェント一覧</h2>
          <span className="text-xs text-slate-400">{agents.length} agents</span>
        </div>
        <ul className="space-y-2 overflow-y-auto pr-1" data-testid="sidebar-agent-list">
          {agents.length > 0 ? (
            agents.map((agent) => (
              <li key={agent.agent_id}>
                <button
                  type="button"
                  className={`w-full rounded-xl border p-3 text-left transition-colors ${
                    selectedAgentId === agent.agent_id
                      ? 'border-cyan-400/70 bg-cyan-400/10 shadow-[0_0_0_1px_rgba(34,211,238,0.2)]'
                      : 'border-slate-800 bg-slate-900/70 hover:border-slate-700 hover:bg-slate-900'
                  }`}
                  data-testid={`sidebar-agent-button-${agent.agent_id}`}
                  aria-pressed={selectedAgentId === agent.agent_id}
                  onClick={() => onSelectAgent?.(agent.agent_id)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-slate-100">{agent.agent_name}</p>
                      <p className="text-xs text-slate-400">{agent.node_id}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-lg leading-none">{agent.status_emoji}</p>
                      <p className="mt-1 text-xs text-slate-400">{getAgentStateLabel(agent.state)}</p>
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
