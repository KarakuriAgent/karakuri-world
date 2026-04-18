# Unit 08 - R2 publish throttle と alarm 一本化
- 注記: Unit 29/31 で primary path の publish cadence・freshness・CDN readiness は別途確定済みであり、この Unit は **publisher と optional relay/DO を同居させる配備で追加 hardening を行うための historical 補助 Unit** として読む。primary launch blocker ではない。
- 参照: docs/design/detailed/13-ui-relay-backend.md §4.2, §5.1, §5.2, §5.5, §5.6, docs/plan/29-polling-r2-primary-architecture.md, docs/plan/31-polling-r2-cdn-readiness.md, docs/plan/32-optional-relay-ws-accelerator.md
- 目的: publish / heartbeat の時刻管理を 1 本の DO alarm に統合し、5秒制約と retry を守る。
- 実装対象: schedulePublish、scheduleHeartbeat、rescheduleAlarm、R2 PUT ヘッダー、published_at 上書き、R2 failure retry、R2 publish の連続失敗回数 streak (`BridgeState.publish_failure_streak`) と指数バックオフ（streak = N のとき待機時間を `min(SNAPSHOT_PUBLISH_INTERVAL_MS * 2^(N-1), PUBLISH_BACKOFF_MAX_MS)`。上限 60 秒）、成功時の streak リセット、heartbeat 失敗時の同等 streak / バックオフ。
- 完了条件: publish_alarm_at と heartbeat_alarm_at の競合で alarm が消えず、最早期限が常に採用される。広域障害で R2 PUT が連続失敗しても 5 秒毎の永続リトライに陥らず、streak に応じて再試行間隔が最大 60 秒まで延び、復旧時は成功 publish で streak が 0 に戻る。
- 依存: Unit 07。
- 検証: alarm 最早選択テスト、publish throttle テスト、R2 failure 後 retry テスト、連続失敗で再試行間隔が streak に従って延伸し上限で打ち止めになるテスト、成功時に streak がリセットされるテスト、cache header テスト。
- 非対象: UI の polling 実装、Access 配備検証、primary-path の readiness gate 定義（Unit 31）。
