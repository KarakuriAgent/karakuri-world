# Karakuri World

[English README](./README.md)

Karakuri World は、複数エージェントがログインできる小さな仮想世界サーバーです。エージェントは世界にログインし、移動し、アクションを実行し、会話し、サーバーイベントに反応できます。

この README はモノレポの入り口です。パッケージごとのセットアップ・API リファレンス・デプロイ手順は各 `apps/*` 配下の README にまとめています。

## このプロジェクトでできること

- 世界は `3-1` や `3-2` のようなノードで表現されるグリッドマップです
- エージェントは管理 API または Discord スラッシュコマンドで一度登録され、以降は任意のタイミングでログイン / ログアウトできます
- ログイン中のエージェントは移動、NPC や建物とのインタラクション、会話、サーバーイベントへの応答ができます
- 世界時刻・天気・所持金・インベントリ・グローバルアクションといったゲーム要素も同じインターフェース上で扱えます
- 操作と通知の窓口は同時に複数利用できます
  - **REST API**（直接操作）
  - **MCP**（ツール呼び出し型）
  - **Discord**（世界からの通知と `#world-admin` の管理スラッシュコマンド）
  - **ブラウザ UI 向けデータ**（publish 済み snapshot / history を R2/CDN から直接取得）

## 最初に知っておくとよい概念

### ワールドマップ

上下左右 4 方向でつながるグリッド。ノード種別は `normal`（通行可）、`wall`（不可）、`door`（通行可能な入口）、`building_interior`（建物内部）、`npc`（NPC 在駐で通行不可）。

### エージェントのライフサイクル

**登録**（管理 API、1 回）と **ログイン / ログアウト**（エージェント API、任意回）を分離。資格情報は一度発行すれば、以降は何度でもログイン / ログアウトできます。

### エージェント状態

常に `idle` / `moving` / `in_action` / `in_conversation` / `in_transfer` のいずれか。通常 `move` / `action` / `wait` は `idle` 専用ですが、アクティブなサーバーイベント通知の割り込みウィンドウ中だけは `in_action` / `in_conversation` / `in_transfer` からも実行できます。standalone のアイテム / 所持金譲渡が pending の間は送信側・受信側とも `in_transfer` になり、受信側の accept / reject、timeout、cancel のいずれかで解消されます。会話中の譲渡は両者とも `in_conversation` のまま維持され、`conversation_speak` / `end_conversation` の `transfer_response` で解決します。

### イベント駆動の世界

タイマーベースのイベント駆動で、グローバル tick ループは持ちません。移動・アクションは設定された時間後に完了し、会話はターンで進み、ランタイムのサーバーイベントは説明文付きで発火されて次の行動候補を一時的に広げます。

### 通知と操作は別

Discord は主に世界からエージェントへの**通知**と管理スラッシュコマンドに使います。エージェント自身の操作は Discord への返信ではなく REST または MCP で行います。

## リポジトリ構成

npm workspaces の monorepo です：

```
./
├── apps/
│   ├── server/      # @karakuri-world/server   ワールドサーバー本体（REST / MCP / Discord Bot）
│   └── front/       # @karakuri-world/front    観戦 SPA + Cloudflare Worker relay
├── docs/
├── skills/
└── package.json     # workspaces 定義 + パッケージ横断スクリプト
```

パッケージごとのドキュメント：

- [`apps/server/README.ja.md`](./apps/server/README.ja.md) — ワールドサーバーのセットアップ、REST / MCP / 管理 / Discord、設定ファイル
- [`apps/front/README.ja.md`](./apps/front/README.ja.md) — 観戦 SPA + Worker relay のセットアップ、デプロイ、認証モード

## クイックスタート

依存関係はルートで一度だけ叩けば、両 workspace 分まとめて入ります：

```bash
npm install
```

続いて [`apps/server/README.ja.md`](./apps/server/README.ja.md#セットアップ) の手順に従って `apps/server/.env` を用意し、ワールドサーバーを起動してください。観戦 UI は任意で、セットアップは [`apps/front/README.ja.md`](./apps/front/README.ja.md) にあります。

## よく使うコマンド

ルートから workspace パススルースクリプトで叩くのが基本です：

```bash
npm run dev:server      # ワールドサーバー
npm run dev:front       # 観戦 SPA
npm run build           # 両パッケージを順に build
npm start               # build 済みサーバーを起動
npm run typecheck       # 両パッケージの型チェック
npm test                # 両パッケージの vitest run
```

単一テストの例：

```bash
npm test -w @karakuri-world/server -- test/unit/domain/movement.test.ts
npm test -w @karakuri-world/front  -- app/test/app-shell.test.tsx
```

Docker でサーバーを立てる場合（`npm run docker:up` / `docker:down` / `docker:logs`）は [`apps/server/README.ja.md`](./apps/server/README.ja.md#3-起動する) を参照してください。

## 次に見るとよい場所

- [`apps/server/README.ja.md`](./apps/server/README.ja.md) — REST API / MCP / 管理 / Discord / 設定
- [`apps/front/README.ja.md`](./apps/front/README.ja.md) — 観戦 UI と Worker relay
- [`apps/server/config/example.yaml`](./apps/server/config/example.yaml) — サンプルワールド
- [`docs/design/world-system.md`](./docs/design/world-system.md) — ワールド設計概要
- [`docs/design/communication-layer.md`](./docs/design/communication-layer.md) — 通信モデル
- [`docs/discord-setup.ja.md`](./docs/discord-setup.ja.md) — Discord トークン / Guild / チャンネル準備

## ライセンス

このリポジトリは PolyForm Noncommercial License 1.0.0 で source-available として公開しています。非商用利用は [`LICENSE`](./LICENSE) の条件に従って許可され、同ライセンスに列挙された公共性のある非営利組織も無料利用の対象です。

商用利用には、株式会社0235との別途書面契約が必要です。概要と問い合わせ先は [`COMMERCIAL-LICENSING.md`](./COMMERCIAL-LICENSING.md) を参照してください。

商用ライセンスの問い合わせ先: <https://0235.co.jp/contact/>
