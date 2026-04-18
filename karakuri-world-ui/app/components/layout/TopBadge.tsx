import type { SpectatorSnapshot } from '../../../worker/src/contracts/spectator-snapshot.js';

export interface TopBadgeProps {
  snapshot?: SpectatorSnapshot;
}

export function TopBadge({ snapshot }: TopBadgeProps) {
  return (
    <section
      className="flex items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-950/80 px-4 py-3 backdrop-blur"
      data-testid="mobile-top-badge"
    >
      <div>
        <p className="text-xs uppercase tracking-[0.24em] text-cyan-300">観戦ビュー</p>
        <p className="text-sm font-medium text-white">{snapshot?.calendar.display_label ?? '読み込み待ち'}</p>
      </div>
      <p className="text-sm text-slate-300">
        {snapshot?.weather ? `${snapshot.weather.condition} ${snapshot.weather.temperature_celsius}℃` : '天気未取得'}
      </p>
    </section>
  );
}
