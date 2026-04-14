# Unit 09 - Relay 障害観測と運用シグナル
- 参照: docs/design/detailed/13-ui-relay-backend.md §9, §9.1
- 目的: snapshot / D1 / WebSocket 障害を無言で見逃さない最低限の運用観測を実装する。
- 実装対象: `relay.ws.disconnect_total{reason,handshake_status}`、`relay.ws.connect_duration_ms`、`relay.ws.event_gap_ms`、`relay.snapshot.refresh_failure_total{reason}`、`relay.r2.publish_failure_total`、`relay.r2.publish_failure_streak`、`relay.heartbeat.failure_streak`、`relay.d1.ingest_failure_total{event_type}`、`relay.d1.retention_run_total{result}`、`relay.d1.retention_deleted_rows`、`relay.event.unknown_total{event_type}`、`relay.snapshot.generated_age_ms`、`relay.snapshot.published_age_ms` の送出点整理。
- 完了条件: 主要障害経路で counter / gauge が確実に増分され、ログと指標の相関が取れる。構成不備（`auth_rejected` 持続）と一時ネットワーク障害を `handshake_status` で区別でき、切断中イベント欠落範囲を `connect_duration_ms` / `event_gap_ms` から推定できる。retention cron の成功・失敗・削除件数が観測できる。
- 依存: Unit 06〜08。
- 検証: 失敗注入テスト（R2 PUT / D1 ingest / retention cron / WebSocket upgrade それぞれ）、metric emission テスト、切断 → 再接続シナリオで `connect_duration_ms` / `event_gap_ms` が出力されるテスト、ログ文脈テスト。
- 非対象: 外部監視 SaaS 選定、通知先ごとの alert ルーティング実装（Unit 28 で扱う）。
