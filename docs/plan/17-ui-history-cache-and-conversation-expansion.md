# Unit 17 - 履歴 cache と会話展開
- 参照: docs/design/detailed/15-ui-application-shell.md §8.2, §8.3, docs/design/detailed/14-ui-history-api.md §5.2, §5.3, §7, docs/design/detailed/17-ui-rollout.md §1.1
- 目的: agent 履歴と conversation 履歴を別 cache で保持し、lazy fetch と append pagination を共通 action で扱う。
- 実装対象: fetchHistory、HistoryScopeKey、30秒再取得条件、replace / append merge、重複排除、再試行ボタン、会話折りたたみ state。
- 完了条件: 直近20件の agent 履歴と直近50件の会話履歴を独立に読み込み、next_cursor で追加入力できる。
- 依存: Unit 11, Unit 16。
- 検証: cache merge unit test、append dedupe test、error preservation test、conversation expansion test。
- 非対象: 履歴タイムライン再生、304 キャッシュ最適化。
