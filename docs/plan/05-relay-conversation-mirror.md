# Unit 05 - DO 会話状態ミラー
- 注記: Unit 29 以降では current-state UI の launch は polling + R2/CDN primary path だけで成立するため、この Unit は **optional relay / history 補助を有効化する配備向けの additive backend work** として扱う。primary readiness は Unit 29〜31、relay の位置づけ変更は Unit 32 を参照。
- 参照: docs/design/detailed/13-ui-relay-backend.md §3.3, docs/design/detailed/14-ui-history-api.md §4.2.1
- 目的: conversation_turn_started / conversation_inactive_check でも正しい参加者集合を引ける authoritative mirror を実装する。
- 実装対象: snapshot 由来の全面再構築、event 適用前後の next state 生成、D1 成功後 commit、conversation_rejected / conversation_ended teardown。
- 完了条件: payload に参加者一覧がない会話イベントでも link 解決が mirror だけで再現できる。
- 依存: Unit 04。
- 検証: 会話イベント列に対する state transition テスト、D1 失敗時に mirror を巻き戻すテスト、snapshot 再同期テスト。
- 非対象: 実際の D1 書き込み内容、履歴 API。
