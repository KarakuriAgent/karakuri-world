# 実装計画: マップエディタ + UI認証

## スコープ

- サーバー側実装（TypeScript）のみ。UIクライアント（Godot）は対象外
- 設計書: 08-rest-api.md §7、12-map-editor.md

## Phase 1: UI向けAPI認証の追加

`GET /api/snapshot` と `GET /ws` に `adminAuth` ミドルウェアを追加する。

### 変更ファイル

- `src/api/routes/ui.ts`: `adminAuth` 適用、引数に `options: { adminKey }` 追加
- `src/api/app.ts`: `registerUiRoutes` に `options` を渡す、`/ws` の `upgradeWebSocket` 前に `adminAuth` を挟む

### テスト修正

認証ヘッダー追加が必要なテスト:
- `test/integration/api.test.ts`
- `test/integration/websocket.test.ts`
- `test/integration/movement.test.ts`

各ファイルに認証なし401テストも追加。

## Phase 2: バリデーション基盤の整備

### Step 2-1: 既存バリデーションの設計差分を埋める

`src/config/validation.ts` の `collectValidationIssues` に 01-data-model.md §3.2, §4.2 の全制約を実装する。既存コードとの差分を洗い出し、不足分をすべて追加する（`action_id` 一意性は既に検証済み）。

### Step 2-2: 共通helperの作成

`src/config/index.ts` に共有関数を追加し、起動時の `parseConfig` とマップエディタAPIの両方から使う:
- `validateConfig(config: unknown): { success: true; config: ServerConfig } | { success: false; issues: ConfigValidationIssue[] }` — discriminated union で返す。Zod safeParse → 論理バリデーションを順に実行し、Zodエラーも `ConfigValidationIssue[]` に正規化（bracket記法）。設定層の型 `ConfigValidationIssue` を正本とし、API レスポンスにもそのまま使う
- 既存の `parseConfig` は残す。内部で `validateConfig` を呼び、失敗時は `ConfigValidationError` を throw する（Zodエラーも `ConfigValidationError` に統一し、既存テストとの互換性を維持）
- `loadConfigFromFile(configPath): Promise<ServerConfig>` — 既存 `loadConfig` のリネーム/整理。呼び出し元の `src/index.ts` も合わせて更新
- `saveConfigToFile(configPath, config): Promise<void>` — YAML変換 → 一時ファイル → rename

### Step 2-3: 既存フィクスチャの更新

バリデーション強化により既存データが新制約に引っかかる可能性がある。以下を確認・更新:
- `config/example.yaml`
- `test/helpers/test-map.ts`

### Step 2-4: テスト

- `test/unit/config/validation.test.ts` にStep 2-1の追加分のテストを作成
- `validateConfig` / `saveConfigToFile` / `loadConfigFromFile` の unit テストも作成（既存の `agent-storage.test.ts` と同様のパターン）
- `parseConfig` の既存テストが Zod エラー統一後も通ることを確認・必要に応じて更新
- `validateConfig` に型不正な入力を渡した場合の Zod エラー正規化テストを追加
- `test/integration/startup.test.ts` が `loadConfigFromFile` リネーム後も通ることを確認

## Phase 3: マップエディタ管理API

12-map-editor.md §1 の3エンドポイントを実装する。

### 変更・新規ファイル

- `src/types/api.ts`: `ApiErrorCode` に `validation_error` を追加、`ConfigResponse` / `ConfigUpdateRequest` / `ConfigValidateResponse` の型を追加（PUT成功は既存の `OkResponse` を再利用、validate成功は `{ valid: true }` の専用型）
  - `ConfigValidationIssue` は `src/config/validation.ts` に残し正本とする。`src/types/api.ts` から `src/config/validation.ts` を import して API レスポンスの `details` に使う。`invalid_config` は起動時内部用として残し、管理API用に `validation_error` を追加
