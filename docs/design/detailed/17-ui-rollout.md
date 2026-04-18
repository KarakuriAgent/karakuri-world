# 17 - UI 実装フェーズ

## 1. フェーズ定義

Units 01〜28 では relay-first の探索を行ったが、以後の delivery クリティカルパスは **polling + R2/CDN primary** へ寄せる。残タスクは Unit 29 以降で管理し、relay `/ws` は additive な補助経路として扱う。

### 1.1 Phase 1: 観戦 MVP（primary path）

対象:

- fixed-cadence publisher による `/api/snapshot` polling
- `SpectatorSnapshot` 生成と R2 カスタムドメイン配信
- D1 永続化と `/api/history` の empty/degraded 整合
- UI の 5 秒 polling
- stale 表示
- デスクトップのサイドバー + マップ + エージェント詳細オーバーレイ
- モバイルのフルスクリーンマップ + 上部バッジ + ボトムシート（detail 含む）
- エージェント選択
- 履歴 UI の empty/degraded state
- （ingest/backfill がある環境のみ）直近履歴表示と会話ログ展開の追加比較

完了条件:

- 100 エージェント規模で最新状態を 15 秒以内に反映できる
- デスクトップ / モバイルの初期レイアウトが overview 通り成立する
- 任意のエージェントを選択して current-state detail を矛盾なく表示でき、`/api/history` が empty/degraded でも UI が破綻しない
- quiet period でも fixed-cadence publisher により `generated_at` が継続更新され、stale が出続けない
- ingest/backfill がある環境では、直近 20 件の履歴閲覧と会話履歴展開を追加比較項目として確認する

### 1.2 Phase 2: 配備 / 認証 / readiness hardening

対象:

- `AUTH_MODE=public` / `access` の配備検証
- R2 custom domain / Cache Rules / CORS の運用手順
- history failure / retry UX 調整
- publish failure / generated age / published age を中心にした readiness gate
- 必要に応じた history ingest 補助経路の整理

完了条件:

- 選択した認証モードで配備手順が確立している
- CDN / R2 / publisher / UI polling の更新間隔と stale 判定が整合している
- 取得失敗時も前回描画を維持したまま再試行できる
- production readiness を relay `/ws` uptime ではなく polling/R2 freshness 証跡で判断できる

### 1.3 Phase 3: 演出強化

対象:

- 天気エフェクト
- 昼夜表現
- 移動補間
- アクション演出

完了条件:

- Phase 1/2 を壊さずに `EffectLayer` を段階投入できる

## 2. フェーズ間の制約

- Phase 1 / Phase 2 の成立条件を always-on `/ws` relay に依存させない
- snapshot は常に R2 カスタムドメインの `snapshot_url` を browser から直接 fetch し、Worker/Pages snapshot proxy fallback は追加しない
- Phase 2 の ETag / 条件付き取得は、304 応答時の body 再利用・`last_success_at` 更新・stale 再評価を詳細設計へ明記するまで有効化しない。Phase 1 は 200 + body の polling を維持する
- optional relay `/ws` を残す場合も、無効化・切断時に freshness SLO と current-state UI が壊れないことを先に保証する
- Phase 3 の演出はすべて feature flag で切り替え可能にする

## 3. 検証項目

### 3.1 バックエンド

- publisher が `/api/snapshot` を 5 秒 cadence で再取得し、quiet period でも `generated_at` を進め続けること
- `SNAPSHOT_OBJECT_KEY` で指定した snapshot object が 5 秒 cadence で更新されること（既定値: `snapshot/latest.json`）
- R2 カスタムドメインに Cache Rules（`Cache Everything` + Edge TTL 5 秒）が反映され、JSON がエッジキャッシュされること
- `AUTH_MODE=access` では、Pages と R2 の両 origin で direct fetch 用の Access セッションが事前成立していること。満たせない配備を same-origin proxy へ逃がさないこと
- D1 にサニタイズ済みイベントのみが保存されること
- relay `/ws` を有効化する配備では、切断しても primary publisher path が継続すること

### 3.2 フロントエンド

- デスクトップ / モバイルで同じ snapshot を解釈できること
- モバイルで上部バッジとボトムシート detail が同時成立すること
- publisher 5 秒 + CDN 5 秒 + client poll 5 秒の正常系（合計 15 秒）では stale にならず、60 秒超過時のみ stale へ遷移すること
- stale になっても直前の描画を維持すること
- 1 ノード複数エージェント時にグループ表示されること
- エージェント選択で overlay / detail と履歴表示が成立すること
- 「さらに読み込む」で `next_cursor` を使った append pagination が成立すること
- モバイルで detail を閉じた際に `selected_agent_id` も解除され、detail へ即時戻らないこと

## 4. 将来拡張の扱い

以下は primary path の外に出さず、将来拡張または additive option として温存する。

- relay `/ws` による publish nudge / history 補助
- UI 向け WebSocket 直接配信
- 連合サーバーナビゲーション
- 会話ログのタイムライン再生
- UI 独自エージェントアイコン設定（画像 URL / 絵文字）と、それを `SpectatorSnapshot` へ後方互換的に通す契約拡張
