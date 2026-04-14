# Unit 28 - Relay alert 配線と readiness
- 参照: docs/design/detailed/13-ui-relay-backend.md §9.1
- 目的: relay observability を本番運用で実際に検知へ結びつけ、alert 未配線のまま配備しない gate を持たせる。
- 実装対象: `relay.ws.disconnect_total{reason,handshake_status}`、`relay.ws.connect_duration_ms`、`relay.ws.event_gap_ms`、`relay.snapshot.refresh_failure_total`、`relay.r2.publish_failure_total`、`relay.r2.publish_failure_streak`、`relay.heartbeat.failure_streak`、`relay.d1.ingest_failure_total`、`relay.d1.retention_run_total{result}`、`relay.d1.retention_deleted_rows`、`relay.event.unknown_total`、`relay.snapshot.generated_age_ms`、`relay.snapshot.published_age_ms` を使う alert rule と通知経路、`handshake_status = auth_rejected` 系を即時ページ・`network` 系を一定時間連続で通知するなどの分類、retention cron が N 日連続で success を出さない場合の通知、publish_failure_streak が上限値（60 秒待機）に張り付いた場合の通知、配備前 readiness checklist、staging での synthetic failure 注入による alert 疎通確認。
- 完了条件: 採用した監視基盤上で freshness 低下系と ingest / publish 失敗系の alert が有効化され、通知先・担当・解除条件が定義され、staging で少なくとも 1 回ずつ発火確認してから本番投入できる。構成不備（`auth_rejected`）と一時障害が別ルートで通知される。retention cron の無音停止と R2 publish の暴走リトライブレーキが検知できる。
- 依存: Unit 09。
- 検証: alert rule review、synthetic failure drill（R2 PUT 持続失敗、`auth_rejected` 持続、retention cron 無音停止、event ingest 失敗、切断継続）、notification receipt checklist、pre-production readiness sign-off。
- 非対象: 新規監視 SaaS の選定、本体サーバー側 metric 追加。
