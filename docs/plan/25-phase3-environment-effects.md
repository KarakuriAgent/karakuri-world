# Unit 25 - 天気 / 昼夜演出
- 参照: docs/design/detailed/17-ui-rollout.md §1.3, docs/design/detailed/16-ui-map-view.md §7.2
- 目的: weather と calendar.local_time を使った環境演出を EffectLayer に追加する。
- 実装対象: 雨・雪・霧エフェクト、昼夜フィルタ、flag ごとの段階投入、描画負荷上限の確認。
- 完了条件: 既存 UI 情報を隠さずに環境演出を重ねられ、flag 単位で個別に切り戻せる。
- 依存: Unit 24。
- 検証: visual regression test、flag 切替 test、performance smoke test。
- 非対象: 移動補間、アクションパーティクル。
