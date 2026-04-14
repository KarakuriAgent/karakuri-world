# Unit 18 - MapViewportHost スパイクと bridge
- 参照: docs/design/detailed/16-ui-map-view.md §2.1, §4, §10
- 目的: @pixi/react と pixi-viewport の境界を MapViewportHost に閉じ込め、wheel / drag / pinch / tap を両立させ、設計どおりの初期 framing / zoom 制約を担保する。
- 実装対象: imperative Viewport 生成、events 接続、初回 `fitWorld()` framing（24px margin）、zoom range clamp（`0.5`〜`3.0`）、pan 開始 4px threshold による micro-drag と click / tap の両立、createPortal、context 共有、destroy / resize 後始末。
- 完了条件: 最小マップで wheel / drag / tap が同時成立し、4px 未満の微小ドラッグでは click / tap が優先され、初回表示で map 全体が 24px margin 付きで収まり、zoom が `0.5`〜`3.0` に制限されたまま再マウント無しで viewport を使い回せる。
- 依存: Unit 12。
- 検証: スパイク用 smoke test、初回 `fitWorld()` が 24px margin 付きで呼ばれる test、min/max zoom clamp test、4px threshold を含む pointer interaction test、unmount cleanup test。
- 非対象: グリッド / エージェント描画詳細、選択 UI 本実装。
