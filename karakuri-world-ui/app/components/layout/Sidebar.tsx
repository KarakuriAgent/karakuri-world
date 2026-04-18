import type {
  SpectatorAgentSnapshot,
  SpectatorSnapshot,
} from '../../../worker/src/contracts/spectator-snapshot.js';

import { getOutstandingServerEventCount, getSidebarServerEventsState } from '../../lib/recent-server-events.js';

export interface SidebarProps {
  snapshot?: SpectatorSnapshot;
  agents: SpectatorAgentSnapshot[];
  selectedAgentId?: string;
  onSelectAgent?: (agentId: string) => void;
}

export function Sidebar({ snapshot, agents, selectedAgentId, onSelectAgent }: SidebarProps) {
  const serverEventsState = getSidebarServerEventsState(snapshot);
  const recentServerEvents = serverEventsState.events;
  const outstandingServerEventCount = getOutstandingServerEventCount(snapshot);

  return (
    <aside
      className="flex min-h-screen w-full flex-col border-r border-slate-800 bg-slate-950/95 p-6"
      data-testid="desktop-sidebar"
    >
      <header className="space-y-2 border-b border-slate-800 pb-4">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-300">Spectator shell</p>
        <p className="text-sm font-medium text-slate-300">{snapshot?.world.name ?? 'Karakuri World'}</p>
        <h1 className="text-2xl font-semibold text-white">{snapshot?.calendar.display_label ?? 'snapshot loading...'}</h1>
        <p className="text-sm text-slate-400" data-testid="desktop-sidebar-weather">
          {snapshot?.weather
            ? `${snapshot.weather.condition} ${snapshot.weather.temperature_celsius}℃`
            : '天気情報を表示します'}
        </p>
      </header>

      <section className="space-y-3 border-b border-slate-800 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-white">サーバーイベント</h2>
            {serverEventsState.is_degraded_fallback ? (
              <span
                className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-200"
                data-testid="desktop-server-events-fallback-badge"
              >
                フォールバック表示
              </span>
            ) : null}
          </div>
          <span
            className="rounded-full bg-slate-800 px-2 py-1 text-xs text-slate-300"
            data-testid="desktop-sidebar-server-event-count"
          >
            未解決 {outstandingServerEventCount} 件
          </span>
        </div>
        {serverEventsState.is_degraded_fallback ? (
          <p
            className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100"
            data-testid="desktop-server-events-fallback-note"
          >
            直近履歴を復元できなかったため、進行中イベントを暫定表示しています。
          </p>
        ) : null}
        {recentServerEvents.length ? (
          <ul className="space-y-2 text-sm text-slate-200">
            {recentServerEvents.map((event) => (
              <li
                key={event.server_event_id}
                className="rounded-xl border border-slate-800 bg-slate-900/70 p-3"
                data-testid="desktop-server-event-item"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="font-medium text-slate-100">{event.description}</p>
                  <span
                    className={`rounded-full px-2 py-1 text-[11px] font-medium ${
                      event.is_active_now ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-800 text-slate-300'
                    }`}
                    data-testid={`desktop-server-event-status-${event.server_event_id}`}
                  >
                    {event.is_active_now ? '進行中' : '履歴'}
                  </span>
                </div>
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
                      <p className="mt-1 text-xs uppercase tracking-wide text-slate-400">{agent.state}</p>
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
