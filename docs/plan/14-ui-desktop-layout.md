# Unit 14 - デスクトップレイアウト
- 参照: docs/design/detailed/15-ui-application-shell.md §5, §9.1, §10, docs/design/detailed/17-ui-rollout.md §1.1, §3.2
- 目的: lg 以上で sidebar + map + overlay の基本観戦導線を成立させる。
- 実装対象: 320px sidebar、360px overlay、header / recent server events / agent list、`recent_server_events` 表示と `snapshot.server_events` による active / outstanding 判定の責務分離、stale / fetch error 表示、agent sort。
- 完了条件: 選択前は sidebar + map、選択後は overlay 追加の2状態が崩れずに成立し、サーバーイベント表示が `recent_server_events` と active / outstanding 判定で設計どおりに分離される。
- 依存: Unit 13。
- 検証: viewport 1024px 以上の component test、サーバーイベント表示 / active 判定の責務分離テスト、エージェント並び順テスト、空状態表示テスト。
- 非対象: モバイル bottom sheet、会話履歴展開。
