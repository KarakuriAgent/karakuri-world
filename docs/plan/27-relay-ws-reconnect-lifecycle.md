# Unit 27 - Relay `/ws` 再接続ライフサイクル
- 参照: docs/design/detailed/13-ui-relay-backend.md §3.1, §6.1, §6.2, §9, docs/design/detailed/17-ui-rollout.md §3.1
- 目的: `/ws` 切断時も relay の freshness を止めず、指数バックオフ再接続と再接続後の state rebuild を独立に完了させる。
- Phase 分類: **optional relay hardening**。Unit 29 で current-state の primary path は fixed-cadence polling + R2/CDN 配信へ切り替わったため、本 Unit は Phase 1 launch blocker ではない。Unit 21 の必須受入条件は本 Unit に依存せず、relay `/ws` を残す配備でのみ Unit 32 と合わせて追加検証する。
- 実装対象: `reconnect_attempt` の管理、指数バックオフ + ±20% jitter、close / error / idle ごとの切断処理、切断中も R2 snapshot と heartbeat alarm を維持する不変条件、再接続成功時の attempt reset、再接続後初回 `snapshot` による `latest_snapshot` / `conversations` の全面再構築、`disconnect_started_at` の記録と再接続成功時の `relay.ws.connect_duration_ms` / `relay.ws.event_gap_ms` emit、upgrade ハンドシェイク HTTP ステータスから `handshake_status` label を算出して `relay.ws.disconnect_total{handshake_status}` に付与、切断期間の warn ログ出力。
- 完了条件: `/ws` 切断後に backoff 上限 30 秒で再接続を継続し、**primary path 側では relay 切断と無関係に** fixed-cadence publish により `generated_at` / `published_at` が進み続ける。relay を有効化した配備では、再接続後初回 `snapshot` で optional mirror / in-memory state が正本へ戻る。`auth_rejected` 系の持続切断が `handshake_status` で区別でき、切断期間が metric / ログに常に出力される。
- 依存: Unit 04, Unit 05, Unit 07, Unit 08。primary path の前提として Unit 29、optional relay の再配置・比較検証として Unit 32 を参照する。
- 検証: backoff+jitter unit test、disconnect invariant test、reconnect attempt reset test、post-reconnect snapshot rebuild test、`handshake_status` label 分岐テスト、`connect_duration_ms` / `event_gap_ms` emit テスト、**relay enabled / disabled 比較込みの** backend reconnect acceptance test。
- 非対象: UI の stale バッジ表示詳細、Access 配備条件、history API UX。
