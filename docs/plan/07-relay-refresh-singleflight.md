# Unit 07 - Snapshot refresh single-flight と heartbeat 再取得
- 注記: Unit 29 で current-state primary path が fixed-cadence polling + R2/CDN publish に移ったため、この Unit は **optional relay / legacy heartbeat 補助を有効化する配備向けの historical hardening** として扱う。launch readiness の主判定は Unit 29〜31 を参照。
- 参照: docs/design/detailed/13-ui-relay-backend.md §2, §3.1, §4.1, §4.2, §6.2, docs/plan/29-polling-r2-primary-architecture.md, docs/plan/32-optional-relay-ws-accelerator.md
- 目的: world event / heartbeat 由来の snapshot 再取得を単調・再入可能にし、失敗中も quiet period refresh を止めない。
- 実装対象: refresh_in_flight / refresh_queued 制御、try/finally 解放、last_refresh_at 更新、失敗時の旧 snapshot 維持、heartbeat 再予約。
- 完了条件: 連打イベントや heartbeat 重複でも refresh は同時1本に保たれ、失敗後も次回試行が残る。
- 依存: Unit 04, Unit 05。
- 検証: single-flight テスト、queued rerun テスト、heartbeat failure 後の再試行テスト。
- 非対象: primary-path readiness 判定、R2/CDN cadence 設計そのもの（Unit 29/31）、setAlarm 最早時刻競合制御、`/ws` 再接続バックオフと再接続後の全面再構築。
