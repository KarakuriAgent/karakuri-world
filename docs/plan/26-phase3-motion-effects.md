# Unit 26 - 移動補間とアクション演出
- 参照: docs/design/detailed/17-ui-rollout.md §1.3, docs/design/detailed/16-ui-map-view.md §7.2
- 目的: movement.path / arrives_at / current_activity.emoji を使った動きの演出を追加する。
- 実装対象: 移動中座標補間、軽量アクションパーティクル、補間不能時の静的フォールバック、flag 制御。
- 完了条件: 補間追加後も snapshot の正本性を壊さず、補間不能ケースでは Phase 1 の静的表示へ戻せる。
- 依存: Unit 20, Unit 24。
- 検証: interpolation unit test、effect fallback test、performance smoke test。
- 非対象: 新規ゲームデータ追加、UI 向け WebSocket fan-out。
