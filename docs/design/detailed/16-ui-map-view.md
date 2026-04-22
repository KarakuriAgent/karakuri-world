# 16 - UI マップ描画

## 1. 描画方針

マップ描画は `map` と `map_render_theme` を正本にし、Discord の `apps/server/src/discord/map-renderer.ts` と同じ色・ラベル規則をブラウザで再現する。ここで使う `map` は 12-spectator-snapshot.md で定義した `SpectatorMapSnapshot` であり、`BuildingConfig.actions` / `NpcConfig.actions` のような内部アクション設定は含まない。

## 2. Pixi レイヤー構成

```txt
Application
└─ Viewport
   ├─ GridLayer
   ├─ LabelLayer
   ├─ AgentLayer
   ├─ SelectionLayer
   └─ EffectLayer
```

- `GridLayer`: 背景 fill、セル背景、建物色、枠線
- `LabelLayer`: ノード ID、ノードラベル
- `AgentLayer`: アバター、状態絵文字、グループ表示
- `SelectionLayer`: 選択エージェントのハイライト
- `EffectLayer`: 将来の天気・昼夜・アクション演出

### 2.1 `pixi-viewport` 統合方針

overview で懸念されている `pixi-viewport` + `@pixi/react` v8 の既知問題（イベントシステム受け渡し）について、本詳細設計では以下の bridge 方式を採用して解消する。

1. `@pixi/react` は `<Application>` と通常レイヤーの React ライフサイクル管理に使う
2. `Viewport` 自体は JSX の intrinsic element として直接扱わず、`MapViewportHost` で `new Viewport(...)` を imperative に生成する
3. 生成時に `events: app.renderer.events` を明示的に渡し、wheel / drag / pinch などの federated events を `Viewport` 側へ接続する
4. `Viewport` は `app.stage.addChild(viewport)` で stage に追加し、レイヤー群は `createPortal(..., viewport)` でぶら下げる
5. `Viewport` インスタンスは React context で共有し、選択時の `animate()`・`fitWorld()`・`resize()` は hook から imperative に呼ぶ

この構成では `@pixi/react` v8 と `pixi-viewport` の境界を `MapViewportHost` に閉じ込められるため、通常の `Container` / `Sprite` / `Graphics` は React 側から継続利用できる。したがって、本件は「未解決 blocker」ではなく「bridge 実装を前提に着手可能」と判断する。

## 3. 座標系

### 3.1 セル座標

```typescript
const x = (col - 1) * map_render_theme.cell_size;
const y = (row - 1) * map_render_theme.cell_size;
const centerX = x + map_render_theme.cell_size / 2;
const centerY = y + map_render_theme.cell_size / 2;
```

### 3.2 スプライトサイズ

- エージェントアバター: `cell_size * 0.58`
- 状態絵文字フォントサイズ: `cell_size * 0.22`
- グループ人数バッジ: `cell_size * 0.18`

## 4. ビューポート

### 4.1 初期表示

- マップ全体が収まるよう `viewport.fitWorld()` 相当で初期化する
- 余白は 24px
- 初期化は `MapViewportHost` mount 完了後に 1 回だけ実行する

### 4.2 操作

| 操作 | 動作 |
|------|------|
| マウスホイール | ズーム |
| ドラッグ | パン |
| ピンチ | ズーム |
| タップ / クリック | エージェント選択 |

`Viewport` には `drag()`, `wheel()`, `pinch()`, `decelerate()` を適用し、エージェント Sprite 側は `eventMode: 'static'` を使って選択イベントを受ける。パン開始しきい値を 4px とし、微小ドラッグでは click/tap を優先する。

### 4.3 ズーム範囲

- 最小: `0.5`
- 最大: `3.0`

### 4.4 フォーカス移動

エージェント選択時は対象ノード中心へ 300ms の easing 付きアニメーションで移動し、ズーム倍率 `1.6` を目標にする。既に十分近い場合はパンのみ行う。

`animate()` 呼び出しは `Viewport` ref を通じて行い、React state には進行中アニメーションそのものを持たない。

## 5. エージェント描画

### 5.1 単体表示

1 ノードに 1 体のみ存在する場合:

1. 現行 Phase 1 では `discord_bot_avatar_url` を Sprite として描画する
2. 右上に `status_emoji` を重ねる
3. 選択中は外周リングを表示する

将来 overview 6.5 の UI 独自アイコンが `SpectatorSnapshot` に追加された場合はそれを優先し、未指定時のみ `discord_bot_avatar_url` を使う。画像取得失敗またはアイコン未指定時は単色の円形プレースホルダーと頭文字 1 文字で代替する。

### 5.2 グループ表示

同一ノードに 2 体以上いる場合は `AgentGroup` でまとめる。

- 最大 3 枚の重なりアバターを表示
- 右下に人数バッジを表示（例: `2`, `5`）
- タップ時はそのノードにいるエージェント一覧ポップオーバーを開く

グループを展開してもマップ上で物理的に散らさない。選択対象の確定だけを行う。

## 6. ラベル描画

- ルート背景は `map_render_theme.background_fill` を使い、UI 側で別色をハードコードしない
- ノード ID は各セル左上に固定表示し、フォントサイズは `map_render_theme.node_id_font_size` を使う
- `node.label` がある場合のみ中央に表示し、フォントサイズは `map_render_theme.label_font_size` を使う
- 壁セルの文字色は `map_render_theme.wall_text_color`
- それ以外は `map_render_theme.default_text_color`

## 7. 初期実装と将来演出

### 7.1 初期実装

- グリッド・建物・ノードラベル
- エージェントアバター
- `status_emoji`
- グループ化
- 選択ハイライト

### 7.2 第 2 段階

- 雨・雪・霧を `EffectLayer` に追加
- `calendar` と `local_time` に応じた昼夜フィルタ
- `movement.path` と `arrives_at` を使った座標補間
- `current_activity.emoji` に応じた軽量パーティクル

初期実装では移動中エージェントも snapshot 上の `node_id` に静的表示する。補間は後続段階で追加する。

## 8. 選択との同期

- 一覧から選択された `selected_agent_id` を監視し、対象 Sprite をハイライトする
- マップ上で選択した場合も同じ store を更新し、一方向同期にしない
- 会話中エージェントを選択しても会話参加者全体のハイライトは行わない

## 9. パフォーマンス要件

- 100 エージェント規模で 60fps を目標とする
- エージェント Sprite は再生成せず position 更新中心にする
- ラベルは snapshot 更新時のみ再描画する
- アバター Texture は URL ごとにキャッシュする

## 10. 実装メモ

- `Viewport` 破棄時は plugin と event listener を含めて `destroy()` する
- リサイズ時は `viewport.resize(screenWidth, screenHeight, worldWidth, worldHeight)` を呼ぶ
- 実装開始時に確認するスパイクは 1 つだけでよい: wheel / drag / tap が同時に成立する最小 `MapViewportHost` を作り、成立後に本レイヤーへ展開する
