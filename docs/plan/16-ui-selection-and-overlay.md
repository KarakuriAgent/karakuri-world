# Unit 16 - エージェント選択と詳細オーバーレイ
- 参照: docs/design/detailed/15-ui-application-shell.md §7, §8.1, §9.2, docs/design/detailed/16-ui-map-view.md §4.4, §8
- 目的: 一覧・マップのどちらから選んでも同じ selected_agent_id へ収束し、詳細表示まで繋がる導線と、選択に追従する map focus 契約を成立させる。
- 実装対象: 選択アクション、Unit 18 の viewport bridge を使った selection-driven map focus（対象ノード中心への 300ms easing アニメーション、目標 zoom `1.6`、十分近い場合は pan のみ）、desktop overlay 開閉、mobile detail 遷移、`avatar` / `agent_name` / `status_emoji` を含む detail header、現在地 / 状態 / 行動の表示。
- 完了条件: 選択・再選択・解除の全パターンで map highlight と detail 表示が同期し、選択時の focus が設計どおり `300ms` / `1.6x` / pan-only fallback を満たす。
- 依存: Unit 14, Unit 15, Unit 18, Unit 20。
- 検証: interaction test、overlay open/close test、detail header field test（`avatar` / `agent_name` / `status_emoji`）、same-agent reselection test、selection focus contract test（animate 引数と pan-only 分岐の確認）。
- 非対象: conversation lazy fetch、append pagination。
