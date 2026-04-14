# 17 - UI 実装フェーズ

## 1. フェーズ定義

### 1.1 Phase 1: 観戦 MVP

対象:

- DO での `/ws` 接続
- `SpectatorSnapshot` 生成と R2 配信
- D1 永続化と `/api/history`
- UI の 5 秒 polling
- stale 表示
- デスクトップのサイドバー + マップ + エージェント詳細オーバーレイ
- モバイルのフルスクリーンマップ + 上部バッジ + ボトムシート（detail 含む）
- エージェント選択
- 直近履歴表示
- 会話ログの展開

完了条件:

- 100 エージェント規模で最新状態を 15 秒以内に反映できる
- デスクトップ / モバイルの初期レイアウトが overview 通り成立する
- 任意のエージェントを選択して直近 20 件の履歴を閲覧でき、会話履歴を展開できる
- quiet period でも heartbeat refresh により `generated_at` が継続更新され、stale が出続けない

### 1.2 Phase 2: 運用最適化

対象:

- `AUTH_MODE=public` / `access` の配備検証
- ETag / 条件付き取得（304 セマンティクス定義を含む）、キャッシュチューニング
- reconnect / stale / history failure の監視と再試行 UX 調整

完了条件:

- 選択した認証モードで配備手順が確立している
- CDN / R2 / DO の更新間隔と stale 判定が整合している
- 取得失敗時も前回描画を維持しつつ再試行できる

### 1.3 Phase 3: 演出強化

対象:

- 天気エフェクト
- 昼夜表現
- 移動補間
- アクション演出

完了条件:

- Phase 1/2 を壊さずに `EffectLayer` を段階投入できる

## 2. フェーズ間の制約

- Phase 1 完了前に WebSocket fan-out は追加しない
- Phase 2 の ETag / 条件付き取得は、304 応答時の body 再利用・`last_success_at` 更新・fetch error からの ready 回復・stale 再評価を詳細設計へ明記するまで有効化しない。Phase 1 は 200 + body の polling を維持する
- Phase 2 完了前に会話ログのタイムライン再生 UI へ着手しない
- Phase 3 の演出はすべて feature flag で切り替え可能にする

## 3. 検証項目

### 3.1 バックエンド

- `/ws` 切断後に自動再接続し、その間も heartbeat alarm が維持されて `/api/snapshot` 到達時は `generated_at` 更新が継続すること
- `SNAPSHOT_OBJECT_KEY` で指定した snapshot object が 5 秒 throttle で更新されること（既定値: `snapshot/latest.json`）
- quiet period でも heartbeat refresh により `/api/snapshot` を再取得し、`generated_at` が更新され続けること
- R2 カスタムドメインに Cache Rules（`Cache Everything` + Edge TTL 5 秒）が反映され、JSON がエッジキャッシュされること
- `AUTH_MODE=access` では、Pages と R2 の両 origin で direct fetch 用の Access セッションが事前成立していること。満たせない配備を same-origin proxy へ逃がさないこと
- D1 にサニタイズ済みイベントのみが保存されること

### 3.2 フロントエンド

- デスクトップ / モバイルで同じ snapshot を解釈できること
- モバイルで上部バッジとボトムシート detail が同時成立すること
- heartbeat 30 秒 + publish/CDN/poll 各 5 秒の正常系（合計 45 秒）では stale にならず、60 秒超過時のみ stale へ遷移すること
- stale になっても直前の描画を維持すること
- 1 ノード複数エージェント時にグループ表示されること
- エージェント選択で overlay / detail と履歴表示が成立すること
- 「さらに読み込む」で `next_cursor` を使った append pagination が成立すること
- モバイルで detail を閉じた際に `selected_agent_id` も解除され、detail へ即時戻らないこと

## 4. 将来拡張の扱い

以下は本設計の外に出さず、将来拡張として温存する。

- UI 向け WebSocket 直接配信
- 連合サーバーナビゲーション
- 会話ログのタイムライン再生
- UI 独自エージェントアイコン設定（画像 URL / 絵文字）と、それを `SpectatorSnapshot` へ後方互換的に通す契約拡張
