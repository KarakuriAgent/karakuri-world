# Unit 04 - Relay Worker / DO 起動基盤
- 参照: docs/design/detailed/13-ui-relay-backend.md §1, §2, §3.1, §3.2
- 目的: UI 中継バックエンドの最小起動経路を作り、singleton DO・環境変数・初回 WebSocket 接続を成立させる。
- 実装対象: env 解析、KW_BASE_URL からの /ws /api/snapshot URL 導出、DO singleton 化、cold start 時の recent_server_events 復元、初回 snapshot 受信後の内部状態初期化。
- 完了条件: 正常な env で DO が boot し、初回 snapshot 受信後に latest_snapshot 未設定状態を脱する。
- 依存: Unit 01〜03。本体リポジトリ側の `WorldSnapshot` / `AgentSnapshot` / `ActionConfigBase` 拡張（Unit 01 / Unit 02）は relay 起動前にマージ・デプロイ済みであることを前提とする。
- 検証: env バリデーションテスト、URL 導出テスト、cold start 復元テスト、boot smoke test。
- 非対象: 会話ミラー staged update、D1 ingest、R2 publish。
