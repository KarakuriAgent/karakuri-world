# Unit 12 - UI アプリケーションシェル初期構築
- 参照: docs/design/detailed/15-ui-application-shell.md §1, §2, §4.1, §11, docs/design/detailed/17-ui-rollout.md §1.1
- 目的: 別リポジトリ karakuri-world-ui 前提の SPA 基盤を立ち上げ、/ 単一観戦ビューの骨格と、配備時に必要なビルド env 契約を用意する。
- 実装対象: React + Vite + Tailwind + Pixi 依存関係、単一ルート、sidebar / map / overlay の骨組み、Pages 配備を見据えた build 設定、配備時注入の Vite env 変数命名と読込ヘルパーを確定する（`VITE_SNAPSHOT_URL`: R2 カスタムドメイン + `SNAPSHOT_OBJECT_KEY` の絶対 URL、`VITE_AUTH_MODE`: `public` | `access`、`VITE_API_BASE_URL`: Worker の `/api/history` ベース URL）。未注入時はビルド失敗または起動時 fatal として扱い、proxy fallback は持たない。
- 完了条件: 画面責務 3 領域を持つ最小アプリがローカルで起動し、以後の機能追加先が固定され、`VITE_SNAPSHOT_URL` / `VITE_AUTH_MODE` / `VITE_API_BASE_URL` が `import.meta.env` から型付きで読める `env` モジュールが用意され、未定義時に起動を阻止できる。
- 依存: Unit 01。
- 検証: build smoke test、ルート描画テスト、mock / fixture snapshot 契約でのレスポンシブ shell の存在確認、env 未注入時にビルド失敗または起動時エラーになる test。
- 非対象: 実データ polling、モバイルシート、マップ操作、Access セッション成立手順。
