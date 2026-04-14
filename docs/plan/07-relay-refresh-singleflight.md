# Unit 07 - Snapshot refresh single-flight と heartbeat 再取得
- 参照: docs/design/detailed/13-ui-relay-backend.md §5.1, §5.3, §6.2, §9
- 目的: world event / heartbeat 由来の snapshot 再取得を単調・再入可能にし、失敗中も quiet period refresh を止めない。
- 実装対象: refresh_in_flight / refresh_queued 制御、try/finally 解放、last_refresh_at 更新、失敗時の旧 snapshot 維持、heartbeat 再予約。
- 完了条件: 連打イベントや heartbeat 重複でも refresh は同時1本に保たれ、失敗後も次回試行が残る。
- 依存: Unit 04, Unit 05。
- 検証: single-flight テスト、queued rerun テスト、heartbeat failure 後の再試行テスト。
- 非対象: R2 throttle、setAlarm 最早時刻競合制御、`/ws` 再接続バックオフと再接続後の全面再構築。
