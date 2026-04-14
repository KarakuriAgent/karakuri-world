# Unit 10 - History D1 スキーマと retention
- 参照: docs/design/detailed/14-ui-history-api.md §2, §3, §4.3
- 目的: 履歴 API の driver になる D1 テーブル・インデックス・保守ジョブを確定する。
- 実装順序上の注意: Unit 番号は識別子であり実装順序ではない。Unit 10 は Unit 06 / Unit 11 に先行して完了させる。
- 実装対象: world_events、world_event_agents、world_event_conversations、server_event_instances の migration、retention cron、link 表の複合 index、retention cron の実行結果を出力する observability フック（`relay.d1.retention_run_total{result}` と `relay.d1.retention_deleted_rows` の emit 点）。
- 完了条件: agent / conversation timeline の cursor 順序を index 走査だけで支えられ、retention cron の成功・失敗・削除件数が observability へ出力される。
- 依存: なし。
- 検証: migration test、retention job test（成功時・失敗注入時それぞれで metric が増分することを確認）、EXPLAIN で想定 index が選ばれることの確認。
- 非対象: HTTP API ルーティング、summary 生成、DO mirror、alert rule 本設定（Unit 28）。
