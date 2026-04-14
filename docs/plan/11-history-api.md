# Unit 11 - GET /api/history クエリ層
- 参照: docs/design/detailed/13-ui-relay-backend.md §7, docs/design/detailed/14-ui-history-api.md §5, §7
- 目的: agent / conversation scope を切り替える公開 API を実装し、cursor pagination を安定提供する。
- 実装対象: query union 正規化、invalid_request / invalid_cursor バリデーション、cursor encode/decode、limit 上限、response shaping、`HistoryEntry.detail` を `PersistedSpectatorEvent`（Unit 03 の union）と互換な形で返す（レスポンス型上は `detail: Record<string, unknown>` を維持しつつ、内部的には sanitized payload を parse し直さずそのまま object として載せる）、`HistoryEntry.type` を `PersistedEventType` literal union に narrow し、UI 側が後段で再 runtime guard を書かなくて済む型公開。
- 完了条件: agent_id と conversation_id の排他条件、types フィルタ、next_cursor 発行が仕様どおり動く。`HistoryEntry.type` が union literal として公開され、`detail` の allowlist が Unit 03 の `PersistedSpectatorEvent` と一致する。
- 依存: Unit 03, Unit 10。
- 検証: route test、cursor round-trip test、append pagination test、types filter test、`detail` allowlist が Unit 03 の `PersistedSpectatorEvent` と一致することを型レベル + スナップショットで確認する test。
- 非対象: UI 側 cache merge、会話展開 UI。
