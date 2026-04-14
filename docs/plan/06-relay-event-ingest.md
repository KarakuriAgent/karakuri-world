# Unit 06 - Relay event ingest と D1 原子的保存
- 参照: docs/design/detailed/13-ui-relay-backend.md §4.3, docs/design/detailed/14-ui-history-api.md §2, §4.1〜§4.5, §6
- 目的: /ws event を summary / payload / link 表へ一括保存し、agent / conversation 履歴の正本を構築する。
- 実装対象: world_events 行生成、world_event_agents role 正規化、world_event_conversations link、server_event_instances UPSERT、summary template と action emoji 解決。
- 完了条件: 1 event が 1 transaction で永続化され、partial write や role 重複が起きない。
- 依存: Unit 03, Unit 05, Unit 10。Unit 番号は識別子であり実装順序ではない。Unit 10 (D1 スキーマ) と Unit 05 (会話 mirror) の実装完了を前提とすること。
- 検証: D1 integration test（Unit 05 の実 mirror を使い、`conversation_turn_started` / `conversation_inactive_check` の participant 補完が mirror next state 経由で link 表に書き込まれることを確認する。mirror を mock する stub テストは不可）、role 優先順位テスト、server_event_fired の畳み込みテスト、summary テンプレートテスト。
- 非対象: snapshot refresh / publish、API クエリ処理。