- 新規 `src/api/routes/admin-config.ts`: `registerAdminConfigRoutes(app, { adminKey, configPath })`
  - 既存 `admin.ts` パターンに倣い `adminAuth` + `validateBody` を使用
  - `validateBody` は `{ config: unknown }` の envelope 検証のみ。設定内容の検証は `validateConfig` で行う
  - バリデーション失敗は `WorldError` を throw し、既存の `onError` で 400 に変換する（既存パターンに合わせる）
  - GET は毎回 `configPath` からファイルを読む（`engine.config` は使わない）。PUT 後の GET もファイル内容を返す
- `src/api/app.ts`: `AppOptions` に `configPath` 追加、`registerAdminConfigRoutes` をimport・呼び出し
- `src/index.ts`: `createApp` に `configPath` を渡す

### テスト波及

`AppOptions` 変更により、`createApp` を直接呼んでいる以下のテストに `configPath` 追加が必要:
- `test/integration/api.test.ts`
- `test/integration/websocket.test.ts`
- `test/integration/movement.test.ts`

※ 他のテストは `test/helpers/test-world.ts` 経由で `WorldEngine` を直接組み立てており、`createApp` を呼んでいないため波及しない。

新規 `test/integration/admin-config.test.ts` を作成（テスト用一時YAMLファイルを使用）。

## Phase 4: 静的ファイル配信

12-map-editor.md §3, §5 に基づく。

### 変更・新規ファイル

- `src/admin/editor/` に `index.html`, `editor.js`, `editor.css` を配置（§5.1準拠）
- `package.json`: `build` スクリプトにアセットコピーを追加（Node.jsスクリプトで実装し、OS依存を避ける）。また `start` スクリプトを `dist/index.js` → `dist/src/index.js` に修正（既存のビルド出力先と不一致のため）
- 新規 `scripts/copy-assets.mjs`: `src/admin/` → `dist/src/admin/` へコピー（`dist/` の `rootDir: "."` 構成に合わせる）
- 新規 `src/api/routes/admin-editor.ts`: `registerAdminEditorRoutes(app)`
  - ファイル名のホワイトリスト方式でpath traversal対策
- `src/api/app.ts`: `registerAdminEditorRoutes` をimport・呼び出し

### テスト

新規 `test/integration/admin-editor.test.ts`（正常系 + ホワイトリスト外404 + encoded traversal拒否）。
`npm run build` 後に `dist/src/admin/editor/` からの配信が正常に動作することも手動確認する。

## Phase 5: マップエディタWeb UI実装

12-map-editor.md §3 に基づき、`src/admin/editor/` の HTML/CSS/JS を実装する。

素の HTML/CSS/JS で実装する（bundler/framework は導入しない）。

- `index.html`: レイアウト + 管理キー入力ダイアログ
- `editor.js`: API通信、状態管理、Canvas描画、入力処理、プロパティパネル、建物/NPC/イベント管理
- `editor.css`: スタイル

## 依存関係

```
Phase 1 (認証) ──────────────────────────────┐
                                              │
Phase 2 (バリデーション) → Phase 3 (管理API) ─┼→ Phase 4 (配信) → Phase 5 (Web UI)
                                              │
                                              │  ※Phase 1 は Phase 5 の依存ではない
                                              │  （Web UIは /api/admin/config のみ使用）
```

Phase 1 と Phase 2 は並行実施可能。

## 注意点

- WebSocket認証: Honoの `upgradeWebSocket` 前に `adminAuth` を挟む。handshake時の401拒否を統合テストで担保する（`ws` ライブラリの `unexpected-response` イベントで検証）
- 静的ファイルのパス解決: `import.meta.url` 基準で dev(`tsx`) / prod(`node dist/`) の両方で動くようにする
- アトミック書き込み: 一時ファイル → `rename`。同一ファイルシステム前提
- 設定反映: YAML更新のみ。ワールドエンジンへの反映はサーバー再起動が必要
