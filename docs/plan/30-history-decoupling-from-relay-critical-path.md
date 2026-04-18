# Unit 30 - History API の relay 非依存化整理
- 参照: docs/design/detailed/13-ui-relay-backend.md §3.3, §4.3, §7, docs/design/detailed/14-ui-history-api.md, docs/design/detailed/15-ui-application-shell.md §8.3, §10
- 目的: `/api/history` を current-state snapshot 配信の critical path から切り離し、relay `/ws` の有無や遅延が detail overlay の補助品質へ閉じるよう責務を整理する。
- 実装対象: map / sidebar / mobile summary は `snapshot_url` だけで成立することの再確認、history 欠落時の UX（empty / retry / degraded messaging）整理、relay ingest 失敗や切断時の gap 許容範囲、Phase 1 では populated history を必須 gate にしない整理、`conversation_mirror` / backfill/import source を追加できる抽象境界の明文化。
- 完了条件: relay `/ws` や history ingest が不安定でも current-state UI の受け入れ条件が変わらず、`/api/history` が empty でも history 欠落は overlay / detail だけの degraded mode として説明できる。Phase 1 の必須条件は current-state UI と polling freshness に留め、populated history は non-relay ingest/backfill を別途定義した後の追加最適化として扱う。ingest 実装は Durable Object 必須ではなく、`/api/history` の鮮度改善は別最適化タスクとして独立する。
- 依存: Unit 11, Unit 14, Unit 15, Unit 21, Unit 29。
- 検証: overlay degraded-state review、history retry UX review、relay history gap scenario review、design/doc review。
- 非対象: 新しい history transport 実装、timeline replay UI。
