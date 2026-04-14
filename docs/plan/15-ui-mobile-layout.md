# Unit 15 - モバイルレイアウト
- 参照: docs/design/detailed/15-ui-application-shell.md §6, §9.1, §10, docs/design/detailed/17-ui-rollout.md §1.1, §3.2
- 目的: 1023px 以下で full-screen map + top badge + 3段階 bottom sheet を成立させる。
- 実装対象: peek / list / detail モード、peek でのエージェント数・進行中イベント数サマリ、list での直近サーバーイベント + エージェント一覧（desktop 同等の並び順）、safe area 対応 top badge、snapshot stale / fetch error 表示、sheet snap、detail close 時の selected_agent_id 解除。
- 完了条件: モバイルで snapshot stale / fetch error 表示と上部バッジ・detail が safe area を崩さず同時成立し、detail を閉じた直後に再オープンしない。
- 依存: Unit 13。
- 検証: viewport 1023px 以下の interaction test、peek がエージェント数・進行中イベント数サマリを表示する test、list が直近サーバーイベントと desktop 同等順のエージェント一覧を表示する test、snapshot stale / fetch error と top badge の共存確認、sheet mode transition test、selected_agent_id reset test。
- 非対象: マップ自体の描画実装、会話 history lazy fetch。
