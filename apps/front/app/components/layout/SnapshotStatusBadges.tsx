import type { SnapshotStatus } from '../../store/snapshot-store.js';

export interface SnapshotStatusBadgesProps {
  snapshotStatus: SnapshotStatus;
  isStale: boolean;
  testIdPrefix?: string;
}

function withPrefix(prefix: string | undefined, testId: string): string {
  return prefix ? `${prefix}-${testId}` : testId;
}

export function SnapshotStatusBadges({
  snapshotStatus,
  isStale,
  testIdPrefix,
}: SnapshotStatusBadgesProps) {
  return (
    <>
      {isStale ? <span data-testid={withPrefix(testIdPrefix, 'snapshot-stale-badge')}>接続遅延中</span> : null}
      {snapshotStatus === 'error' ? (
        <span data-testid={withPrefix(testIdPrefix, 'snapshot-error-badge')}>更新の取得に失敗しました</span>
      ) : null}
      {snapshotStatus === 'incompatible' ? (
        <span data-testid={withPrefix(testIdPrefix, 'snapshot-incompatible-badge')}>
          観戦 UI の更新が必要です。再読み込みしてください。
        </span>
      ) : null}
    </>
  );
}
