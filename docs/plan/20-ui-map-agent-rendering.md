# Unit 20 - AgentLayer / SelectionLayer
- 参照: docs/design/detailed/16-ui-map-view.md §5, §7.1, §8, §9, docs/design/detailed/15-ui-application-shell.md §7
- 目的: エージェント単体表示・グループ表示・選択ハイライトを Phase 1 要件どおり描画する。
- 実装対象: avatar sprite、fallback placeholder、status_emoji overlay、group badge / popover、selection ring、texture cache。
- 完了条件: 1ノード複数エージェント時も group 表示で選択導線が切れず、一覧選択と双方向同期する。
- 依存: Unit 02, Unit 18, Unit 19。
- 検証: single/group render test、selection sync test、avatar fallback test、texture cache test。
- 非対象: weather / day-night / movement interpolation。
