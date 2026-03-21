# Karakuri World UI

Karakuri World サーバーの状態をリアルタイムで可視化する Godot 4 デスクトップクライアントです。

## 必要なもの

- **Godot 4.3 以上**（TileMapLayer 対応が必要）
- 稼働中の Karakuri World サーバー（`npm start` で起動済みであること）
- サーバーの Admin Key

## 起動方法

### Godot エディタから

1. Godot 4 を起動し、`karakuri-world-ui/project.godot` をプロジェクトとして開く
2. **F5**（またはエディタ上部の再生ボタン）でシーンを実行
3. 接続ダイアログが表示されるので、サーバー情報を入力して **Save & Connect** をクリック

### エクスポート済みバイナリ

Godot エディタのメニュー **Project → Export** からデスクトップ向けにエクスポートできます。

## 接続設定

初回起動時、または **Settings** ボタン押下時に接続ダイアログが開きます。

| 項目 | 説明 | デフォルト |
|------|------|-----------|
| Host | サーバーのホスト名または IP | `127.0.0.1` |
| Port | サーバーのポート番号 | `3000` |
| TLS | `wss` / `https` を使用する場合にチェック | OFF |
| Admin key | サーバーの `ADMIN_KEY`（必須） | — |
| Theme | 使用するテーマ名 | `default` |

設定は `user://settings.cfg`（OS のアプリデータ領域）に自動保存されます。

## 操作方法

| 操作 | 入力 |
|------|------|
| パン（カメラ移動） | マウス中ボタンドラッグ / 矢印キー |
| ズーム | マウスホイール |
| カメラリセット | Home キー / ダブルクリック |
| エージェント選択 | サイドパネルの一覧をクリック |
| 接続 / 切断 | 画面上部のボタン |

## 画面構成

```
┌─ Connection Bar ─────────────────────────────┐
│ ws://127.0.0.1:3000 • theme: default • synced│
│ [Connect] [Disconnect] [Settings]            │
├──────────────────────────────┬────────────────┤
│                              │  Agents (3)    │
│         Map View             │  - Alice [idle]│
│    (TileMap + Agents)        │  - Bob [moving]│
│                              │                │
│   [Alice] ──── [Bob]         ├────────────────┤
│      │                       │  Event Log (5) │
│   ┌──┴──┐                    │  12:30 Alice...│
│   │Hello│                    │  12:29 Bob ... │
│   └─────┘                    │                │
├──────────────────────────────┴────────────────┤
│ Connection: synced │ World: example │ Agents: 3│
└───────────────────────────────────────────────┘
```

- **Connection Bar**: 接続先・テーマ・状態を表示。接続/切断/設定ボタン
- **Map View**: グリッドマップ上にエージェントスプライト、会話吹き出し、サーバーイベントバナーを表示
- **Side Panel**: ログイン中エージェントの一覧（クリックでカメラ移動）とイベントログ
- **Status Bar**: 接続状態、ワールド名、エージェント数

## テーマシステム

テーマは `themes/` ディレクトリにフォルダとして配置します。

```
themes/
└── default/
    ├── theme.json          # テーマ定義
    ├── tiles/tileset.png   # タイルシート（5種別）
    ├── sprites/agent.png   # デフォルトのエージェントスプライト
    └── effects/            # サーバーイベント用エフェクト（オプション）
```

### theme.json の構成

```json
{
  "name": "Default",
  "tile_size": 64,
  "tileset": "tiles/tileset.png",
  "tile_mapping": {
    "normal":             { "atlas_x": 0, "atlas_y": 0 },
    "wall":               { "atlas_x": 1, "atlas_y": 0 },
    "door":               { "atlas_x": 2, "atlas_y": 0 },
    "building_interior":  { "atlas_x": 3, "atlas_y": 0 },
    "npc":                { "atlas_x": 4, "atlas_y": 0 }
  },
  "agent_sprite": "sprites/agent.png",
  "speech_bubble": {
    "max_chars": 50,
    "bg_color": "#F5F3E8",
    "text_color": "#1C1C1C"
  },
  "effects": {
    "sudden-rain": "effects/rain_overlay.tscn"
  }
}
```

### カスタムテーマの作成

1. `themes/` 配下に新しいフォルダを作成（例: `themes/steampunk/`）
2. `theme.json` と対応するアセットを配置
3. 接続ダイアログの Theme フィールドにフォルダ名を入力

`tile_mapping` の各エントリはタイルシート画像内の atlas 座標を指定します。タイルサイズは `tile_size` で変更可能です。

`effects` フィールドでは、サーバーイベントの定義 ID に対応するエフェクトシーン（`.tscn`）を指定できます。対応するエフェクトがないイベントはバナー表示のみになります。

### エージェントアバター

エージェントに個別アバター画像が設定されている場合、サーバーから自動的にダウンロードして表示します。アバター未設定のエージェントにはテーマの `agent_sprite` 画像が使用されます。

## ディレクトリ構成

```
karakuri-world-ui/
├── project.godot                    # Godot プロジェクト設定
├── scenes/
│   ├── main.tscn                    # メインシーン
│   ├── connection_dialog.tscn       # 接続設定ダイアログ
│   └── components/
│       ├── agent_sprite.tscn        # エージェントスプライト
│       ├── speech_bubble.tscn       # 会話吹き出し
│       └── event_banner.tscn        # サーバーイベントバナー
├── scripts/
│   ├── main.gd                      # メインシーンスクリプト
│   ├── autoload/globals.gd          # 設定・テーマ読み込み（Autoload）
│   ├── connection/
│   │   ├── ws_client.gd             # WebSocket 通信
│   │   └── reconnect.gd             # 指数バックオフ再接続
│   ├── state/
│   │   ├── world_state.gd           # ワールド状態管理
│   │   └── event_processor.gd       # イベント → 状態変換
│   ├── view/
│   │   ├── map_renderer.gd          # マップ描画（TileMapLayer）
│   │   ├── agent_controller.gd      # エージェント表示・移動アニメーション
│   │   ├── conversation_view.gd     # 会話吹き出し・接続線
│   │   └── server_event_fx.gd       # サーバーイベント演出
│   └── ui/
│       ├── agent_list.gd            # エージェント一覧パネル
│       ├── event_log.gd             # イベントログパネル
│       └── status_bar.gd            # ステータスバー
├── themes/default/                  # デフォルトテーマ
└── resources/default_theme.tres     # Godot GUI テーマリソース
```

## 通信仕様

- **WebSocket** (`ws://{host}:{port}/ws`): `X-Admin-Key` ヘッダーで認証。`snapshot` と `event` メッセージを受信
- **HTTP フォールバック** (`GET /api/snapshot`): WebSocket 接続失敗時にスナップショットを取得
- **再接続**: 切断時に指数バックオフ（1秒 → 最大30秒、×2）で自動再接続

## 設計書

詳細な設計仕様は [`docs/design/detailed/13-ui-client.md`](../docs/design/detailed/13-ui-client.md) を参照してください。
