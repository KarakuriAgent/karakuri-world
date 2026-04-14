# Unit 24 - EffectLayer 基盤と feature flag
- 参照: docs/design/detailed/17-ui-rollout.md §1.3, §2, docs/design/detailed/16-ui-map-view.md §2, §7.2
- 目的: Phase 1/2 を壊さず演出を段階投入できる EffectLayer の受け皿を先に用意する。
- 実装対象: EffectLayer の空実装、feature flag、default-off 時の no-op 配線、render order 固定。
- 完了条件: flag 無効時に Phase 1 描画結果が変わらず、以後の演出追加先が固定される。
- 依存: Unit 18〜20, Unit 21。
- 検証: feature flag off/on smoke test、layer order test、回帰比較テスト。
- 非対象: 個別演出そのもの。
