# Unit 19 - GridLayer / LabelLayer
- 参照: docs/design/detailed/16-ui-map-view.md §1, §2, §3, §6, §7.1
- 目的: map と map_render_theme だけを使って Discord 相当のグリッドとラベルをブラウザ描画する。
- 実装対象: 背景 fill、セル背景、建物 palette、ノード ID、中央ラベル、色・フォントサイズの theme 反映。
- 完了条件: UI 側に背景色・文字サイズのハードコードが残らず、同一 snapshot で安定描画できる。
- 依存: Unit 01, Unit 18。
- 検証: render snapshot test、theme mapping test、座標変換テスト。
- 非対象: アバター、グループ表示、選択ハイライト。
