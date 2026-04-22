# 17 - UI 実装フェーズ

## 1. 現在の正本

Issue #60 の current-state UI は、**event-driven な snapshot / history publish → R2/CDN 配信 → browser polling** を正本とする。quiet period の再同期は fallback/readiness 用の **3 分 fallback resync** のみを保険として残す。legacy relay `/ws` はすでに削除済みで、Phase 8 では互換 endpoint や `410 Gone` 移行窓は前提にしない。

## 2. フェーズ定義

### 2.1 Phase 1: Backend publish path 導入

対象:

- 可視ステート変化イベント起点の snapshot publish
- エージェント単位の recent history publish
- publish trigger の型網羅性

完了条件:

- 可視ステート変化時だけ snapshot / history が更新される
- backend が Worker publish API を直接叩ける

### 2.2 Phase 2: R2 primary current-state 確立

対象:

- R2 alias (`snapshot/latest.json`) + `history/*` の event-driven publish
- browser 側 polling の正本化（snapshot と history を同じ 5 秒周期で R2 直接 fetch）
- history 404 / degraded 時の UI 挙動整合

完了条件:

- current-state UI は published snapshot だけで破綻なく描画できる
- history miss / degraded が UI で扱える

### 2.3 Phase 3: Publish health 可視化

対象:

- publish failure / retry / fallback refresh の可視化
- `last_publish_error_at` など遅延診断の UI 反映
- `/health` と snapshot runtime metadata の整備

完了条件:

- publish 失敗時も前回描画を維持したまま再試行できる
- production readiness を `/ws` uptime ではなく publish 成功率と freshness 証跡で判断できる

### 2.4 Phase 4: 配備 / 認証 hardening

対象:

- `AUTH_MODE=public` / `access` の配備検証
- R2 custom domain / Cache Rules / CORS の運用手順
- browser polling と CDN キャッシュ整合

完了条件:

- 選択した認証モードで配備手順が確立している
- Pages / R2 の直 fetch 前提が運用手順に落ちている

### 2.5 Phase 5: UI shell / detail UX 安定化

対象:

- デスクトップ / モバイルの shell 固定
- overlay / detail / history append pagination
- stale banner と publish-health metadata の接続

完了条件:

- デスクトップ / モバイルで同じ snapshot を解釈できる
- stale になっても直前の描画を維持できる

### 2.6 Phase 6: Legacy relay `/ws` と D1 の撤去

対象:

- `/ws` 関連コードとテストの削除
- D1 前提の撤去
- startup 時の `/ws` migration notice 廃止

完了条件:

- `/ws` は存在せず、post-removal 挙動は 404 で統一される
- current-state / history 配信は relay `/ws` や D1 へ依存しない

> 注: 以前検討していた `410 Gone` 互換 endpoint は採用しない。Issue #60 の Phase 8 時点では、移行先告知は文書と release note で完了しており、runtime 互換 endpoint は持たない。

### 2.7 Phase 7: 演出の段階投入

対象:

- 天気エフェクト
- 昼夜表現
- 移動補間
- アクション演出

完了条件:

- UI 演出を feature flag で段階投入できる
- current-state の鮮度契約を壊さず additive に載せられる

### 2.8 Phase 8: 定常運用

対象:

- event-driven publish を唯一の primary path として扱う
- quiet period は 3 分 fallback resync だけを保険として残す
- readiness / alerting / docs を post-`/ws` 状態へ揃える

完了条件:

- current-state UI の primary path は **R2 alias (`snapshot/latest.json`) + `history/*` の browser 直接 polling** で固定
- `/ws` 互換窓を前提にした設計・運用記述が残っていない
- stale / 遅延診断は publish health 指標で判断する

## 3. フェーズ間の制約

- current-state 配信は常に R2 カスタムドメイン上の publish 済み snapshot を browser から直接 fetch する
- fallback 用の周期 refresh を残す場合も primary contract と見なさない
- legacy relay `/ws` は削除済みであり、互換 endpoint の追加を前提にしない
- stale / 遅延診断は quiet period 中の `generated_at` 強制更新ではなく publish health 指標で判断する
- 演出は freshness / publish 契約から独立した additive feature flag として投入する

## 4. 検証項目

### 4.1 バックエンド

- 可視ステート変化イベントで snapshot publish が走ること
- history publish がエージェント単位で更新されること
- fallback resync が発動した場合に log / health 指標へ記録されること
- publish retry/backoff が outage 中の追加イベントで短絡しないこと
- R2 カスタムドメイン配信と browser polling が `/ws` 非依存で成立すること
- `AUTH_MODE=access` では Pages と R2 の両 origin で direct fetch 用の Access セッションが事前成立していること

### 4.2 フロントエンド

- デスクトップ / モバイルで同じ snapshot を解釈できること
- モバイルで上部バッジとボトムシート detail が同時成立すること
- stale / 遅延バナーが publish health 指標に基づいて表示できること
- stale になっても直前の描画を維持すること
- エージェント選択で overlay / detail と履歴表示が成立すること
- snapshot poll 成功時に選択中 agent / 展開中 conversation の history が自動再取得されること

## 5. 将来拡張の扱い

以下は primary path の外に出さず、将来拡張または additive option として温存する。

- UI 向け WebSocket 直接配信
- 連合サーバーナビゲーション
- 会話ログのタイムライン再生
- UI 独自エージェントアイコン設定（画像 URL / 絵文字）と、それを `SpectatorSnapshot` へ後方互換的に通す契約拡張
