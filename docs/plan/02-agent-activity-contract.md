# Unit 02 - Agent / Action 公開契約
- 参照: docs/design/detailed/12-spectator-snapshot.md §2.2, §2.3, §3.1, §4.2, §4.3, §5.2
- 目的: UI が追加推論せず描画できるよう、エージェント活動・会話参照・絵文字解決の契約を確定する。
- 作業リポジトリ: **本体リポジトリ** 側で `AgentSnapshot` への `discord_bot_avatar_url` / `status_emoji` / `current_conversation_id` 追加と `ActionConfigBase.emoji` 追加、**UI 中継リポジトリ** 側で `SpectatorAgentActivity` 型定義と `current_activity.label` 算出。
- 実装対象: 本体側 `src/types/snapshot.ts` `AgentSnapshot` への `discord_bot_avatar_url?` / `status_emoji` / `current_conversation_id?` 追加、本体側 `getSnapshot()` が `discord_bot_avatar_url` を登録データから引いて返すこと、本体側 `src/types/data-model.ts` `ActionConfigBase.emoji?` 追加、UI 中継側 `AgentActivitySnapshot` / `SpectatorAgentActivity` 変換入力、status_emoji 優先順位、current_activity.label 算出、ActionConfigBase.emoji の参照経路。
- 完了条件: action / wait / item_use の3分岐で UI 必須情報が欠けず、item_use.duration_ms 省略可を型で表現でき、本体変更がマージ・デプロイ済みであること。
- 依存: Unit 01。
- 検証: status_emoji 優先順位テスト、current_activity.label テスト、item_use の optional duration_ms テスト、本体 `getSnapshot()` が `discord_bot_avatar_url` を含むテスト。
- 非対象: WorldSnapshot から SpectatorSnapshot への全体変換、イベント永続化。
